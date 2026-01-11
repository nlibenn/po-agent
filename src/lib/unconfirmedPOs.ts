/**
 * Unconfirmed POs data structures and helpers
 * Passive monitoring section for purchase orders awaiting confirmation
 */

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
 * Get unconfirmed POs from session data (if any)
 * This section is usually empty, so only return POs that are truly unconfirmed
 * For demo purposes, we might check for POs without receipt dates
 */
export function getUnconfirmedPOs(rows: any[], today: Date = new Date()): UnconfirmedPO[] {
  // Usually empty - this is passive monitoring
  // In a real system, this would check for POs sent but not confirmed
  // For now, return empty array as this section is usually empty
  
  return []
  
  // Example implementation if we had data:
  // return rows
  //   .filter(row => {
  //     // Only include POs that are sent but not confirmed
  //     const hasSentDate = row.sent_date || row.order_date
  //     const hasReceiptDate = row.receipt_date && row.receipt_date.trim() !== ''
  //     return hasSentDate && !hasReceiptDate
  //   })
  //   .map(row => {
  //     const sentDate = parseDate(row.sent_date || row.order_date)
  //     if (!sentDate) return null
  //     
  //     const daysSinceSent = calculateDaysSince(sentDate, today)
  //     const activity = determineAgentActivityStatus(daysSinceSent)
  //     
  //     return {
  //       po_id: row.po_id || '',
  //       line_id: row.line_id,
  //       supplier_name: row.supplier_name || '',
  //       sent_date: sentDate,
  //       days_since_sent: daysSinceSent,
  //       agent_activity_status: activity.status,
  //       agent_activity_days: activity.activityDays,
  //       next_escalation_date: activity.nextEscalationDate,
  //       next_escalation_action: activity.nextEscalationAction
  //     }
  //   })
  //   .filter((po): po is UnconfirmedPO => po !== null)
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
