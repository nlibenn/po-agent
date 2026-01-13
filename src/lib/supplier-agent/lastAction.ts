/**
 * Last Action Computation
 * 
 * Computes the most recent meaningful action for a PO/line
 * to display in the Unconfirmed POs table.
 */

import type { SupplierChaseEvent } from './types'
import { summarizeAgentEvents } from './eventSummarizer'
import { formatRelativeTime } from '../utils/relativeTime'

export interface LastAction {
  label: string
  timestamp: number
  relativeTime: string
}

/**
 * Get the last meaningful action for a PO/line from events
 * 
 * Returns the most recent milestone with a short label and relative time.
 */
export function getLastAction(events: SupplierChaseEvent[], poNumber?: string): LastAction | null {
  if (events.length === 0) {
    return null
  }

  // Get milestones (already sorted by most recent first)
  const milestones = summarizeAgentEvents(events, poNumber)
  
  if (milestones.length === 0) {
    return null
  }

  // Get the most recent milestone
  const mostRecent = milestones[0]
  
  // Create short label for table display
  const shortLabel = getShortLabel(mostRecent.label)
  
  return {
    label: shortLabel,
    timestamp: mostRecent.timestamp,
    relativeTime: formatRelativeTime(mostRecent.timestamp),
  }
}

/**
 * Convert milestone label to short table-friendly label
 */
function getShortLabel(milestoneLabel: string): string {
  // Check for prefix matches first (e.g., "Inbox checked for PO 907255")
  if (milestoneLabel.startsWith('Inbox checked for PO')) {
    return 'Inbox checked'
  }
  
  // Map full labels to short versions
  const labelMap: Record<string, string> = {
    'Inbox checked': 'Inbox checked',
    'Email sent': 'Outreach sent',
    'Email drafted': 'Drafted email',
    'Confirmation found': 'Confirmation found',
    'Partial confirmation detected': 'Partial confirmation',
    'No complete confirmation found': 'No confirmation',
    'Supplier replied': 'Reply received',
    'Case resolved': 'Resolved',
  }

  // Check for exact match
  if (labelMap[milestoneLabel]) {
    return labelMap[milestoneLabel]
  }

  // Fallback: use first few words
  return milestoneLabel.split(' ').slice(0, 3).join(' ')
}

/**
 * Format last action for table display
 */
export function formatLastAction(lastAction: LastAction | null): string {
  if (!lastAction) {
    return '—'
  }
  return `${lastAction.label} · ${lastAction.relativeTime}`
}
