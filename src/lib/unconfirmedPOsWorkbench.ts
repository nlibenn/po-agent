/**
 * Workbench table utilities for Unconfirmed POs
 * Computes derived fields (stage, needs, next action, last touch) from confirmation record
 * Note: Computes from confirmationRecord alone since we don't have case data in the table context
 */

import { ConfirmationRecord } from './confirmedPOs'

export type WorkbenchStage = 'not_started' | 'waiting_on_supplier' | 'parsed' | 'ready_to_apply'

export interface WorkbenchDerivedFields {
  stage: WorkbenchStage
  needs: string[] // Missing field names: "Order #", "Delivery date", "Quantity"
  nextAction: string
  lastTouch: string // Relative time like "12m ago", "2h ago", "3d ago", or "—"
  actionLabel: string // Button label: "Start", "Review", "Nudge", "Apply"
}

/**
 * Compute missing fields from confirmation record
 */
function getMissingFields(record: ConfirmationRecord | null | undefined): string[] {
  const missing: string[] = []
  
  if (!record) {
    return ['Order #', 'Delivery date', 'Quantity']
  }
  
  if (!record.supplier_order_number) {
    missing.push('Order #')
  }
  if (!record.confirmed_ship_date) {
    missing.push('Delivery date')
  }
  if (record.confirmed_quantity === null || record.confirmed_quantity === undefined) {
    missing.push('Quantity')
  }
  
  return missing
}

/**
 * Compute stage from confirmation record
 * Simplified: derive from confirmationRecord only (no case data available in table context)
 */
function computeStage(confirmationRecord: ConfirmationRecord | null | undefined): WorkbenchStage {
  if (!confirmationRecord) {
    return 'not_started'
  }
  
  // Check if any fields are extracted
  const hasAnyField = !!(
    confirmationRecord.supplier_order_number ||
    confirmationRecord.confirmed_ship_date ||
    (confirmationRecord.confirmed_quantity !== null && confirmationRecord.confirmed_quantity !== undefined)
  )
  
  if (!hasAnyField) {
    // Record exists but no fields -> waiting on supplier
    return 'waiting_on_supplier'
  }
  
  // Has at least one field extracted -> parsed
  // Note: We can't reliably determine "ready_to_apply" without case data showing unapplied fields
  // So we use "parsed" for any record with extracted fields
  return 'parsed'
}

/**
 * Compute next action from stage and needs
 */
function computeNextAction(stage: WorkbenchStage, needs: string[]): string {
  switch (stage) {
    case 'not_started':
      return 'Send initial request'
    case 'waiting_on_supplier':
      return 'Waiting on supplier'
    case 'parsed':
      if (needs.length > 0) {
        return `Follow up (missing ${needs[0]})`
      }
      return 'Waiting on supplier'
    case 'ready_to_apply':
      return 'Apply updates'
    default:
      return 'Review'
  }
}

/**
 * Compute action button label from stage
 */
function computeActionLabel(stage: WorkbenchStage, needs: string[]): string {
  switch (stage) {
    case 'not_started':
      return 'Start'
    case 'waiting_on_supplier':
      return 'Review'
    case 'parsed':
      if (needs.length > 0) {
        return 'Nudge'
      }
      return 'Review'
    case 'ready_to_apply':
      return 'Apply'
    default:
      return 'Review'
  }
}

/**
 * Format relative time (e.g., "12m ago", "2h ago", "3d ago")
 */
function formatRelativeTime(timestampMs: number | undefined, now: number = Date.now()): string {
  if (!timestampMs) {
    return '—'
  }
  
  const diffMs = now - timestampMs
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  } else if (diffHours < 24) {
    return `${diffHours}h ago`
  } else {
    return `${diffDays}d ago`
  }
}

/**
 * Compute all derived fields for workbench table row
 * Uses confirmationRecord only (case data not available in table context)
 */
export function computeWorkbenchFields(
  confirmationRecord: ConfirmationRecord | null | undefined
): WorkbenchDerivedFields {
  const missingFields = getMissingFields(confirmationRecord)
  const needs = missingFields.slice(0, 3) // Only first 3 as per requirements
  
  const stage = computeStage(confirmationRecord)
  const nextAction = computeNextAction(stage, needs)
  const actionLabel = computeActionLabel(stage, needs)
  
  // Last touch: use confirmationRecord's updated_at if available
  const lastTouchTimestamp = confirmationRecord?.updated_at
  const lastTouch = formatRelativeTime(lastTouchTimestamp)
  
  return {
    stage,
    needs,
    nextAction,
    lastTouch,
    actionLabel,
  }
}

/**
 * Get stage display label
 */
export function getStageLabel(stage: WorkbenchStage): string {
  switch (stage) {
    case 'not_started':
      return 'Not started'
    case 'waiting_on_supplier':
      return 'Waiting on supplier'
    case 'parsed':
      return 'Parsed'
    case 'ready_to_apply':
      return 'Ready to apply'
    default:
      return 'Unknown'
  }
}

/**
 * Sort priority for workbench rows (lower number = higher priority)
 */
export function getStagePriority(stage: WorkbenchStage): number {
  switch (stage) {
    case 'ready_to_apply':
      return 1
    case 'parsed':
      return 2
    case 'waiting_on_supplier':
      return 3
    case 'not_started':
      return 4
    default:
      return 99
  }
}
