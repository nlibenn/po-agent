-- Supplier Chase Agent Database Schema
-- SQLite 3

-- Cases table
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  po_number TEXT NOT NULL,
  line_id TEXT NOT NULL,
  supplier_name TEXT,
  supplier_email TEXT,
  supplier_domain TEXT,
  missing_fields TEXT NOT NULL DEFAULT '[]', -- JSON array
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  touch_count INTEGER NOT NULL DEFAULT 0,
  last_action_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' -- JSON object
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_refs_json TEXT, -- JSON object: {message_ids: [], attachment_ids: []}
  meta_json TEXT, -- JSON object
  FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'INBOUND' or 'OUTBOUND'
  thread_id TEXT,
  from_email TEXT,
  to_email TEXT,
  cc TEXT,
  subject TEXT,
  body_text TEXT,
  received_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL, -- Gmail message ID
  filename TEXT,
  mime_type TEXT,
  gmail_attachment_id TEXT, -- Gmail API attachment ID
  binary_data_base64 TEXT, -- Base64-encoded binary data (temporary storage for PDFs)
  content_sha256 TEXT, -- SHA256 hash of binary content (for content-based deduplication)
  size_bytes INTEGER, -- Size of binary content in bytes
  text_extract TEXT,
  parsed_fields_json TEXT, -- JSON object
  parse_confidence_json TEXT, -- JSON object
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
);

-- Unique constraint for Gmail attachment identity (prevents duplicates)
-- This ensures idempotent retrieval: (Gmail message ID, Gmail attachment ID) uniquely identifies an attachment
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_gmail_identity ON attachments(message_id, gmail_attachment_id) WHERE gmail_attachment_id IS NOT NULL;

-- Unique constraint for content-based deduplication (prevents duplicate files even if Gmail attachment ID changes)
-- Uses (message_id, filename, mime_type, content_sha256) to identify identical file content
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_content_hash ON attachments(message_id, filename, mime_type, content_sha256) WHERE content_sha256 IS NOT NULL AND filename IS NOT NULL AND mime_type IS NOT NULL;

-- Global unique index on content_sha256 alone (prevents any duplicate content regardless of message/filename)
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_content_sha256 ON attachments(content_sha256) WHERE content_sha256 IS NOT NULL;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_case_id ON events(case_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_case_id ON messages(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_cases_po_line ON cases(po_number, line_id);
CREATE INDEX IF NOT EXISTS idx_cases_state ON cases(state);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases(updated_at);

-- Gmail OAuth tokens table
CREATE TABLE IF NOT EXISTS gmail_tokens (
  id TEXT PRIMARY KEY DEFAULT 'default',
  access_token TEXT,
  refresh_token TEXT,
  scope TEXT,
  token_type TEXT,
  expiry_date INTEGER, -- epoch ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Confirmation records table (canonical store for confirmation data)
CREATE TABLE IF NOT EXISTS confirmation_records (
  po_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  supplier_order_number TEXT,
  confirmed_ship_date TEXT, -- ISO string
  confirmed_quantity REAL,
  confirmed_uom TEXT, -- unit of measure
  source_type TEXT NOT NULL, -- email_body | sales_order_confirmation | shipment_notice | invoice | manual
  source_message_id TEXT, -- nullable, references messages.message_id
  source_attachment_id TEXT, -- nullable, references attachments.attachment_id
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (po_id, line_id)
);

-- Indexes for confirmation records lookups
-- Note: idx_confirmation_records_po_line is not needed since PRIMARY KEY already creates an index on (po_id, line_id)
CREATE INDEX IF NOT EXISTS idx_confirmation_records_updated_at ON confirmation_records(updated_at);

-- Confirmation extractions (B3)
-- Stores best-effort parsed confirmation contract fields from evidence text (email/PDF).
CREATE TABLE IF NOT EXISTS confirmation_extractions (
  id TEXT PRIMARY KEY, -- uuid
  case_id TEXT NOT NULL UNIQUE,
  po_number TEXT,
  line_number INTEGER,
  supplier_order_number TEXT,
  confirmed_delivery_date TEXT, -- ISO YYYY-MM-DD if parseable; otherwise raw string
  confirmed_quantity TEXT, -- MVP: store as string (e.g., "10", "10 EA")
  evidence_source TEXT NOT NULL, -- 'email' | 'pdf' | 'mixed' | 'none'
  evidence_attachment_id TEXT,
  evidence_message_id TEXT,
  confidence INTEGER, -- 0-100 optional
  raw_excerpt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_confirmation_extractions_case_id ON confirmation_extractions(case_id);
CREATE INDEX IF NOT EXISTS idx_confirmation_extractions_updated_at ON confirmation_extractions(updated_at);
