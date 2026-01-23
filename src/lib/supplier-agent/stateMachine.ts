/**
 * State Machine - Centralized state transition validation and execution
 * 
 * This module enforces valid state transitions and is the ONLY way state changes.
 * All state mutations must go through transitionCase().
 */

import { CaseState, SupplierChaseCase, SupplierChaseEventInput } from './types'
import { AgentAction, EvidenceRef, assertCan } from './contract'
import { getCase, updateCase, addEvent, listEvents, withCaseLock } from './store'

export enum TransitionEvent {
  CASE_CREATED = 'CASE_CREATED',
  INBOX_CHECK_FOUND_EVIDENCE = 'INBOX_CHECK_FOUND_EVIDENCE',
  INBOX_CHECK_NO_EVIDENCE = 'INBOX_CHECK_NO_EVIDENCE',
  OUTREACH_SENT_OK = 'OUTREACH_SENT_OK',
  FOLLOWUP_SENT_OK = 'FOLLOWUP_SENT_OK',
  PARSE_OK = 'PARSE_OK',
  PARSE_NO_SIGNAL = 'PARSE_NO_SIGNAL',
  APPLY_OK = 'APPLY_OK',
  RESOLVE_OK = 'RESOLVE_OK',
  FAILURE = 'FAILURE',
  USER_REOPEN = 'USER_REOPEN',
  USER_RETRY = 'USER_RETRY',
  NEEDS_HUMAN_ESCALATION = 'NEEDS_HUMAN_ESCALATION',
}

/**
 * Transition table: maps (fromState, event) -> toState
 */
const TRANSITIONS: Record<string, CaseState> = {
  // From INBOX_LOOKUP
  [`${CaseState.INBOX_LOOKUP}:${TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE}`]: CaseState.PARSED,
  [`${CaseState.INBOX_LOOKUP}:${TransitionEvent.OUTREACH_SENT_OK}`]: CaseState.OUTREACH_SENT,
  [`${CaseState.INBOX_LOOKUP}:${TransitionEvent.FAILURE}`]: CaseState.ERROR,

  // From OUTREACH_SENT
  [`${CaseState.OUTREACH_SENT}:${TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE}`]: CaseState.PARSED,
  [`${CaseState.OUTREACH_SENT}:${TransitionEvent.INBOX_CHECK_NO_EVIDENCE}`]: CaseState.WAITING,
  [`${CaseState.OUTREACH_SENT}:${TransitionEvent.FAILURE}`]: CaseState.ERROR,

  // From WAITING
  [`${CaseState.WAITING}:${TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE}`]: CaseState.PARSED,
  [`${CaseState.WAITING}:${TransitionEvent.INBOX_CHECK_NO_EVIDENCE}`]: CaseState.WAITING,
  [`${CaseState.WAITING}:${TransitionEvent.FOLLOWUP_SENT_OK}`]: CaseState.FOLLOWUP_SENT,
  [`${CaseState.WAITING}:${TransitionEvent.NEEDS_HUMAN_ESCALATION}`]: CaseState.ESCALATED,
  [`${CaseState.WAITING}:${TransitionEvent.FAILURE}`]: CaseState.ERROR,

  // From FOLLOWUP_SENT
  [`${CaseState.FOLLOWUP_SENT}:${TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE}`]: CaseState.PARSED,
  [`${CaseState.FOLLOWUP_SENT}:${TransitionEvent.INBOX_CHECK_NO_EVIDENCE}`]: CaseState.WAITING,
  [`${CaseState.FOLLOWUP_SENT}:${TransitionEvent.FAILURE}`]: CaseState.ERROR,

  // From PARSED
  [`${CaseState.PARSED}:${TransitionEvent.RESOLVE_OK}`]: CaseState.RESOLVED,
  [`${CaseState.PARSED}:${TransitionEvent.PARSE_NO_SIGNAL}`]: CaseState.WAITING,
  [`${CaseState.PARSED}:${TransitionEvent.FAILURE}`]: CaseState.ERROR,

  // From RESOLVED (user-initiated only)
  [`${CaseState.RESOLVED}:${TransitionEvent.USER_REOPEN}`]: CaseState.WAITING,

  // From ESCALATED
  [`${CaseState.ESCALATED}:${TransitionEvent.USER_RETRY}`]: CaseState.WAITING,
  [`${CaseState.ESCALATED}:${TransitionEvent.FAILURE}`]: CaseState.ERROR,

  // From ERROR
  [`${CaseState.ERROR}:${TransitionEvent.USER_RETRY}`]: CaseState.INBOX_LOOKUP,
}

/**
 * Check if a transition is valid
 */
export function isValidTransition(
  fromState: CaseState,
  toState: CaseState,
  event: TransitionEvent
): boolean {
  // Same state is always valid (idempotency)
  if (fromState === toState) {
    return true
  }

  // Check transition table
  const key = `${fromState}:${event}`
  const expectedState = TRANSITIONS[key]
  
  return expectedState === toState
}

/**
 * Special handling for ESCALATED state (explicit decision in orchestrator)
 */
export function canEscalateFrom(state: CaseState): boolean {
  return state === CaseState.WAITING
}

export interface TransitionCaseParams {
  caseId: string
  toState: CaseState
  event: TransitionEvent
  summary: string
  evidenceRef?: EvidenceRef
  patch?: Partial<Pick<SupplierChaseCase, 'status' | 'meta' | 'missing_fields' | 'touch_count' | 'last_action_at'>>
  now?: number
}

/**
 * Transition a case to a new state (the ONLY way state changes)
 * 
 * This function is ATOMIC and CONCURRENCY-SAFE:
 * - Executes entirely within a per-case lock (withCaseLock)
 * - Re-reads case inside lock to get latest state
 * - Validates transition and guardrails
 * - Updates database and logs events atomically
 * - Updates scheduling fields (next_check_at)
 * 
 * Idempotent: if case is already in toState and last event matches, does nothing.
 * 
 * @throws Error if transition is invalid, guardrails fail, or case not found
 * @returns Updated case after transition
 */
export function transitionCase(params: TransitionCaseParams): SupplierChaseCase {
  const {
    caseId,
    toState,
    event,
    summary,
    evidenceRef,
    patch = {},
    now = Date.now(),
  } = params

  // Execute entire transition atomically under lock
  const result = withCaseLock(caseId, (lockedCaseData) => {
    // Re-read case inside lock to get latest state (lockedCaseData is already fresh from withCaseLock)
    const caseData = lockedCaseData
    const fromState = caseData.state

    // Idempotency check: if already in target state, check if last event matches
    // IMPORTANT: Scheduling events (INBOX_CHECK_NO_EVIDENCE) must always update next_check_at,
    // so we skip idempotency check for them to ensure scheduling is updated.
    const isSchedulingEvent = event === TransitionEvent.INBOX_CHECK_NO_EVIDENCE
    
    if (fromState === toState && !isSchedulingEvent) {
      const recentEvents = listEvents(caseId)
      const lastEvent = recentEvents[recentEvents.length - 1]
      
      if (lastEvent) {
        // Map event to EventType for comparison
        const eventTypeMap: Record<TransitionEvent, string> = {
          [TransitionEvent.CASE_CREATED]: 'CASE_CREATED',
          [TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE]: 'INBOX_SEARCH_FOUND_INCOMPLETE',
          [TransitionEvent.INBOX_CHECK_NO_EVIDENCE]: 'INBOX_SEARCH_NOT_FOUND',
          [TransitionEvent.OUTREACH_SENT_OK]: 'EMAIL_SENT',
          [TransitionEvent.FOLLOWUP_SENT_OK]: 'EMAIL_SENT',
          [TransitionEvent.PARSE_OK]: 'PDF_PARSED',
          [TransitionEvent.PARSE_NO_SIGNAL]: 'PARSE_RESULT',
          [TransitionEvent.APPLY_OK]: 'APPLY_UPDATES',
          [TransitionEvent.RESOLVE_OK]: 'CASE_RESOLVED',
          [TransitionEvent.FAILURE]: 'CASE_MARKED_UNRESPONSIVE',
          [TransitionEvent.USER_REOPEN]: 'MANUAL_EDIT',
          [TransitionEvent.USER_RETRY]: 'MANUAL_EDIT',
          [TransitionEvent.NEEDS_HUMAN_ESCALATION]: 'CASE_NEEDS_BUYER',
        }
        const expectedEventType = eventTypeMap[event] || 'MANUAL_EDIT'
        
        if (lastEvent.event_type === expectedEventType) {
          // Check if evidence hash matches (for PARSED transitions)
          if (evidenceRef && evidenceRef.content_sha256) {
            const lastEvidenceHash = (lastEvent.meta_json as any)?.content_sha256 || (lastEvent.evidence_refs_json as any)?.content_sha256
            if (lastEvidenceHash === evidenceRef.content_sha256) {
              // Already transitioned with same evidence, skip
              return caseData
            }
          } else if (!evidenceRef) {
            // No evidence ref, and event type matches - skip
            return caseData
          }
        }
      }
    }

    // Validate transition
    if (!isValidTransition(fromState, toState, event)) {
      throw new Error(
        `Invalid transition from ${fromState} to ${toState} via event ${event}`
      )
    }

    // Check agent contract guardrails
    const ctx = {
      caseId,
      state: fromState,
      missingFieldsCount: caseData.missing_fields?.length || 0,
      now,
      meta: caseData.meta || {},
      evidenceRef,
      mode: undefined, // transitions don't have a mode
    }

    try {
      assertCan(AgentAction.TRANSITION, ctx)
    } catch (error: any) {
      // Log failure event but don't throw (transition might still be valid)
      addEvent(caseId, {
        case_id: caseId,
        timestamp: now,
        event_type: 'AGENT_DECISION',
        summary: `Transition guardrail check failed: ${error.message}`,
        evidence_refs_json: evidenceRef ? {
          message_ids: evidenceRef.message_id ? [evidenceRef.message_id] : undefined,
          attachment_ids: evidenceRef.attachment_id ? [evidenceRef.attachment_id] : undefined,
        } : null,
        meta_json: {
          from_state: fromState,
          to_state: toState,
          event: event.toString(),
          error: error.message,
        },
      })
      throw error
    }

    // Build update patch
    const updatePatch: any = {
      state: toState,
      last_action_at: now,
      touch_count: (caseData.touch_count || 0) + 1,
      ...patch,
    }

    // Update scheduling fields
    if ([CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT].includes(toState)) {
      // Set next check 60 minutes from now
      updatePatch.next_check_at = now + 60 * 60 * 1000
    } else if ([CaseState.PARSED, CaseState.RESOLVED, CaseState.ESCALATED, CaseState.ERROR].includes(toState)) {
      // Clear next check (no longer need polling)
      updatePatch.next_check_at = null
    }

    // Update case (inside lock)
    updateCase(caseId, updatePatch)

    // Log audit event (map TransitionEvent to EventType string)
    const eventTypeMap: Record<TransitionEvent, string> = {
      [TransitionEvent.CASE_CREATED]: 'CASE_CREATED',
      [TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE]: 'INBOX_SEARCH_FOUND_INCOMPLETE',
      [TransitionEvent.INBOX_CHECK_NO_EVIDENCE]: 'INBOX_SEARCH_NOT_FOUND',
      [TransitionEvent.OUTREACH_SENT_OK]: 'EMAIL_SENT',
      [TransitionEvent.FOLLOWUP_SENT_OK]: 'EMAIL_SENT',
      [TransitionEvent.PARSE_OK]: 'PDF_PARSED',
      [TransitionEvent.PARSE_NO_SIGNAL]: 'PARSE_RESULT',
      [TransitionEvent.APPLY_OK]: 'APPLY_UPDATES',
      [TransitionEvent.RESOLVE_OK]: 'CASE_RESOLVED',
      [TransitionEvent.FAILURE]: 'CASE_MARKED_UNRESPONSIVE',
      [TransitionEvent.USER_REOPEN]: 'MANUAL_EDIT',
      [TransitionEvent.USER_RETRY]: 'MANUAL_EDIT',
      [TransitionEvent.NEEDS_HUMAN_ESCALATION]: 'CASE_NEEDS_BUYER',
    }

    const eventType = eventTypeMap[event] || 'MANUAL_EDIT'

    const eventData: SupplierChaseEventInput = {
      case_id: caseId,
      timestamp: now,
      event_type: eventType as any,
      summary,
      evidence_refs_json: evidenceRef ? {
        message_ids: evidenceRef.message_id ? [evidenceRef.message_id] : undefined,
        attachment_ids: evidenceRef.attachment_id ? [evidenceRef.attachment_id] : undefined,
      } : null,
      meta_json: {
        from_state: fromState,
        to_state: toState,
        transition_event: event.toString(),
        evidence_hash: evidenceRef?.content_sha256,
        source_type: evidenceRef?.source_type,
        content_sha256: evidenceRef?.content_sha256,
      },
    }

    // Add event (inside lock)
    addEvent(caseId, eventData)

    // Return updated case (re-read inside lock to get latest)
    const updatedCase = getCase(caseId)
    if (!updatedCase) {
      throw new Error(`Case ${caseId} disappeared after update`)
    }

    return updatedCase
  })

  // Handle lock failure
  if (result === null) {
    throw new Error(`Case ${caseId} is locked by another operation`)
  }

  return result
}
