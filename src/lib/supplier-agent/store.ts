/**
 * Supplier Chase Agent Data Access Layer
 */

import { getDb, hasColumn } from './storage/sqlite'
import type {
  SupplierChaseCase,
  SupplierChaseCaseUpdate,
  SupplierChaseEvent,
  SupplierChaseEventInput,
  SupplierChaseMessage,
  SupplierChaseMessageInput,
  SupplierChaseAttachment,
  SupplierChaseAttachmentInput,
  SupplierChaseAttachmentCreateInput,
} from './types'

/**
 * Decode base64url-encoded string to Buffer.
 * Handles base64url encoding (Gmail API format) by converting to standard base64.
 * 
 * @param base64url - Base64url-encoded string (may contain - and _ instead of + and /)
 * @returns Buffer of decoded binary data
 */
export function decodeBase64UrlToBuffer(base64url: string): Buffer {
  // Replace base64url characters with standard base64
  const base64Data = base64url.replace(/-/g, '+').replace(/_/g, '/')
  // Add padding if needed (base64 requires length to be multiple of 4)
  const padding = base64Data.length % 4
  const paddedBase64 = base64Data + (padding ? '='.repeat(4 - padding) : '')
  // Decode to binary buffer
  return Buffer.from(paddedBase64, 'base64')
}

/**
 * Initialize the database (creates all tables if needed)
 * 
 * This is a convenience wrapper that ensures initialization.
 * All tables (supplier-agent + gmail_tokens) are created by
 * the shared initialization in storage/sqlite.ts.
 */
export function initDb(): void {
  getDb()
}

/**
 * Create a new case
 */
export function createCase(caseData: SupplierChaseCase): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO cases (
      case_id, po_number, line_id, supplier_name, supplier_email, supplier_domain,
      missing_fields, state, status, touch_count, last_action_at,
      created_at, updated_at, meta
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `)
  
  stmt.run(
    caseData.case_id,
    caseData.po_number,
    caseData.line_id,
    caseData.supplier_name,
    caseData.supplier_email,
    caseData.supplier_domain,
    JSON.stringify(caseData.missing_fields),
    caseData.state,
    caseData.status,
    caseData.touch_count,
    caseData.last_action_at,
    caseData.created_at,
    caseData.updated_at,
    JSON.stringify(caseData.meta)
  )
}

/**
 * Get a case by ID
 */
export function getCase(case_id: string): SupplierChaseCase | null {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM cases WHERE case_id = ?')
  const row = stmt.get(case_id) as any
  
  if (!row) {
    return null
  }
  
  return {
    case_id: row.case_id,
    po_number: row.po_number,
    line_id: row.line_id,
    supplier_name: row.supplier_name,
    supplier_email: row.supplier_email,
    supplier_domain: row.supplier_domain,
    missing_fields: JSON.parse(row.missing_fields || '[]'),
    state: row.state as any,
    status: row.status as any,
    touch_count: row.touch_count,
    last_action_at: row.last_action_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_check_at: row.next_check_at ?? null,
    last_inbox_check_at: row.last_inbox_check_at ?? null,
    meta: JSON.parse(row.meta || '{}'),
  }
}

/**
 * Find a case by PO number and line ID
 */
export function findCaseByPoLine(po_number: string, line_id: string): SupplierChaseCase | null {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM cases WHERE po_number = ? AND line_id = ?')
  const row = stmt.get(po_number, line_id) as any
  
  if (!row) {
    return null
  }
  
  return {
    case_id: row.case_id,
    po_number: row.po_number,
    line_id: row.line_id,
    supplier_name: row.supplier_name,
    supplier_email: row.supplier_email,
    supplier_domain: row.supplier_domain,
    missing_fields: JSON.parse(row.missing_fields || '[]'),
    state: row.state as any,
    status: row.status as any,
    touch_count: row.touch_count,
    last_action_at: row.last_action_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_check_at: row.next_check_at ?? null,
    last_inbox_check_at: row.last_inbox_check_at ?? null,
    meta: JSON.parse(row.meta || '{}'),
  }
}

/**
 * Update a case
 */
export function updateCase(case_id: string, patch: SupplierChaseCaseUpdate): void {
  const db = getDb()
  
  // Build dynamic update query
  const updates: string[] = []
  const values: any[] = []
  
  if (patch.po_number !== undefined) {
    updates.push('po_number = ?')
    values.push(patch.po_number)
  }
  if (patch.line_id !== undefined) {
    updates.push('line_id = ?')
    values.push(patch.line_id)
  }
  if (patch.supplier_name !== undefined) {
    updates.push('supplier_name = ?')
    values.push(patch.supplier_name)
  }
  if (patch.supplier_email !== undefined) {
    updates.push('supplier_email = ?')
    values.push(patch.supplier_email)
  }
  if (patch.supplier_domain !== undefined) {
    updates.push('supplier_domain = ?')
    values.push(patch.supplier_domain)
  }
  if (patch.missing_fields !== undefined) {
    updates.push('missing_fields = ?')
    values.push(JSON.stringify(patch.missing_fields))
  }
  if (patch.state !== undefined) {
    updates.push('state = ?')
    values.push(patch.state)
  }
  if (patch.status !== undefined) {
    updates.push('status = ?')
    values.push(patch.status)
  }
  if (patch.touch_count !== undefined) {
    updates.push('touch_count = ?')
    values.push(patch.touch_count)
  }
  if (patch.last_action_at !== undefined) {
    updates.push('last_action_at = ?')
    values.push(patch.last_action_at)
  }
  if (patch.updated_at !== undefined) {
    updates.push('updated_at = ?')
    values.push(patch.updated_at)
  }
  if (patch.next_check_at !== undefined) {
    updates.push('next_check_at = ?')
    values.push(patch.next_check_at)
  }
  if (patch.last_inbox_check_at !== undefined) {
    updates.push('last_inbox_check_at = ?')
    values.push(patch.last_inbox_check_at)
  }
  if (patch.meta !== undefined) {
    updates.push('meta = ?')
    values.push(JSON.stringify(patch.meta))
  }
  
  // Always update updated_at if not explicitly set
  if (patch.updated_at === undefined) {
    updates.push('updated_at = ?')
    values.push(Date.now())
  }
  
  if (updates.length === 0) {
    return // No updates
  }
  
  values.push(case_id)
  const stmt = db.prepare(`UPDATE cases SET ${updates.join(', ')} WHERE case_id = ?`)
  stmt.run(...values)
}

/**
 * Add an event to a case (idempotent)
 * 
 * Prevents duplicate events by checking if an identical event was logged recently
 * (within 5 seconds with same case_id, event_type, and summary).
 */
export function addEvent(case_id: string, event: SupplierChaseEventInput): void {
  const db = getDb()
  
  // Check for duplicate event (same case_id, event_type, summary within 5 seconds)
  const duplicateWindow = 5000 // 5 seconds
  const duplicateCheck = db.prepare(`
    SELECT event_id FROM events 
    WHERE case_id = ? 
      AND event_type = ? 
      AND summary = ?
      AND ABS(timestamp - ?) < ?
    LIMIT 1
  `).get(
    case_id,
    event.event_type,
    event.summary,
    event.timestamp,
    duplicateWindow
  ) as { event_id: string } | undefined
  
  if (duplicateCheck) {
    // Event already logged recently, skip
    return
  }
  
  const event_id = `${Date.now()}-${Math.random().toString(36).substring(7)}`
  
  const stmt = db.prepare(`
    INSERT INTO events (
      event_id, case_id, timestamp, event_type, summary,
      evidence_refs_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    event_id,
    case_id,
    event.timestamp,
    event.event_type,
    event.summary,
    event.evidence_refs_json ? JSON.stringify(event.evidence_refs_json) : null,
    event.meta_json ? JSON.stringify(event.meta_json) : null
  )
}

/**
 * List events for a case (ordered by timestamp, oldest first)
 */
export function listEvents(case_id: string): SupplierChaseEvent[] {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY timestamp ASC')
  const rows = stmt.all(case_id) as any[]
  
  return rows.map((row) => ({
    event_id: row.event_id,
    case_id: row.case_id,
    timestamp: row.timestamp,
    event_type: row.event_type as any,
    summary: row.summary,
    evidence_refs_json: row.evidence_refs_json ? JSON.parse(row.evidence_refs_json) : null,
    meta_json: row.meta_json ? JSON.parse(row.meta_json) : null,
  }))
}

/**
 * List recent events for a case (ordered by timestamp, newest first)
 */
export function listRecentEvents(case_id: string, limit = 25): SupplierChaseEvent[] {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY timestamp DESC LIMIT ?')
  const rows = stmt.all(case_id, limit) as any[]
  
  return rows.map((row) => ({
    event_id: row.event_id,
    case_id: row.case_id,
    timestamp: row.timestamp,
    event_type: row.event_type as any,
    summary: row.summary,
    evidence_refs_json: row.evidence_refs_json ? JSON.parse(row.evidence_refs_json) : null,
    meta_json: row.meta_json ? JSON.parse(row.meta_json) : null,
  }))
}

/**
 * Add a message to a case (idempotent)
 * 
 * If message.message_id is provided, it will be used (e.g., Gmail message ID).
 * Otherwise, a UUID will be generated.
 * 
 * Uses UPSERT to handle duplicate message_ids gracefully.
 */
export function addMessage(case_id: string, message: SupplierChaseMessageInput & { message_id?: string }): SupplierChaseMessage {
  const db = getDb()
  const message_id = message.message_id || `${Date.now()}-${Math.random().toString(36).substring(7)}`
  const created_at = Date.now()
  
  // Check if message already exists to preserve original created_at
  const existing = db.prepare('SELECT created_at FROM messages WHERE message_id = ?').get(message_id) as { created_at: number } | undefined
  const final_created_at = existing?.created_at || created_at
  
  const stmt = db.prepare(`
    INSERT INTO messages (
      message_id, case_id, direction, thread_id, from_email, to_email,
      cc, subject, body_text, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      case_id = excluded.case_id,
      direction = excluded.direction,
      thread_id = excluded.thread_id,
      from_email = excluded.from_email,
      to_email = excluded.to_email,
      cc = excluded.cc,
      subject = excluded.subject,
      body_text = excluded.body_text,
      received_at = excluded.received_at
  `)
  
  stmt.run(
    message_id,
    case_id,
    message.direction,
    message.thread_id,
    message.from_email,
    message.to_email,
    message.cc,
    message.subject,
    message.body_text,
    message.received_at,
    final_created_at
  )
  
  return {
    message_id,
    case_id,
    direction: message.direction,
    thread_id: message.thread_id,
    from_email: message.from_email,
    to_email: message.to_email,
    cc: message.cc,
    subject: message.subject,
    body_text: message.body_text,
    received_at: message.received_at,
    created_at: final_created_at,
  }
}

/**
 * List messages for a case (ordered by created_at, oldest first)
 */
export function listMessages(case_id: string): SupplierChaseMessage[] {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at ASC')
  const rows = stmt.all(case_id) as any[]
  
  return rows.map((row) => ({
    message_id: row.message_id,
    case_id: row.case_id,
    direction: row.direction as any,
    thread_id: row.thread_id,
    from_email: row.from_email,
    to_email: row.to_email,
    cc: row.cc,
    subject: row.subject,
    body_text: row.body_text,
    received_at: row.received_at,
    created_at: row.created_at,
  }))
}

/**
 * Add an attachment to a message (idempotent)
 * 
 * PRIMARY IDENTITY: content_sha256 (if provided)
 * - If content_sha256 is provided, first checks for existing attachment by hash
 * - If found, UPDATEs existing row with any missing fields (never inserts duplicate)
 * - If not found, inserts new row INCLUDING content_sha256 and size_bytes
 * - Ensures we never insert a PDF row with NULL content_sha256 if binary_data_base64 is present
 * 
 * If attachment.attachment_id is provided (e.g., Gmail attachment ID), it will be used.
 */
export function addAttachment(message_id: string, attachment: SupplierChaseAttachmentCreateInput & { content_sha256?: string | null; size_bytes?: number | null }): SupplierChaseAttachment {
  const db = getDb()
  const attachment_id = attachment.attachment_id || `${Date.now()}-${Math.random().toString(36).substring(7)}`
  const created_at = Date.now()
  
  // Merge message_id into attachment object for database insertion
  const attachmentWithMessageId: SupplierChaseAttachmentInput & { content_sha256?: string | null; size_bytes?: number | null } = {
    ...attachment,
    message_id,
  }
  
  // PRIMARY IDENTITY: content_sha256 (if provided)
  const hasContentSha256 = hasColumn('attachments', 'content_sha256')
  if (hasContentSha256 && attachment.content_sha256) {
    // Check for existing attachment by content_sha256 (global deduplication)
    const existing = db.prepare(`
      SELECT attachment_id, message_id, filename, mime_type, gmail_attachment_id,
             binary_data_base64, content_sha256, size_bytes, text_extract, parsed_fields_json, parse_confidence_json, created_at
      FROM attachments
      WHERE content_sha256 = ?
      LIMIT 1
    `).get(attachment.content_sha256) as {
      attachment_id: string
      message_id: string
      filename: string | null
      mime_type: string | null
      gmail_attachment_id: string | null
      binary_data_base64: string | null
      content_sha256: string | null
      size_bytes: number | null
      text_extract: string | null
      parsed_fields_json: string | null
      parse_confidence_json: string | null
      created_at: number
    } | undefined
    
    if (existing) {
      // Existing attachment with same content hash found - UPDATE existing row (do NOT insert)
      const updates: string[] = []
      const values: any[] = []
      
      // Update missing fields (use COALESCE to only update if existing is null and new value is present)
      if (!existing.binary_data_base64 && attachmentWithMessageId.binary_data_base64) {
        updates.push('binary_data_base64 = ?')
        values.push(attachmentWithMessageId.binary_data_base64)
      }
      
      if (!existing.text_extract && attachmentWithMessageId.text_extract) {
        updates.push('text_extract = ?')
        values.push(attachmentWithMessageId.text_extract)
      }
      
      if (existing.size_bytes === null && attachment.size_bytes !== null && attachment.size_bytes !== undefined) {
        updates.push('size_bytes = ?')
        values.push(attachment.size_bytes)
      }
      
      // Always update message_id, filename, mime_type, gmail_attachment_id if provided (may be from different message)
      if (attachmentWithMessageId.filename) {
        updates.push('filename = COALESCE(?, filename)')
        values.push(attachmentWithMessageId.filename)
      }
      if (attachmentWithMessageId.mime_type) {
        updates.push('mime_type = COALESCE(?, mime_type)')
        values.push(attachmentWithMessageId.mime_type)
      }
      if (attachmentWithMessageId.gmail_attachment_id) {
        updates.push('gmail_attachment_id = COALESCE(?, gmail_attachment_id)')
        values.push(attachmentWithMessageId.gmail_attachment_id)
      }
      
      if (updates.length > 0) {
        values.push(existing.attachment_id)
        db.prepare(`
          UPDATE attachments
          SET ${updates.join(', ')}
          WHERE attachment_id = ?
        `).run(...values)
      }
      
      // Return existing attachment (reused, not duplicated)
      return {
        attachment_id: existing.attachment_id,
        message_id: existing.message_id,
        filename: existing.filename,
        mime_type: existing.mime_type,
        gmail_attachment_id: existing.gmail_attachment_id,
        binary_data_base64: existing.binary_data_base64 || attachmentWithMessageId.binary_data_base64 || null,
        text_extract: existing.text_extract || attachmentWithMessageId.text_extract || null,
        parsed_fields_json: existing.parsed_fields_json ? JSON.parse(existing.parsed_fields_json) : null,
        parse_confidence_json: existing.parse_confidence_json ? JSON.parse(existing.parse_confidence_json) : null,
        created_at: existing.created_at,
      }
    }
  }
  
  // No existing attachment found by content_sha256 - insert new row
  // Ensure we never insert a PDF row with NULL content_sha256 if binary_data_base64 is present
  const hasSizeBytes = hasColumn('attachments', 'size_bytes')
  const isPdf = attachmentWithMessageId.mime_type === 'application/pdf'
  const hasBinary = attachmentWithMessageId.binary_data_base64 && attachmentWithMessageId.binary_data_base64.length > 0
  
  if (isPdf && hasBinary && (!hasContentSha256 || !attachment.content_sha256)) {
    // This should never happen if emailAttachments.ts is working correctly
    console.warn(`[ATTACHMENT] WARNING: Attempting to insert PDF with binary_data_base64 but no content_sha256. Computing hash now.`)
    if (hasContentSha256) {
      const { decodeBase64UrlToBuffer } = require('./store')
      const binaryData = decodeBase64UrlToBuffer(attachmentWithMessageId.binary_data_base64!)
      const computedHash = require('crypto').createHash('sha256').update(binaryData).digest('hex')
      const computedSize = binaryData.length
      attachment.content_sha256 = computedHash
      attachment.size_bytes = computedSize
    }
  }
  
  // Build INSERT statement with conditional columns
  const columns = [
    'attachment_id', 'message_id', 'filename', 'mime_type', 'gmail_attachment_id',
    'binary_data_base64'
  ]
  const values: any[] = [
    attachment_id,
    message_id,
    attachmentWithMessageId.filename,
    attachmentWithMessageId.mime_type,
    attachmentWithMessageId.gmail_attachment_id,
    attachmentWithMessageId.binary_data_base64 || null
  ]
  
  if (hasContentSha256) {
    columns.push('content_sha256')
    values.push(attachment.content_sha256 || null)
  }
  
  if (hasSizeBytes) {
    columns.push('size_bytes')
    values.push(attachment.size_bytes !== undefined && attachment.size_bytes !== null ? attachment.size_bytes : null)
  }
  
  columns.push('text_extract', 'parsed_fields_json', 'parse_confidence_json', 'created_at')
  values.push(
    attachmentWithMessageId.text_extract,
    attachmentWithMessageId.parsed_fields_json ? JSON.stringify(attachmentWithMessageId.parsed_fields_json) : null,
    attachmentWithMessageId.parse_confidence_json ? JSON.stringify(attachmentWithMessageId.parse_confidence_json) : null,
    created_at
  )
  
  const placeholders = values.map(() => '?').join(', ')
  db.prepare(`
    INSERT INTO attachments (${columns.join(', ')})
    VALUES (${placeholders})
  `).run(...values)
  
  return {
    attachment_id,
    message_id,
    filename: attachmentWithMessageId.filename,
    mime_type: attachmentWithMessageId.mime_type,
    gmail_attachment_id: attachmentWithMessageId.gmail_attachment_id,
    binary_data_base64: attachmentWithMessageId.binary_data_base64 || null,
    text_extract: attachmentWithMessageId.text_extract,
    parsed_fields_json: attachmentWithMessageId.parsed_fields_json,
    parse_confidence_json: attachmentWithMessageId.parse_confidence_json,
    created_at,
  }
}

/**
 * List attachments for a case (via all messages in the case)
 */
export function listAttachmentsForCase(case_id: string): SupplierChaseAttachment[] {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT a.* FROM attachments a
    INNER JOIN messages m ON a.message_id = m.message_id
    WHERE m.case_id = ?
    ORDER BY a.created_at ASC
  `)
  const rows = stmt.all(case_id) as any[]
  
  return rows.map((row) => ({
    attachment_id: row.attachment_id,
    message_id: row.message_id,
    filename: row.filename,
    mime_type: row.mime_type,
    gmail_attachment_id: row.gmail_attachment_id,
    binary_data_base64: row.binary_data_base64 || null,
    text_extract: row.text_extract,
    parsed_fields_json: row.parsed_fields_json ? JSON.parse(row.parsed_fields_json) : null,
    parse_confidence_json: row.parse_confidence_json ? JSON.parse(row.parse_confidence_json) : null,
    created_at: row.created_at,
  }))
}

/**
 * Get attachments for a case with thread_id and received_at included.
 * This is the recommended way to fetch attachments by caseId since it includes
 * message context needed for proper evidence linkage.
 * 
 * @param case_id - Case ID to fetch attachments for
 * @returns Array of attachments with thread_id and received_at from messages
 */
export function getAttachmentsForCase(case_id: string): Array<SupplierChaseAttachment & { thread_id: string | null; received_at: number | null }> {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT 
      a.attachment_id,
      a.message_id,
      a.filename,
      a.mime_type,
      a.gmail_attachment_id,
      a.binary_data_base64,
      a.text_extract,
      a.parsed_fields_json,
      a.parse_confidence_json,
      a.created_at,
      m.thread_id,
      m.received_at
    FROM attachments a
    INNER JOIN messages m ON a.message_id = m.message_id
    WHERE m.case_id = ?
    ORDER BY COALESCE(m.received_at, a.created_at) DESC, a.created_at DESC
  `)
  const rows = stmt.all(case_id) as any[]
  
  return rows.map((row) => ({
    attachment_id: row.attachment_id,
    message_id: row.message_id,
    filename: row.filename,
    mime_type: row.mime_type,
    gmail_attachment_id: row.gmail_attachment_id,
    binary_data_base64: row.binary_data_base64 || null,
    text_extract: row.text_extract,
    parsed_fields_json: row.parsed_fields_json ? JSON.parse(row.parsed_fields_json) : null,
    parse_confidence_json: row.parse_confidence_json ? JSON.parse(row.parse_confidence_json) : null,
    created_at: row.created_at,
    thread_id: row.thread_id || null,
    received_at: row.received_at || null,
  }))
}

/**
 * Update all references from oldAttachmentId to newAttachmentId.
 * Updates references in cases.meta, confirmation_records, confirmation_extractions, and events.
 * 
 * @param db - Database instance
 * @param oldId - Old attachment ID to replace
 * @param newId - New attachment ID to use
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
      console.warn(`[ATTACH_DEDUPE] failed to update case.meta for case ${caseRow.case_id}:`, err)
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
      console.warn(`[ATTACH_DEDUPE] failed to update event.evidence_refs_json for event ${eventRow.event_id}:`, err)
    }
  }
}

/**
 * Cleanup duplicate PDF attachments based on content_sha256 hash.
 * 
 * First, computes content_sha256 for any PDF attachments missing it using decodeBase64UrlToBuffer.
 * Then, for each group of attachments with the same content_sha256:
 * - Chooses a "keeper" row based on: has text_extract > has binary_data_base64 > newest created_at
 * - Deletes all other rows in the group
 * - Updates references in cases.meta, confirmation_records, confirmation_extractions, and events
 * 
 * This is a dev-only cleanup function to remove existing duplicates.
 * 
 * Returns: { groups: number, removed: number }
 */
export function cleanupDuplicatePdfAttachments(): { groups: number; removed: number } {
  const db = getDb()
  const { createHash } = require('crypto')
  
  // Check if content_sha256 column exists
  if (!hasColumn('attachments', 'content_sha256')) {
    console.warn('[ATTACH_DEDUPE] cleanup skipped: content_sha256 column does not exist')
    return { groups: 0, removed: 0 }
  }
  
  // Step 1: Compute content_sha256 for PDFs missing it
  const pdfsWithoutHash = db.prepare(`
    SELECT attachment_id, binary_data_base64
    FROM attachments
    WHERE mime_type = 'application/pdf'
      AND content_sha256 IS NULL
      AND binary_data_base64 IS NOT NULL
      AND LENGTH(binary_data_base64) > 0
  `).all() as Array<{ attachment_id: string; binary_data_base64: string }>
  
  let hashesComputed = 0
  for (const pdf of pdfsWithoutHash) {
    try {
      // Use decodeBase64UrlToBuffer to match emailAttachments.ts and rehash logic
      const binaryData = decodeBase64UrlToBuffer(pdf.binary_data_base64)
      const contentHash = createHash('sha256').update(binaryData).digest('hex')
      const sizeBytes = binaryData.length
      
      db.prepare(`
        UPDATE attachments
        SET content_sha256 = ?, size_bytes = ?
        WHERE attachment_id = ?
      `).run(contentHash, sizeBytes, pdf.attachment_id)
      hashesComputed++
    } catch (err) {
      console.warn(`[ATTACH_DEDUPE] failed to compute hash for ${pdf.attachment_id}:`, err)
    }
  }
  
  if (hashesComputed > 0) {
    console.log(`[ATTACH_DEDUPE] computed hashes for ${hashesComputed} attachments`)
  }
  
  // Step 2: Find all groups with duplicate content_sha256
  const duplicateGroups = db.prepare(`
    SELECT content_sha256, COUNT(*) as cnt
    FROM attachments
    WHERE content_sha256 IS NOT NULL
      AND mime_type = 'application/pdf'
    GROUP BY content_sha256
    HAVING COUNT(*) > 1
  `).all() as Array<{ content_sha256: string; cnt: number }>
  
  if (duplicateGroups.length === 0) {
    console.log('[ATTACH_DEDUPE] cleanup {groups: 0, removed: 0}')
    return { groups: 0, removed: 0 }
  }
  
  let totalRemoved = 0
  
  for (const group of duplicateGroups) {
    const hash = group.content_sha256
    
    // Get all attachments with this hash, ordered by preference for keeper
    const candidates = db.prepare(`
      SELECT 
        attachment_id,
        CASE WHEN text_extract IS NOT NULL AND LENGTH(text_extract) > 0 THEN 1 ELSE 0 END as has_text,
        CASE WHEN binary_data_base64 IS NOT NULL AND LENGTH(binary_data_base64) > 0 THEN 1 ELSE 0 END as has_binary,
        created_at
      FROM attachments
      WHERE content_sha256 = ?
      ORDER BY 
        has_text DESC,
        has_binary DESC,
        created_at DESC
    `).all(hash) as Array<{
      attachment_id: string
      has_text: number
      has_binary: number
      created_at: number
    }>
    
    if (candidates.length <= 1) continue
    
    // First row is the keeper (best candidate)
    const keeper = candidates[0]
    const toDelete = candidates.slice(1)
    
    // Update references before deleting
    for (const del of toDelete) {
      updateAttachmentReferences(db, del.attachment_id, keeper.attachment_id)
    }
    
    // Delete duplicate attachments
    const placeholders = toDelete.map(() => '?').join(',')
    const deleteStmt = db.prepare(`
      DELETE FROM attachments
      WHERE attachment_id IN (${placeholders})
    `)
    const result = deleteStmt.run(...toDelete.map(d => d.attachment_id))
    totalRemoved += result.changes
  }
  
  console.log(`[ATTACH_DEDUPE] cleanup {groups: ${duplicateGroups.length}, removed: ${totalRemoved}}`)
  return { groups: duplicateGroups.length, removed: totalRemoved }
}

/**
 * Execute a function with an exclusive lock on a case to prevent concurrent modifications.
 * 
 * Uses SQLite transaction locking (BEGIN IMMEDIATE) to ensure only one operation
 * can modify a case at a time. If the lock is busy, the function returns null
 * (caller should skip this case and move on).
 * 
 * @param caseId The case ID to lock
 * @param fn The function to execute while holding the lock
 * @returns The result of fn, or null if lock acquisition failed
 */
export function withCaseLock<T>(caseId: string, fn: (caseData: SupplierChaseCase) => T): T | null {
  const db = getDb()
  
  try {
    // Begin immediate transaction (exclusive lock)
    db.exec('BEGIN IMMEDIATE')
    
    try {
      // Re-read case while holding lock
      const caseData = getCase(caseId)
      if (!caseData) {
        db.exec('ROLLBACK')
        return null
      }
      
      // Execute function
      const result = fn(caseData)
      
      // Commit transaction (releases lock)
      db.exec('COMMIT')
      return result
    } catch (error) {
      // Rollback on any error
      db.exec('ROLLBACK')
      throw error
    }
  } catch (error: any) {
    // If lock acquisition failed (SQLITE_BUSY), return null
    if (error.code === 'SQLITE_BUSY' || error.message?.includes('locked')) {
      console.log(`[CASE_LOCK] Case ${caseId} is locked, skipping`)
      return null
    }
    // Re-throw other errors
    throw error
  }
}
