import { CaseState, SupplierChaseCase, SupplierChaseMessage } from '../supplier-agent/types'

// ---------------------------------------------------------------------------
// Follow-up state (first-class, never inferred from Gmail)
// ---------------------------------------------------------------------------

export type ToneLevel = 'POLITE' | 'FIRM' | 'URGENT'

export type FollowUpStatus =
  | 'IDLE'            // Created but no follow-up sent yet
  | 'AWAITING_REPLY'  // Follow-up sent, waiting for supplier
  | 'RESOLVED'        // All requested fields received
  | 'ESCALATED'       // Handed off to buyer / human

export interface ResolvedField {
  value: string | number
  resolvedAt: number       // epoch ms
  source: 'parsed' | 'manual' | 'supplier_reply'
}

export interface UnresolvedIssue {
  field: string               // e.g. "delivery_date", "quantity"
  description: string         // Human-readable summary
  firstRaisedAt: number       // epoch ms
  lastMentionedAt: number     // epoch ms
}

export interface FollowUpAttempt {
  attemptNumber: number
  sentAt: number              // epoch ms
  fieldsRequested: string[]
  tone: ToneLevel
  threadId?: string
}

export interface SupplierFollowUpState {
  /** Composite key fields */
  poNumber: string
  poLine: string
  supplierId: string

  /** Tracking */
  status: FollowUpStatus
  attempts: FollowUpAttempt[]
  lastFollowUpAt: number | null       // epoch ms
  nextFollowUpAt: number | null       // epoch ms
  maxFollowUps: number

  /** Content tracking */
  fieldsAlreadyRequested: string[]    // union of all fields ever asked
  unresolvedIssues: UnresolvedIssue[]
  resolvedFields: Record<string, ResolvedField>  // canonical key → resolved value+metadata

  /** Tone escalation */
  currentTone: ToneLevel

  /** Timestamps */
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Events that mutate follow-up state
// ---------------------------------------------------------------------------

export type FollowUpStateEvent =
  | { type: 'FOLLOWUP_SENT'; sentAt: number; fieldsRequested: string[]; tone: ToneLevel; threadId?: string }
  | { type: 'REPLY_RECEIVED'; resolvedFields: string[] }
  | { type: 'ISSUE_RAISED'; issue: UnresolvedIssue }
  | { type: 'ISSUE_RESOLVED'; field: string }
  | { type: 'FIELD_RESOLVED'; field: string; value: string | number; source: ResolvedField['source'] }
  | { type: 'FIELD_INVALIDATED'; field: string; reason: string }
  | { type: 'ESCALATED'; reason: string }
  | { type: 'RESET' }

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface FollowUpStateStore {
  getOrCreateState(poNumber: string, poLine: string, supplierId: string): SupplierFollowUpState
  updateState(state: SupplierFollowUpState, event: FollowUpStateEvent): SupplierFollowUpState
  /** Low-level persist — prefer updateState which applies the event then persists. */
  _save(state: SupplierFollowUpState): void
}

// ---------------------------------------------------------------------------
// Decision types (used by agent.ts — unchanged from scaffold)
// ---------------------------------------------------------------------------

export type FollowUpAction =
  | 'SEND_FOLLOWUP'
  | 'ESCALATE'
  | 'HANDOFF'
  | 'WAIT'
  | 'NO_OP'

export interface FollowUpDecision {
  action: FollowUpAction
  reason: string
  /** When action is WAIT — epoch ms the caller should check again. */
  waitUntilMs?: number
  /** When action is SEND_FOLLOWUP — draft parameters. */
  draft?: {
    /** Fields to request in this specific email (subset of all missing). */
    focusFields: string[]
    /** All missing/unresolved fields for context. */
    allMissingFields: string[]
    /** Thread to reply in, if any. */
    replyToThreadId?: string
    /** Tone to use for this follow-up. */
    tone: ToneLevel
  }
}

export interface FollowUpContext {
  caseData: SupplierChaseCase
  messages: SupplierChaseMessage[]
  followUpState: SupplierFollowUpState
  now: number
}
