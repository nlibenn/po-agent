import { NextRequest, NextResponse } from 'next/server'
import { retrievePdfAttachmentsFromThread } from '@/src/lib/supplier-agent/emailAttachments'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/attachments/retrieve
 * Retrieve PDF attachments from a Gmail thread
 * 
 * Body:
 * {
 *   caseId: string  // Required: case ID to associate attachments with
 *   threadId: string  // Required: Gmail thread ID
 * }
 * 
 * Returns:
 * {
 *   attachments: Array<{
 *     attachment_id: string
 *     message_id: string
 *     thread_id: string
 *     filename: string
 *     mime_type: string
 *     size_bytes: number | null
 *     received_at: number | null
 *     created_at: number
 *   }>
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.caseId) {
      return NextResponse.json(
        { error: 'Missing required field: caseId' },
        { status: 400 }
      )
    }
    
    let { caseId, threadId } = body
    
    // If threadId not provided, try to get from case.meta
    if (caseId && !threadId) {
      const { getCase } = await import('@/src/lib/supplier-agent/store')
      const caseData = getCase(caseId)
      if (caseData) {
        const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
        threadId = meta.thread_id || (caseData as any).thread_id || null
      }
    }
    
    if (!threadId) {
      return NextResponse.json(
        { error: 'Missing required field: threadId (not found in case.meta or request body)' },
        { status: 400 }
      )
    }
    
    console.log(`[PDF_RETRIEVE] start ${threadId}`)
    
    // Retrieve attachments using the existing function
    // This function handles idempotency via addAttachment which uses ON CONFLICT DO UPDATE
    const result = await retrievePdfAttachmentsFromThread({
      caseId,
      threadId,
    })
    
    // Fetch attachment metadata from database to return clean results
    // (This ensures we return what's actually stored, avoiding duplicates)
    const db = getDb()
    
    // Get messages in the thread to find attachment message IDs
    const messageIds = result.attachments.map(a => a.messageId)
    if (messageIds.length === 0) {
      console.log(`[PDF_RETRIEVE] done 0`)
      return NextResponse.json({ attachments: [] })
    }
    
    // Query attachments for these message IDs (include text_extract for status)
    const placeholders = messageIds.map(() => '?').join(',')
    const stmt = db.prepare(`
      SELECT 
        a.attachment_id,
        a.message_id,
        a.gmail_attachment_id,
        m.thread_id,
        a.filename,
        a.mime_type,
        a.text_extract,
        a.created_at,
        m.received_at,
        COALESCE(m.received_at, a.created_at) AS sort_ts,
        COALESCE(m.received_at, a.created_at) AS updated_at
      FROM attachments a
      INNER JOIN messages m ON a.message_id = m.message_id
      WHERE a.message_id IN (${placeholders})
        AND a.mime_type = 'application/pdf'
      ORDER BY sort_ts DESC
    `)
    
    const attachments = stmt.all(...messageIds) as Array<{
      attachment_id: string
      message_id: string
      gmail_attachment_id: string | null
      thread_id: string | null
      filename: string | null
      mime_type: string | null
      text_extract: string | null
      created_at: number
      received_at: number | null
      sort_ts: number
      updated_at: number
    }>
    
    // Calculate size from base64 if available (approximate)
    const attachmentsWithSize = attachments.map(att => {
      // Get size from base64 data (if stored)
      const sizeStmt = db.prepare('SELECT LENGTH(binary_data_base64) as size FROM attachments WHERE attachment_id = ?')
      const sizeRow = sizeStmt.get(att.attachment_id) as { size: number } | undefined
      // Base64 is ~4/3 the size of binary, so approximate binary size
      const sizeBytes = sizeRow?.size ? Math.floor(sizeRow.size * 3 / 4) : null
      
      // Calculate extracted_length from text_extract if available
      const extractedLength = att.text_extract ? att.text_extract.length : 0
      const scannedLike = extractedLength > 0 && extractedLength < 50
      
      return {
        attachment_id: att.attachment_id,
        message_id: att.message_id,
        gmail_attachment_id: att.gmail_attachment_id,
        thread_id: att.thread_id || threadId,
        filename: att.filename || 'unknown.pdf',
        mime_type: att.mime_type || 'application/pdf',
        size_bytes: sizeBytes,
        received_at: att.received_at,
        created_at: att.created_at,
        updated_at: att.updated_at,
        text_extract: att.text_extract,
        extracted_length: extractedLength,
        scanned_like: scannedLike,
      }
    })
    
    const gmailFoundCount = attachmentsWithSize.length
    
    // Get counts from result if available
    const inserted = result.inserted || 0
    const reused = result.reused || 0
    const skipped = result.skipped || 0
    
    console.log(`[PDF_RETRIEVE] done ${gmailFoundCount}`)
    console.log(`[ATTACHMENT_RETRIEVAL] summary {inserted: ${inserted}, reused: ${reused}, skipped: ${skipped}, threadId: ${threadId}, caseId: ${caseId}}`)
    
    return NextResponse.json({
      attachments: attachmentsWithSize,
      inserted,
      reused,
      skipped,
    })
  } catch (error) {
    console.error('[PDF_RETRIEVE] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve attachments' },
      { status: 500 }
    )
  }
}
