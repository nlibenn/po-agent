/**
 * Unconfirmed POs data structures and helpers
 * Passive monitoring section for purchase orders awaiting confirmation
 */

import { ConfirmationRecord, isConfirmed } from './confirmedPOs'

export type AgentActivityStatus = 'waiting' | 'chasing' | 'escalated' | 'confirmed'

export interface UnconfirmedPO {
  po_id: string
  line_id?: string
  supplier_name: string
  sent_date: Date
  days_since_sent: number
  agent_activity_status: AgentActivityStatus
  agent_activity_days: number // Days into current activity status
  next_escalation_date?: Date
  next_escalation_action?: string
}

/**
 * Calculate days since a given date
 */
export function calculateDaysSince(date: Date, today: Date = new Date()): number {
  const todayNormalized = new Date(today)
  todayNormalized.setHours(0, 0, 0, 0)
  
  const dateNormalized = new Date(date)
  dateNormalized.setHours(0, 0, 0, 0)
  
  const diffTime = todayNormalized.getTime() - dateNormalized.getTime()
  return Math.floor(diffTime / (1000 * 60 * 60 * 24))
}

/**
 * Determine agent activity status based on days since sent
 */
export function determineAgentActivityStatus(daysSinceSent: number): {
  status: AgentActivityStatus
  activityDays: number
  nextEscalationDate?: Date
  nextEscalationAction?: string
} {
  // Usually empty - only show POs that are waiting for confirmation
  // Typically: waiting for first 2 days, then chasing, then escalated
  
  if (daysSinceSent < 2) {
    return {
      status: 'waiting',
      activityDays: daysSinceSent
    }
  } else if (daysSinceSent < 5) {
    return {
      status: 'chasing',
      activityDays: daysSinceSent - 2, // Day 1 of chasing = day 3 since sent
      nextEscalationDate: new Date(Date.now() + (5 - daysSinceSent) * 24 * 60 * 60 * 1000),
      nextEscalationAction: 'Escalate to supplier contact'
    }
  } else if (daysSinceSent < 10) {
    return {
      status: 'escalated',
      activityDays: daysSinceSent - 5,
      nextEscalationDate: new Date(Date.now() + (10 - daysSinceSent) * 24 * 60 * 60 * 1000),
      nextEscalationAction: 'Escalate to procurement manager'
    }
  } else {
    return {
      status: 'escalated',
      activityDays: daysSinceSent - 5,
      nextEscalationDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      nextEscalationAction: 'Review for cancellation'
    }
  }
}

/**
 * Format agent activity status for display
 */
export function formatAgentActivityStatus(
  status: AgentActivityStatus,
  activityDays: number
): string {
  switch (status) {
    case 'waiting':
      return `Waiting — Day ${activityDays + 1}`
    case 'chasing':
      return `Chasing — Day ${activityDays + 1}`
    case 'escalated':
      return `Escalated — Day ${activityDays + 1}`
    case 'confirmed':
      return 'Confirmed'
    default:
      return 'Unknown'
  }
}

/**
 * Placeholder values that should be treated as empty receipt_date
 */
const RECEIPT_DATE_PLACEHOLDERS = ['n/a', 'na', '-', 'null', 'none', '0']

/**
 * Check if a receipt_date value should be treated as empty
 */
function isEmptyReceiptDate(receiptDate: string | null | undefined): boolean {
  if (!receiptDate || typeof receiptDate !== 'string') {
    return true
  }
  const trimmed = receiptDate.trim()
  if (trimmed === '') {
    return true
  }
  return RECEIPT_DATE_PLACEHOLDERS.includes(trimmed.toLowerCase())
}

/**
 * Get unconfirmed POs from session data (if any)
 * This section is usually empty, so only return POs that are truly unconfirmed
 * For demo purposes, we might check for POs without receipt dates
 * 
 * @param rows - Normalized PO rows from workspace
 * @param today - Current date for age calculations
 * @param confirmationRecords - Confirmation records from database (keyed by po_id+line_id)
 */
export function getUnconfirmedPOs(
  rows: any[],
  today: Date = new Date(),
  confirmationRecords: Map<string, ConfirmationRecord> = new Map()
): UnconfirmedPO[] {
  // Diagnostic logging (dev-only)
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[UNCONFIRMED_POS] getUnconfirmedPOs called')
    console.log(`[UNCONFIRMED_POS] total rows input: ${rows.length}`)
    
    // Log sample rows before filtering
    if (rows.length > 0) {
      const samples = rows.slice(0, Math.min(3, rows.length))
      console.log('[UNCONFIRMED_POS] sample rows BEFORE filtering:')
      samples.forEach((row, idx) => {
        console.log(`[UNCONFIRMED_POS] sample ${idx + 1}:`, {
          po_id: row.po_id,
          line_id: row.line_id,
          order_date: row.order_date,
          order_date_typeof: typeof row.order_date,
          receipt_date: row.receipt_date,
          receipt_date_typeof: typeof row.receipt_date,
          supplier_name: row.supplier_name,
        })
      })
    }
  }

  // Filter 1: Include rows where order_date is present (Date)
  const withOrderDate = rows.filter(row => {
    return row.order_date && row.order_date instanceof Date
  })
  
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(`[UNCONFIRMED_POS] rows after filter 1 (has order_date): ${withOrderDate.length}`)
  }

  // Filter 2: Exclude rows where receipt_date is present AND non-empty
  const withoutReceiptDate = withOrderDate.filter(row => {
    return isEmptyReceiptDate(row.receipt_date)
  })

  // Filter 3: Exclude rows that are confirmed according to confirmation_records
  const notConfirmed = withoutReceiptDate.filter(row => {
    const key = `${row.po_id}-${row.line_id}`
    const record = confirmationRecords.get(key)
    // Exclude if this row has a confirmed record
    return !isConfirmed(record)
  })
  
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(`[UNCONFIRMED_POS] rows after filter 2 (no receipt_date): ${withoutReceiptDate.length}`)
    console.log(`[UNCONFIRMED_POS] rows after filter 3 (not confirmed): ${notConfirmed.length}`)
  }

  // Map to UnconfirmedPO format
  const mapped = notConfirmed
    .map((row): UnconfirmedPO | null => {
      const sentDate = row.order_date
      if (!sentDate || !(sentDate instanceof Date)) {
        return null
      }
      
      const daysSinceSent = calculateDaysSince(sentDate, today)
      const activity = determineAgentActivityStatus(daysSinceSent)
      
      return {
        po_id: row.po_id || '',
        line_id: row.line_id,
        supplier_name: row.supplier_name || '',
        sent_date: sentDate,
        days_since_sent: daysSinceSent,
        agent_activity_status: activity.status,
        agent_activity_days: activity.activityDays,
        next_escalation_date: activity.nextEscalationDate,
        next_escalation_action: activity.nextEscalationAction
      } satisfies UnconfirmedPO
    })
    .filter((po): po is UnconfirmedPO => po !== null)

  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(`[UNCONFIRMED_POS] final count after mapping: ${mapped.length}`)
  }

  return mapped
}

/**
 * Parse date helper
 */
function parseDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr || typeof dateStr !== 'string') return null
  const trimmed = dateStr.trim()
  if (trimmed === '') return null
  
  const date = new Date(trimmed)
  if (isNaN(date.getTime())) return null
  
  date.setHours(0, 0, 0, 0)
  return date
}
