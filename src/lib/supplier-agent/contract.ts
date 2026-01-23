/**
 * Agent Contract - Single source of truth for allowed actions per state
 * 
 * This module defines what actions can be performed in each case state
 * and enforces guardrails before any action is executed.
 */

import { CaseState } from './types'

export enum AgentAction {
  INBOX_SEARCH = 'INBOX_SEARCH',
  RETRIEVE_ATTACHMENTS = 'RETRIEVE_ATTACHMENTS',
  PARSE_FIELDS = 'PARSE_FIELDS',
  SEND_OUTREACH = 'SEND_OUTREACH',
  SEND_FOLLOWUP = 'SEND_FOLLOWUP',
  APPLY_UPDATES = 'APPLY_UPDATES',
  TRANSITION = 'TRANSITION',
  POLL_DUE_CASES = 'POLL_DUE_CASES',
}

export interface EvidenceRef {
  message_id: string // required
  thread_id?: string // optional
  attachment_id?: string // optional
  content_sha256: string // required
  source_type: 'pdf' | 'email_body'
}

export interface ActionContext {
  caseId: string
  state: CaseState
  missingFieldsCount: number
  now: number
  meta: Record<string, any>
  recipient?: string // only for send actions
  forceSend?: boolean // for manual override route
  mode?: 'dry_run' | 'queue_only' | 'auto_send' // orchestrator mode
  evidenceRef?: EvidenceRef // for PARSE_FIELDS and transitions to PARSED
}

/**
 * Allowed actions per state (strict mapping)
 */
const ALLOWED_ACTIONS_BY_STATE: Record<CaseState, Set<AgentAction>> = {
  [CaseState.INBOX_LOOKUP]: new Set([
    AgentAction.INBOX_SEARCH,
    AgentAction.SEND_OUTREACH,
    AgentAction.TRANSITION,
  ]),
  [CaseState.OUTREACH_SENT]: new Set([
    AgentAction.INBOX_SEARCH,
    AgentAction.TRANSITION,
  ]),
  [CaseState.WAITING]: new Set([
    AgentAction.INBOX_SEARCH,
    AgentAction.SEND_FOLLOWUP,
    AgentAction.TRANSITION,
  ]),
  [CaseState.PARSED]: new Set([
    AgentAction.APPLY_UPDATES,
    AgentAction.TRANSITION,
  ]),
  [CaseState.FOLLOWUP_SENT]: new Set([
    AgentAction.INBOX_SEARCH,
    AgentAction.TRANSITION,
  ]),
  [CaseState.ESCALATED]: new Set([
    AgentAction.TRANSITION,
  ]),
  [CaseState.RESOLVED]: new Set([
    // No side effects allowed (read-only)
  ]),
  [CaseState.ERROR]: new Set([
    AgentAction.TRANSITION,
  ]),
}

/**
 * Assert that an action is allowed in the current context.
 * Throws an error with a descriptive message if the action is not allowed.
 * 
 * @param action The action to check
 * @param ctx The action context
 * @throws Error if action is not allowed
 */
export function assertCan(action: AgentAction, ctx: ActionContext): void {
  const { state, missingFieldsCount, now, meta, recipient, forceSend, mode, evidenceRef } = ctx

  // Check if action is allowed in current state
  const allowedActions = ALLOWED_ACTIONS_BY_STATE[state] || new Set()
  if (!allowedActions.has(action)) {
    throw new Error(
      `Action ${action} is not allowed in state ${state}. Allowed actions: ${Array.from(allowedActions).join(', ') || 'none'}`
    )
  }

  // Hard guardrails for send actions
  if (action === AgentAction.SEND_OUTREACH || action === AgentAction.SEND_FOLLOWUP) {
    // Guard 1: Recipient must be present (unless forceSend)
    if (!recipient && !forceSend) {
      throw new Error(`Cannot send ${action === AgentAction.SEND_OUTREACH ? 'outreach' : 'follow-up'} email: recipient is missing`)
    }

    // Guard 2: Enforce 24h cooldown (unless forceSend)
    if (!forceSend) {
      const lastSentAt = meta.last_sent_at
      if (lastSentAt && typeof lastSentAt === 'number') {
        const hoursSinceLastSend = (now - lastSentAt) / (1000 * 60 * 60)
        if (hoursSinceLastSend < 24) {
          throw new Error(
            `Cannot send email: cooldown period not met. Last sent ${hoursSinceLastSend.toFixed(1)}h ago, need 24h. Use forceSend to bypass.`
          )
        }
      }
    }

    // Guard 3: Auto-send only if missing fields <= 3
    if (mode === 'auto_send' && missingFieldsCount > 3) {
      throw new Error(
        `Cannot auto-send: missing fields count (${missingFieldsCount}) exceeds limit (3). Use queue_only or dry_run mode.`
      )
    }
  }

  // Guardrail for PARSE_FIELDS: must have evidence with content_sha256
  if (action === AgentAction.PARSE_FIELDS) {
    if (!evidenceRef || !evidenceRef.content_sha256) {
      throw new Error('Cannot parse fields: evidence reference with content_sha256 is required')
    }
  }

  // Guardrail for transitions to PARSED: must have evidence with content_sha256
  if (action === AgentAction.TRANSITION && ctx.evidenceRef) {
    if (!ctx.evidenceRef.content_sha256) {
      throw new Error('Cannot transition to PARSED: evidence reference with content_sha256 is required')
    }
  }
}
