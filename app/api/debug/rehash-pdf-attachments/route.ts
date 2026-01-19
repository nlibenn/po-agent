import { NextRequest, NextResponse } from 'next/server'
import { getDb, hasColumn } from '@/src/lib/supplier-agent/storage/sqlite'
import { decodeBase64UrlToBuffer } from '@/src/lib/supplier-agent/store'
import { createHash } from 'crypto'

export const runtime = 'nodejs'

/**
 * Update all references from oldAttachmentId to newAttachmentId.
 * Updates references in cases.meta, confirmation_records, confirmation_extractions, and events.
 */
function updateAttachmentReferences(db: any, oldId: string, newId: string): void {
  // Update cases.meta (parsed_best_fields_v1.evidence_attachment_id)
  const casesWithRef = db.prepare(`
    SELECT case_id, meta FROM cases
    WHERE meta LIKE ?
  `).all(`%${oldId}%`) as Array<{ case_id: string; meta: string }>
  
  for (const caseRow of casesWithRef) {
    try {
      const meta = JSON.parse(caseRow.meta || '{}')
      let updated = false
      
      // Check parsed_best_fields_v1
      if (meta.parsed_best_fields_v1?.evidence_attachment_id === oldId) {
        meta.parsed_best_fields_v1.evidence_attachment_id = newId
        updated = true
      }
      
      // Check confirmation_fields_applied (nested in fields)
      if (meta.confirmation_fields_applied?.fields) {
        const fields = meta.confirmation_fields_applied.fields
        for (const key in fields) {
          if (fields[key]?.attachment_id === oldId) {
            fields[key].attachment_id = newId
            updated = true
          }
        }
      }
      
      if (updated) {
        db.prepare(`UPDATE cases SET meta = ? WHERE case_id = ?`).run(
          JSON.stringify(meta),
          caseRow.case_id
        )
      }
    } catch (err) {
      console.warn(`[REHASH] failed to update case.meta for case ${caseRow.case_id}:`, err)
    }
  }
  
  // Update confirmation_records.source_attachment_id
  db.prepare(`
    UPDATE confirmation_records
    SET source_attachment_id = ?
    WHERE source_attachment_id = ?
  `).run(newId, oldId)
  
  // Update confirmation_extractions.evidence_attachment_id
  db.prepare(`
    UPDATE confirmation_extractions
    SET evidence_attachment_id = ?
    WHERE evidence_attachment_id = ?
  `).run(newId, oldId)
  
  // Update events.evidence_refs_json (JSON array of attachment_ids)
  const eventsWithRef = db.prepare(`
    SELECT event_id, evidence_refs_json FROM events
    WHERE evidence_refs_json LIKE ?
  `).all(`%${oldId}%`) as Array<{ event_id: string; evidence_refs_json: string | null }>
  
  for (const eventRow of eventsWithRef) {
    try {
      const refs = eventRow.evidence_refs_json ? JSON.parse(eventRow.evidence_refs_json) : {}
      if (Array.isArray(refs.attachment_ids)) {
        const idx = refs.attachment_ids.indexOf(oldId)
        if (idx >= 0) {
          refs.attachment_ids[idx] = newId
          db.prepare(`UPDATE events SET evidence_refs_json = ? WHERE event_id = ?`).run(
            JSON.stringify(refs),
            eventRow.event_id
          )
        }
      }
    } catch (err) {
      console.warn(`[REHASH] failed to update event.evidence_refs_json for event ${eventRow.event_id}:`, err)
    }
  }
}

/**
 * POST /api/debug/rehash-pdf-attachments
 * Dev-only endpoint to rehash all PDF attachments and deduplicate in one pass.
 * 
 * 1. Loads all PDF attachments
 * 2. Computes content_sha256 + size_bytes for each (in-memory)
 * 3. Groups by content_sha256
 * 4. For each group: chooses keeper, updates references, deletes duplicates
 * 5. All in a single transaction
 * 
 * Returns:
 * {
 *   ok: true,
 *   total: number,
 *   groups: number,
 *   removed: number,
 *   keeper_updates: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const db = getDb()
    
    // Check if columns exist
    if (!hasColumn('attachments', 'content_sha256')) {
      return NextResponse.json(
        { error: 'content_sha256 column does not exist' },
        { status: 400 }
      )
    }
    
    // Load all PDF attachments with additional fields for keeper selection
    const pdfs = db.prepare(`
      SELECT 
        attachment_id,
        binary_data_base64,
        content_sha256,
        size_bytes,
        text_extract,
        created_at
      FROM attachments
      WHERE mime_type = 'application/pdf'
    `).all() as Array<{
      attachment_id: string
      binary_data_base64: string | null
      content_sha256: string | null
      size_bytes: number | null
      text_extract: string | null
      created_at: number
    }>
    
    console.log(`[REHASH] start {count: ${pdfs.length}}`)
    
    // Step 1: Compute hashes in-memory and group by hash
    type PdfWithHash = {
      attachment_id: string
      binary_data_base64: string | null
      content_sha256: string | null
      size_bytes: number | null
      text_extract: string | null
      created_at: number
      computed_hash: string | null
      computed_size: number | null
      error: string | null
    }
    
    const pdfsWithHash: PdfWithHash[] = []
    const hashGroups = new Map<string, PdfWithHash[]>()
    
    for (const pdf of pdfs) {
      const pdfWithHash: PdfWithHash = {
        ...pdf,
        computed_hash: null,
        computed_size: null,
        error: null,
      }
      
      // Skip if no binary data
      if (!pdf.binary_data_base64 || pdf.binary_data_base64.length === 0) {
        pdfsWithHash.push(pdfWithHash)
        continue
      }
      
      try {
        // Decode base64url to buffer (handles Gmail's base64url encoding)
        const binaryData = decodeBase64UrlToBuffer(pdf.binary_data_base64)
        
        // Compute hash and size from decoded bytes (not the base64 string)
        const contentHash = createHash('sha256').update(binaryData).digest('hex')
        const sizeBytes = binaryData.length
        
        pdfWithHash.computed_hash = contentHash
        pdfWithHash.computed_size = sizeBytes
        
        // Group by hash
        if (!hashGroups.has(contentHash)) {
          hashGroups.set(contentHash, [])
        }
        hashGroups.get(contentHash)!.push(pdfWithHash)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pdfWithHash.error = msg
        console.error(`[REHASH] error for attachment ${pdf.attachment_id}:`, msg)
      }
      
      pdfsWithHash.push(pdfWithHash)
    }
    
    // Step 2: Process each hash group in a transaction
    const transaction = db.transaction(() => {
      let keeperUpdates = 0
      let totalRemoved = 0
      const groupsProcessed = hashGroups.size
      
      for (const [hash, group] of hashGroups.entries()) {
        if (group.length <= 1) {
          // No duplicates, just update the single row if needed
          const pdf = group[0]
          if (pdf.computed_hash && (pdf.content_sha256 !== pdf.computed_hash || pdf.size_bytes !== pdf.computed_size)) {
            db.prepare(`
              UPDATE attachments
              SET content_sha256 = ?, size_bytes = ?
              WHERE attachment_id = ?
            `).run(pdf.computed_hash, pdf.computed_size, pdf.attachment_id)
            keeperUpdates++
          }
          continue
        }
        
        // Choose keeper: has text_extract > has binary_data_base64 > newest created_at
        group.sort((a, b) => {
          const aHasText = a.text_extract && a.text_extract.length > 0 ? 1 : 0
          const bHasText = b.text_extract && b.text_extract.length > 0 ? 1 : 0
          if (aHasText !== bHasText) return bHasText - aHasText
          
          const aHasBinary = a.binary_data_base64 && a.binary_data_base64.length > 0 ? 1 : 0
          const bHasBinary = b.binary_data_base64 && b.binary_data_base64.length > 0 ? 1 : 0
          if (aHasBinary !== bHasBinary) return bHasBinary - aHasBinary
          
          return b.created_at - a.created_at
        })
        
        const keeper = group[0]
        const nonKeepers = group.slice(1)
        
        // Update keeper with content_sha256 + size_bytes (only if not already set correctly)
        if (keeper.computed_hash && (keeper.content_sha256 !== keeper.computed_hash || keeper.size_bytes !== keeper.computed_size)) {
          try {
            db.prepare(`
              UPDATE attachments
              SET content_sha256 = ?, size_bytes = ?
              WHERE attachment_id = ?
            `).run(keeper.computed_hash, keeper.computed_size, keeper.attachment_id)
            keeperUpdates++
          } catch (err: any) {
            // If unique constraint error, keeper might already have this hash from another group
            if (err.message && err.message.includes('UNIQUE constraint')) {
              console.warn(`[REHASH] constraint error updating keeper ${keeper.attachment_id}, may already have hash`)
            } else {
              throw err
            }
          }
        }
        
        // Update references and delete non-keepers
        for (const nonKeeper of nonKeepers) {
          // Update all references from nonKeeper to keeper
          updateAttachmentReferences(db, nonKeeper.attachment_id, keeper.attachment_id)
          
          // Delete non-keeper row (do NOT set content_sha256 on it, that would violate unique constraint)
          db.prepare(`
            DELETE FROM attachments
            WHERE attachment_id = ?
          `).run(nonKeeper.attachment_id)
          totalRemoved++
        }
      }
      
      return { keeperUpdates, totalRemoved, groupsProcessed }
    })
    
    const result = transaction()
    
    console.log(`[REHASH] done {groups: ${result.groupsProcessed}, removed: ${result.totalRemoved}, keeper_updates: ${result.keeperUpdates}}`)
    
    return NextResponse.json({
      ok: true,
      total: pdfs.length,
      groups: result.groupsProcessed,
      removed: result.totalRemoved,
      keeper_updates: result.keeperUpdates,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to rehash attachments'
    console.error('[REHASH] fatal error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
