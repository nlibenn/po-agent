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
  message_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  gmail_attachment_id TEXT,
  text_extract TEXT,
  parsed_fields_json TEXT, -- JSON object
  parse_confidence_json TEXT, -- JSON object
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
);

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
