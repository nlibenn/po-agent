import { getDb } from '../supplier-agent/storage/sqlite'
import {
  FollowUpAttempt,
  FollowUpStateEvent,
  FollowUpStateStore,
  ResolvedField,
  SupplierFollowUpState,
  ToneLevel,
  UnresolvedIssue,
} from './types'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS supplier_followup_state (
  po_number       TEXT    NOT NULL,
  po_line         TEXT    NOT NULL,
  supplier_id     TEXT    NOT NULL,

  status          TEXT    NOT NULL DEFAULT 'IDLE',
  attempts_json   TEXT    NOT NULL DEFAULT '[]',
  last_follow_up_at INTEGER,
  next_follow_up_at INTEGER,
  max_follow_ups  INTEGER NOT NULL DEFAULT 3,

  fields_already_requested_json TEXT NOT NULL DEFAULT '[]',
  unresolved_issues_json        TEXT NOT NULL DEFAULT '[]',
  current_tone    TEXT    NOT NULL DEFAULT 'POLITE',

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  PRIMARY KEY (po_number, po_line, supplier_id)
);
`

const MIGRATE_RESOLVED_FIELDS_SQL = `
ALTER TABLE supplier_followup_state ADD COLUMN resolved_fields_json TEXT NOT NULL DEFAULT '{}';
`

let initialized = false

function ensureTable(): void {
  if (initialized) return
  getDb().exec(INIT_SQL)
  // Migration: add resolved_fields_json column (idempotent)
  try { getDb().exec(MIGRATE_RESOLVED_FIELDS_SQL) } catch (_) { /* column already exists */ }
  initialized = true
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface Row {
  po_number: string
  po_line: string
  supplier_id: string
  status: string
  attempts_json: string
  last_follow_up_at: number | null
  next_follow_up_at: number | null
  max_follow_ups: number
  fields_already_requested_json: string
  unresolved_issues_json: string
  resolved_fields_json: string
  current_tone: string
  created_at: number
  updated_at: number
}

function rowToState(row: Row): SupplierFollowUpState {
  return {
    poNumber: row.po_number,
    poLine: row.po_line,
    supplierId: row.supplier_id,
    status: row.status as SupplierFollowUpState['status'],
    attempts: JSON.parse(row.attempts_json) as FollowUpAttempt[],
    lastFollowUpAt: row.last_follow_up_at,
    nextFollowUpAt: row.next_follow_up_at,
    maxFollowUps: row.max_follow_ups,
    fieldsAlreadyRequested: JSON.parse(row.fields_already_requested_json) as string[],
    unresolvedIssues: JSON.parse(row.unresolved_issues_json) as UnresolvedIssue[],
    resolvedFields: JSON.parse(row.resolved_fields_json || '{}') as Record<string, ResolvedField>,
    currentTone: row.current_tone as ToneLevel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function makeDefault(poNumber: string, poLine: string, supplierId: string, now: number): SupplierFollowUpState {
  return {
    poNumber,
    poLine,
    supplierId,
    status: 'IDLE',
    attempts: [],
    lastFollowUpAt: null,
    nextFollowUpAt: null,
    maxFollowUps: 3,
    fieldsAlreadyRequested: [],
    unresolvedIssues: [],
    resolvedFields: {},
    currentTone: 'POLITE',
    createdAt: now,
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Event application (pure)
// ---------------------------------------------------------------------------

function applyEvent(state: SupplierFollowUpState, event: FollowUpStateEvent, now: number): SupplierFollowUpState {
  const next = { ...state, updatedAt: now }

  switch (event.type) {
    case 'FOLLOWUP_SENT': {
      const attempt: FollowUpAttempt = {
        attemptNumber: state.attempts.length + 1,
        sentAt: event.sentAt,
        fieldsRequested: event.fieldsRequested,
        tone: event.tone,
        threadId: event.threadId,
      }
      const merged = Array.from(new Set([...state.fieldsAlreadyRequested, ...event.fieldsRequested]))
      return {
        ...next,
        status: 'AWAITING_REPLY',
        attempts: [...state.attempts, attempt],
        lastFollowUpAt: event.sentAt,
        fieldsAlreadyRequested: merged,
        currentTone: event.tone,
      }
    }

    case 'REPLY_RECEIVED': {
      const remaining = state.unresolvedIssues.filter(
        (i) => !event.resolvedFields.includes(i.field),
      )
      const allResolved = remaining.length === 0
      return {
        ...next,
        status: allResolved ? 'RESOLVED' : state.status,
        unresolvedIssues: remaining,
      }
    }

    case 'ISSUE_RAISED': {
      const exists = state.unresolvedIssues.some((i) => i.field === event.issue.field)
      if (exists) {
        return {
          ...next,
          unresolvedIssues: state.unresolvedIssues.map((i) =>
            i.field === event.issue.field ? { ...i, lastMentionedAt: event.issue.lastMentionedAt, description: event.issue.description } : i,
          ),
        }
      }
      return { ...next, unresolvedIssues: [...state.unresolvedIssues, event.issue] }
    }

    case 'ISSUE_RESOLVED': {
      return {
        ...next,
        unresolvedIssues: state.unresolvedIssues.filter((i) => i.field !== event.field),
      }
    }

    case 'FIELD_RESOLVED': {
      const resolved: ResolvedField = {
        value: event.value,
        resolvedAt: now,
        source: event.source,
      }
      return {
        ...next,
        resolvedFields: { ...state.resolvedFields, [event.field]: resolved },
        unresolvedIssues: state.unresolvedIssues.filter((i) => i.field !== event.field),
      }
    }

    case 'FIELD_INVALIDATED': {
      const { [event.field]: _, ...remaining } = state.resolvedFields
      return {
        ...next,
        resolvedFields: remaining,
      }
    }

    case 'ESCALATED': {
      return { ...next, status: 'ESCALATED' }
    }

    case 'RESET': {
      return makeDefault(state.poNumber, state.poLine, state.supplierId, now)
    }

    default:
      return next
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function save(state: SupplierFollowUpState): void {
  ensureTable()
  getDb()
    .prepare(
      `INSERT INTO supplier_followup_state
        (po_number, po_line, supplier_id, status, attempts_json,
         last_follow_up_at, next_follow_up_at, max_follow_ups,
         fields_already_requested_json, unresolved_issues_json,
         resolved_fields_json, current_tone, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(po_number, po_line, supplier_id) DO UPDATE SET
         status = excluded.status,
         attempts_json = excluded.attempts_json,
         last_follow_up_at = excluded.last_follow_up_at,
         next_follow_up_at = excluded.next_follow_up_at,
         max_follow_ups = excluded.max_follow_ups,
         fields_already_requested_json = excluded.fields_already_requested_json,
         unresolved_issues_json = excluded.unresolved_issues_json,
         resolved_fields_json = excluded.resolved_fields_json,
         current_tone = excluded.current_tone,
         updated_at = excluded.updated_at`,
    )
    .run(
      state.poNumber,
      state.poLine,
      state.supplierId,
      state.status,
      JSON.stringify(state.attempts),
      state.lastFollowUpAt,
      state.nextFollowUpAt,
      state.maxFollowUps,
      JSON.stringify(state.fieldsAlreadyRequested),
      JSON.stringify(state.unresolvedIssues),
      JSON.stringify(state.resolvedFields),
      state.currentTone,
      state.createdAt,
      state.updatedAt,
    )
}

// ---------------------------------------------------------------------------
// Public store
// ---------------------------------------------------------------------------

export const followUpStateStore: FollowUpStateStore = {
  getOrCreateState(poNumber: string, poLine: string, supplierId: string): SupplierFollowUpState {
    ensureTable()
    const row = getDb()
      .prepare('SELECT * FROM supplier_followup_state WHERE po_number = ? AND po_line = ? AND supplier_id = ?')
      .get(poNumber, poLine, supplierId) as Row | undefined

    if (row) return rowToState(row)

    const now = Date.now()
    const state = makeDefault(poNumber, poLine, supplierId, now)
    save(state)
    return state
  },

  updateState(state: SupplierFollowUpState, event: FollowUpStateEvent): SupplierFollowUpState {
    const next = applyEvent(state, event, Date.now())
    save(next)
    return next
  },

  _save: save,
}
