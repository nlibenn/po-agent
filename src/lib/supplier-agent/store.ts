/**
 * Supplier Chase Agent Data Access Layer
 */

import { getDb } from './storage/sqlite'
import type {
  SupplierChaseCase,
  SupplierChaseCaseUpdate,
  SupplierChaseEvent,
  SupplierChaseEventInput,
  SupplierChaseMessage,
  SupplierChaseMessageInput,
  SupplierChaseAttachment,
  SupplierChaseAttachmentInput,
} from './types'

/**
 * Initialize the database (creates tables if needed)
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
 * Add an event to a case
 */
export function addEvent(case_id: string, event: SupplierChaseEventInput): void {
  const db = getDb()
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
 * Add a message to a case
 */
export function addMessage(case_id: string, message: SupplierChaseMessageInput): SupplierChaseMessage {
  const db = getDb()
  const message_id = `${Date.now()}-${Math.random().toString(36).substring(7)}`
  const created_at = Date.now()
  
  const stmt = db.prepare(`
    INSERT INTO messages (
      message_id, case_id, direction, thread_id, from_email, to_email,
      cc, subject, body_text, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    created_at
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
    created_at,
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
 * Add an attachment to a message
 */
export function addAttachment(message_id: string, attachment: SupplierChaseAttachmentInput): SupplierChaseAttachment {
  const db = getDb()
  const attachment_id = `${Date.now()}-${Math.random().toString(36).substring(7)}`
  const created_at = Date.now()
  
  const stmt = db.prepare(`
    INSERT INTO attachments (
      attachment_id, message_id, filename, mime_type, gmail_attachment_id,
      text_extract, parsed_fields_json, parse_confidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  
  stmt.run(
    attachment_id,
    message_id,
    attachment.filename,
    attachment.mime_type,
    attachment.gmail_attachment_id,
    attachment.text_extract,
    attachment.parsed_fields_json ? JSON.stringify(attachment.parsed_fields_json) : null,
    attachment.parse_confidence_json ? JSON.stringify(attachment.parse_confidence_json) : null,
    created_at
  )
  
  return {
    attachment_id,
    message_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    gmail_attachment_id: attachment.gmail_attachment_id,
    text_extract: attachment.text_extract,
    parsed_fields_json: attachment.parsed_fields_json,
    parse_confidence_json: attachment.parse_confidence_json,
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
    text_extract: row.text_extract,
    parsed_fields_json: row.parsed_fields_json ? JSON.parse(row.parsed_fields_json) : null,
    parse_confidence_json: row.parse_confidence_json ? JSON.parse(row.parse_confidence_json) : null,
    created_at: row.created_at,
  }))
}
