/**
 * Supplier Chase Agent Type Definitions
 */

export enum CaseState {
  INBOX_LOOKUP = 'INBOX_LOOKUP',
  OUTREACH_SENT = 'OUTREACH_SENT',
  WAITING = 'WAITING',
  PARSED = 'PARSED',
  FOLLOWUP_SENT = 'FOLLOWUP_SENT',
  RESOLVED = 'RESOLVED',
  ESCALATED = 'ESCALATED',
}

export enum CaseStatus {
  CONFIRMED = 'CONFIRMED',
  CONFIRMED_WITH_RISK = 'CONFIRMED_WITH_RISK',
  UNRESPONSIVE = 'UNRESPONSIVE',
  NEEDS_BUYER = 'NEEDS_BUYER',
  STILL_AMBIGUOUS = 'STILL_AMBIGUOUS',
}

export type EventType =
  | 'CASE_CREATED'
  | 'INBOX_SEARCH_STARTED'
  | 'INBOX_SEARCH_FOUND_CONFIRMED'
  | 'INBOX_SEARCH_FOUND_INCOMPLETE'
  | 'INBOX_SEARCH_NOT_FOUND'
  | 'EMAIL_DRAFTED'
  | 'EMAIL_SENT'
  | 'REPLY_RECEIVED'
  | 'ATTACHMENT_INGESTED'
  | 'PDF_TEXT_EXTRACTED'
  | 'PDF_PARSED'
  | 'PARSE_RESULT'
  | 'APPLY_UPDATES'
  | 'MANUAL_EDIT'
  | 'EMAIL_RECEIVED'
  | 'CASE_RESOLVED'
  | 'CASE_MARKED_UNRESPONSIVE'
  | 'CASE_NEEDS_BUYER'
  | 'AGENT_ORCHESTRATE_STARTED'
  | 'AGENT_EVIDENCE_COLLECTED'
  | 'AGENT_FIELDS_EXTRACTED'
  | 'AGENT_DECISION'
  | 'AGENT_EMAIL_SENT'
  | 'AGENT_EMAIL_SKIPPED'

export type MessageDirection = 'INBOUND' | 'OUTBOUND'

export interface SupplierChaseCase {
  case_id: string // UUID
  po_number: string
  line_id: string
  supplier_name: string | null
  supplier_email: string | null
  supplier_domain: string | null
  missing_fields: string[] // e.g. ["delivery_date","pricing_basis"]
  state: CaseState
  status: CaseStatus
  touch_count: number
  last_action_at: number // epoch ms
  created_at: number // epoch ms
  updated_at: number // epoch ms
  meta: Record<string, any> // JSON blob
}

export interface SupplierChaseMessage {
  message_id: string // gmail message id later, uuid for now
  case_id: string
  direction: MessageDirection
  thread_id: string | null
  from_email: string | null
  to_email: string | null
  cc: string | null
  subject: string | null
  body_text: string | null
  received_at: number | null // epoch ms
  created_at: number // epoch ms
}

export interface SupplierChaseAttachment {
  attachment_id: string
  message_id: string
  filename: string | null
  mime_type: string | null
  gmail_attachment_id: string | null
  binary_data_base64: string | null // Base64-encoded binary data (temporary storage for PDFs)
  text_extract: string | null
  parsed_fields_json: Record<string, any> | null
  parse_confidence_json: Record<string, any> | null
  created_at: number // epoch ms
}

export interface SupplierChaseEvent {
  event_id: string
  case_id: string
  timestamp: number // epoch ms
  event_type: EventType
  summary: string
  evidence_refs_json: {
    message_ids?: string[]
    attachment_ids?: string[]
  } | null
  meta_json: Record<string, any> | null
}

// Partial types for updates
export type SupplierChaseCaseUpdate = Partial<Omit<SupplierChaseCase, 'case_id' | 'created_at'>>

export type SupplierChaseEventInput = Omit<SupplierChaseEvent, 'event_id'>

export type SupplierChaseMessageInput = Omit<SupplierChaseMessage, 'message_id' | 'created_at'>

export type SupplierChaseAttachmentInput = Omit<SupplierChaseAttachment, 'attachment_id' | 'created_at'>

// Type for creating attachments where message_id is provided separately
export type SupplierChaseAttachmentCreateInput = Omit<SupplierChaseAttachmentInput, 'message_id'> & { attachment_id?: string }
