import { CaseState } from '../supplier-agent/types'
import {
  FollowUpContext,
  FollowUpDecision,
  SupplierFollowUpState,
  ToneLevel,
} from './types'

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Minimum ms between follow-ups (48 h). */
const COOLDOWN_MS = 48 * 60 * 60 * 1000

/** Tone ladder — index maps to attempt count (0-based). */
const TONE_LADDER: ToneLevel[] = ['POLITE', 'FIRM', 'URGENT']

/**
 * After this many attempts with unresolved issues that the supplier
 * has already been asked about, hand off to a human buyer.
 */
const HANDOFF_THRESHOLD = 2

// ---------------------------------------------------------------------------
// Helpers (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Derive per-field request counts from the attempt history.
 */
export function fieldRequestCounts(state: SupplierFollowUpState): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const attempt of state.attempts) {
    for (const field of attempt.fieldsRequested) {
      counts[field] = (counts[field] || 0) + 1
    }
  }
  return counts
}

/**
 * Select the tone for the next attempt based on how many attempts
 * have already been made.  Clamps to the last rung of the ladder.
 */
export function toneForAttempt(attemptIndex: number): ToneLevel {
  return TONE_LADDER[Math.min(attemptIndex, TONE_LADDER.length - 1)]
}

/**
 * Compute which fields to focus on in the next follow-up.
 *
 * Rules:
 * 1. Never re-ask a field that was already requested UNLESS we are
 *    escalating tone (FIRM or URGENT) — those re-asks are deliberate.
 * 2. Prefer fields that have never been requested.
 * 3. If every missing field has already been requested and tone is
 *    still POLITE, return empty (triggers HANDOFF instead of duplicate ask).
 */
export function selectFocusFields(
  missingFields: string[],
  state: SupplierFollowUpState,
  nextTone: ToneLevel,
): string[] {
  const neverAsked = missingFields.filter(
    (f) => !state.fieldsAlreadyRequested.includes(f),
  )

  // New fields always get included
  if (neverAsked.length > 0) {
    return neverAsked
  }

  // All missing fields were already asked — only re-ask at elevated tone
  if (nextTone !== 'POLITE') {
    return missingFields
  }

  // POLITE + all fields already asked → no valid focus (will cause HANDOFF)
  return []
}

/**
 * Determine whether the case has unresolved issues that have been asked
 * about repeatedly without resolution — a signal for human handoff.
 */
export function shouldHandoff(state: SupplierFollowUpState): boolean {
  if (state.unresolvedIssues.length === 0) return false

  // Count how many attempts mentioned each unresolved issue's field
  for (const issue of state.unresolvedIssues) {
    const timesAsked = state.attempts.filter((a) =>
      a.fieldsRequested.includes(issue.field),
    ).length
    if (timesAsked >= HANDOFF_THRESHOLD) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

/**
 * Pure decision function for the ProcurementFollowUpCoordinatorAgent.
 *
 * Evaluates follow-up state, missing fields, cooldowns, tone ladder,
 * and duplicate-ask rules to return exactly one {@link FollowUpDecision}.
 *
 * Guarantees:
 * - Never sends emails or mutates external systems.
 * - Never asks for the same field twice at POLITE tone.
 * - Escalates tone gradually across attempts (POLITE → FIRM → URGENT).
 * - Respects cooldown and max-attempt policy from persisted state.
 * - Hands off to a human when automated follow-up cannot make progress.
 */
export function decide(context: FollowUpContext): FollowUpDecision {
  const { caseData, messages, followUpState, now } = context

  // ----- Terminal states (NO_OP) -----

  if (
    caseData.state === CaseState.RESOLVED ||
    caseData.state === CaseState.ESCALATED
  ) {
    return { action: 'NO_OP', reason: `Case is ${caseData.state}` }
  }

  if (
    followUpState.status === 'RESOLVED' ||
    followUpState.status === 'ESCALATED'
  ) {
    return {
      action: 'NO_OP',
      reason: `Follow-up state is ${followUpState.status}`,
    }
  }

  // Filter out fields that are already resolved in follow-up state
  const effectiveMissing = caseData.missing_fields.filter(
    (f) => !followUpState.resolvedFields[f],
  )

  if (effectiveMissing.length === 0) {
    return { action: 'NO_OP', reason: 'No unresolved fields (all resolved in follow-up state)' }
  }

  // ----- Max attempts exhausted → ESCALATE -----

  if (followUpState.attempts.length >= followUpState.maxFollowUps) {
    return {
      action: 'ESCALATE',
      reason: `Reached max follow-ups (${followUpState.maxFollowUps}) without resolution`,
    }
  }

  // ----- Cooldown not elapsed → WAIT -----

  if (followUpState.lastFollowUpAt !== null) {
    const cooldownExpiry = followUpState.lastFollowUpAt + COOLDOWN_MS
    if (now < cooldownExpiry) {
      return {
        action: 'WAIT',
        reason: `Cooldown active — last follow-up was ${Math.round((now - followUpState.lastFollowUpAt) / 3_600_000)}h ago, policy requires ${COOLDOWN_MS / 3_600_000}h`,
        waitUntilMs: cooldownExpiry,
      }
    }
  }

  // Respect explicit nextFollowUpAt if it is in the future
  if (followUpState.nextFollowUpAt && now < followUpState.nextFollowUpAt) {
    return {
      action: 'WAIT',
      reason: 'Next follow-up not yet due per schedule',
      waitUntilMs: followUpState.nextFollowUpAt,
    }
  }

  // ----- Repeated unresolved issues → HANDOFF -----

  if (shouldHandoff(followUpState)) {
    const stuckFields = followUpState.unresolvedIssues.map((i) => i.field)
    return {
      action: 'HANDOFF',
      reason: `Supplier has been asked ${HANDOFF_THRESHOLD}+ times about [${stuckFields.join(', ')}] without resolution — needs human buyer`,
    }
  }

  // ----- Determine tone and focus fields -----

  const nextAttemptIndex = followUpState.attempts.length
  const nextTone = toneForAttempt(nextAttemptIndex)
  const focusFields = selectFocusFields(
    effectiveMissing,
    followUpState,
    nextTone,
  )

  // If no valid focus fields (all asked, still POLITE) → HANDOFF
  if (focusFields.length === 0) {
    return {
      action: 'HANDOFF',
      reason:
        'All missing fields have already been requested at POLITE tone and remain unresolved — needs human buyer',
    }
  }

  // ----- Build SEND_FOLLOWUP decision -----

  const lastOutbound = [...messages]
    .reverse()
    .find((m) => m.direction === 'OUTBOUND')

  return {
    action: 'SEND_FOLLOWUP',
    reason: `Follow-up #${nextAttemptIndex + 1} (${nextTone}) for: ${focusFields.join(', ')}`,
    draft: {
      focusFields,
      allMissingFields: effectiveMissing,
      replyToThreadId: lastOutbound?.thread_id ?? undefined,
      tone: nextTone,
    },
  }
}
