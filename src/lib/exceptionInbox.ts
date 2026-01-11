/**
 * Exception Inbox data structures and helpers
 * Extends base exception data with agent actions and buyer workflow status
 */

import { Exception, NormalizedPORow, TriageResult } from './po'

export type ExceptionStatus = 'awaiting_buyer' | 'blocked' | 'resolved'

export interface AgentAction {
  id: string
  timestamp: Date
  action_type: 'detected' | 'analyzed' | 'attempted_resolution' | 'escalated' | 'recommended'
  title: string
  description: string
  outcome?: 'success' | 'failed' | 'pending' | 'requires_buyer'
}

export interface ExceptionInboxItem {
  id: string
  po_id: string
  line_id: string
  supplier_name: string
  issue_summary: string
  agent_attempts: AgentAction[]
  current_status: ExceptionStatus
  next_agent_step?: {
    action: string
    reason: string
  }
  exception: Exception
  triage: TriageResult
  row: NormalizedPORow
}

/**
 * Generate human-readable issue summary from exception and triage data
 */
export function generateIssueSummary(exception: Exception, triage: TriageResult): string {
  const signals = triage.signals.join(', ').toLowerCase()
  
  switch (exception.exception_type) {
    case 'LATE_PO':
      const daysLate = exception.days_late !== null ? exception.days_late : 0
      if (daysLate > 0) {
        return `PO line ${daysLate} day${daysLate > 1 ? 's' : ''} past due date with no receipt recorded`
      }
      return 'PO line past due date with no receipt recorded'
    
    case 'PARTIAL_OPEN':
      return 'Receipt recorded but purchase order line remains open'
    
    case 'ZOMBIE_PO':
      return 'Purchase order line open for extended period with no activity'
    
    case 'UOM_AMBIGUITY':
      return 'Unit of measure ambiguity detected in item description'
    
    default:
      if (signals) {
        return `Unusual pattern detected: ${signals}`
      }
      return 'Exception detected requiring review'
  }
}

/**
 * Generate agent action timeline based on exception data
 */
export function generateAgentActions(
  exception: Exception,
  triage: TriageResult,
  createdAt: Date = new Date()
): AgentAction[] {
  const actions: AgentAction[] = []
  const hoursAgo = (hours: number) => new Date(createdAt.getTime() - hours * 60 * 60 * 1000)
  
  // Initial detection
  actions.push({
    id: `action-${exception.id}-1`,
    timestamp: hoursAgo(24),
    action_type: 'detected',
    title: 'Exception detected',
    description: `Identified ${exception.exception_type || 'exception'} for PO ${exception.po_id}, Line ${exception.line_id}`,
    outcome: 'success'
  })
  
  // Analysis
  actions.push({
    id: `action-${exception.id}-2`,
    timestamp: hoursAgo(22),
    action_type: 'analyzed',
    title: 'Pattern analysis',
    description: `Analyzed ${triage.signals.length} signal${triage.signals.length !== 1 ? 's' : ''}: ${triage.signals.join(', ')}`,
    outcome: 'success'
  })
  
  // Attempted resolution (if applicable)
  if (exception.exception_type === 'PARTIAL_OPEN' || exception.exception_type === 'LATE_PO') {
    actions.push({
      id: `action-${exception.id}-3`,
      timestamp: hoursAgo(20),
      action_type: 'attempted_resolution',
      title: 'Checked ERP system',
      description: 'Verified line status in ERP system - manual intervention required',
      outcome: 'failed'
    })
  }
  
  // Recommended action
  if (triage.next_step) {
    actions.push({
      id: `action-${exception.id}-4`,
      timestamp: hoursAgo(18),
      action_type: 'recommended',
      title: 'Recommended action',
      description: triage.next_step,
      outcome: 'requires_buyer'
    })
  }
  
  return actions
}

/**
 * Determine exception status based on exception and agent actions
 */
export function determineExceptionStatus(
  exception: Exception,
  triage: TriageResult,
  agentActions: AgentAction[]
): ExceptionStatus {
  // If resolved (could be determined by presence of resolved action or other criteria)
  const hasResolvedAction = agentActions.some(a => a.outcome === 'success' && a.action_type === 'escalated')
  if (hasResolvedAction) {
    return 'resolved'
  }
  
  // If blocked (agent attempted but couldn't proceed)
  const hasBlockedAction = agentActions.some(a => a.outcome === 'failed' && a.action_type === 'attempted_resolution')
  if (hasBlockedAction && triage.status === 'Action') {
    return 'blocked'
  }
  
  // Default: awaiting buyer decision
  return 'awaiting_buyer'
}

/**
 * Get next agent step recommendation
 */
export function getNextAgentStep(triage: TriageResult): { action: string; reason: string } | undefined {
  if (!triage.next_step) return undefined
  
  return {
    action: triage.next_step,
    reason: `Based on analysis of ${triage.signals.length} signal${triage.signals.length !== 1 ? 's' : ''}`
  }
}

/**
 * Convert exception and triage data to inbox item
 */
export function exceptionToInboxItem(
  exception: Exception,
  triage: TriageResult,
  row: NormalizedPORow
): ExceptionInboxItem {
  const issueSummary = generateIssueSummary(exception, triage)
  const agentActions = generateAgentActions(exception, triage)
  const currentStatus = determineExceptionStatus(exception, triage, agentActions)
  const nextAgentStep = getNextAgentStep(triage)
  
  return {
    id: exception.id,
    po_id: exception.po_id,
    line_id: exception.line_id,
    supplier_name: exception.supplier_name,
    issue_summary: issueSummary,
    agent_attempts: agentActions,
    current_status: currentStatus,
    next_agent_step: nextAgentStep,
    exception,
    triage,
    row
  }
}

/**
 * Filter exceptions to show only those that need buyer attention (not resolved)
 */
export function filterActiveExceptions(items: ExceptionInboxItem[]): ExceptionInboxItem[] {
  return items.filter(item => item.current_status !== 'resolved')
}

/**
 * Sort exceptions by priority (awaiting_buyer > blocked > resolved)
 */
export function sortExceptionsByPriority(items: ExceptionInboxItem[]): ExceptionInboxItem[] {
  const priorityOrder: Record<ExceptionStatus, number> = {
    awaiting_buyer: 1,
    blocked: 2,
    resolved: 3
  }
  
  return [...items].sort((a, b) => {
    const priorityDiff = priorityOrder[a.current_status] - priorityOrder[b.current_status]
    if (priorityDiff !== 0) return priorityDiff
    
    // Within same status, sort by signal count (more signals = higher priority)
    return b.triage.signals.length - a.triage.signals.length
  })
}
