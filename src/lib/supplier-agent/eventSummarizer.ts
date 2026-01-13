/**
 * Event Summarization for Buyer-Friendly UI
 * 
 * Maps raw technical events into high-level semantic milestones
 * that are easier for buyers to understand.
 */

import type { SupplierChaseEvent, EventType } from './types'

export interface Milestone {
  id: string // Unique identifier for the milestone type
  label: string // Buyer-friendly label
  timestamp: number // Most recent timestamp for this milestone
  icon?: string // Optional icon identifier
  rawEvents: SupplierChaseEvent[] // All events that contributed to this milestone
}

/**
 * Summarize raw events into buyer-friendly milestones
 * 
 * Collapses duplicates and groups related events together.
 * 
 * @param events Raw events to summarize
 * @param poNumber Optional PO number for context in milestone labels
 */
export function summarizeAgentEvents(events: SupplierChaseEvent[], poNumber?: string): Milestone[] {
  // Group events by milestone type
  const milestoneMap = new Map<string, { label: string; events: SupplierChaseEvent[] }>()

  for (const event of events) {
    const milestone = getMilestoneForEvent(event, poNumber)
    if (!milestone) continue

    const existing = milestoneMap.get(milestone.id)
    if (existing) {
      // Keep the most recent timestamp
      if (event.timestamp > existing.events[0].timestamp) {
        existing.events.unshift(event)
      } else {
        existing.events.push(event)
      }
    } else {
      milestoneMap.set(milestone.id, {
        label: milestone.label,
        events: [event],
      })
    }
  }

  // Convert to array and sort by most recent timestamp
  const milestones: Milestone[] = Array.from(milestoneMap.entries()).map(([id, data]) => ({
    id,
    label: data.label,
    timestamp: data.events[0].timestamp, // Most recent
    rawEvents: data.events,
  }))

  // Sort by timestamp (most recent first)
  milestones.sort((a, b) => b.timestamp - a.timestamp)

  return milestones
}

/**
 * Map a single event to its milestone representation
 * 
 * @param event The event to map
 * @param poNumber Optional PO number for context in labels
 */
function getMilestoneForEvent(event: SupplierChaseEvent, poNumber?: string): { id: string; label: string } | null {
  switch (event.event_type) {
    case 'CASE_CREATED':
      return { id: 'case_created', label: 'Case created' }

    case 'INBOX_SEARCH_STARTED':
      return { 
        id: 'inbox_searched', 
        label: poNumber ? `Inbox checked for PO ${poNumber}` : 'Inbox checked' 
      }

    case 'INBOX_SEARCH_FOUND_CONFIRMED':
      return { id: 'confirmation_found', label: 'Confirmation found' }

    case 'INBOX_SEARCH_FOUND_INCOMPLETE':
      return { id: 'partial_confirmation', label: 'Partial confirmation detected' }

    case 'INBOX_SEARCH_NOT_FOUND':
      return { id: 'no_confirmation', label: 'No complete confirmation found' }

    case 'EMAIL_DRAFTED':
      return { id: 'email_drafted', label: 'Email drafted' }

    case 'EMAIL_SENT':
      return { id: 'email_sent', label: 'Email sent' }

    case 'REPLY_RECEIVED':
      return { id: 'reply_received', label: 'Supplier replied' }

    case 'CASE_RESOLVED':
      return { id: 'case_resolved', label: 'Case resolved' }

    case 'CASE_MARKED_UNRESPONSIVE':
      return { id: 'unresponsive', label: 'Supplier unresponsive' }

    case 'CASE_NEEDS_BUYER':
      return { id: 'needs_buyer', label: 'Needs buyer attention' }

    // Technical events that should be hidden from default view
    case 'ATTACHMENT_INGESTED':
    case 'PDF_TEXT_EXTRACTED':
    case 'PDF_PARSED':
      return null // These are technical details only

    default:
      // Unknown event types - show as-is but with cleaned label
      const eventTypeStr = String(event.event_type)
      return {
        id: `event_${eventTypeStr}`,
        label: eventTypeStr
          .split('_')
          .map(word => word.charAt(0) + word.slice(1).toLowerCase())
          .join(' '),
      }
  }
}

/**
 * Check if an event represents an error
 */
export function isErrorEvent(event: SupplierChaseEvent): boolean {
  // Check if summary contains error indicators
  const summary = event.summary.toLowerCase()
  return (
    summary.includes('error') ||
    summary.includes('failed') ||
    summary.includes('exception') ||
    summary.includes('constraint') ||
    summary.includes('timeout')
  )
}
