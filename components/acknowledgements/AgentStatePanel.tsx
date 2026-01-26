'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronDown, ChevronRight, FileText, CheckCircle2, Paperclip, FileSpreadsheet, XCircle, Loader2 } from 'lucide-react'
import { useAgentState, TaskStepStatus } from './AgentStateContext'

interface AgentResult {
  caseId: string
  policy_version?: string
  state_before?: string
  evidence_summary?: {
    thread_id: string | null
    inbound_messages_count: number
    pdf_attachments_count: number
    attachments_with_text_count: number
    last_email_sent_at: number | null
  }
  extracted_fields_best?: {
    supplier_order_number?: { value: string | null; confidence: number }
    confirmed_delivery_date?: { value: string | null; confidence: number }
    confirmed_quantity?: { value: number | null; confidence: number }
    evidence_source?: 'pdf' | 'email' | 'none'
  } | null
  decision: {
    action_type: 'NO_OP' | 'DRAFT_EMAIL' | 'SEND_EMAIL' | 'APPLY_UPDATES_READY' | 'NEEDS_HUMAN'
    reason: string
    missing_fields_remaining: string[]
    risk_level: 'LOW' | 'MEDIUM' | 'HIGH'
  }
  drafted_email?: {
    subject: string
    body: string
    to: string
    threadId?: string
    bcc?: string
    demoModeActive?: boolean
    demoModeMessage?: string
  }
  requires_user_approval: boolean
}

interface AgentStatePanelProps {
  caseId: string | null
  agentActivity?: { active: number; awaitingReply: number; confirmed: number; onHold: number }
  agentResult: AgentResult | null
  isRunning: boolean
  poNumber?: string
  lineId?: string
  supplierName?: string
  threadId?: string | null
  attachments?: Array<{
    attachment_id: string
    filename: string
    mime_type: string
    text_extract?: string | null
  }>
  normalizedRows?: any[]
}

/**
 * Right panel: Agent State with three cards
 * - Session Progress: Track overall completion and export
 * - Current Task: Real-time workflow visibility
 * - Data Sources: Show what data agent is working with
 */
export function AgentStatePanel({
  caseId,
  agentResult,
  isRunning,
  poNumber,
  lineId,
  supplierName,
  threadId,
  attachments = [],
  normalizedRows,
}: AgentStatePanelProps) {
  // EMERGENCY: Circuit breaker to prevent infinite loops
  const renderCount = useRef(0)
  const prevCaseIdRef = useRef<string | null>(null)
  
  // Reset render count when caseId changes
  if (prevCaseIdRef.current !== caseId) {
    renderCount.current = 0
    prevCaseIdRef.current = caseId
  }
  
  const agentState = useAgentState()
  const { setGmailStatus, setPDFs, setCurrentTask, resetTask } = agentState
  const [historyExpanded, setHistoryExpanded] = useState(true)
  const [taskExpanded, setTaskExpanded] = useState(true)
  const [sourcesExpanded, setSourcesExpanded] = useState(true)
  const [gmailConnected, setGmailConnected] = useState(false)
  const [pdfsExpanded, setPdfsExpanded] = useState(false)

  const [caseDetails, setCaseDetails] = useState<{
    case: any
    recent_events: any[]
    parsed_best_fields?: any
    parsed_best_fields_v1?: any
  } | null>(null)

  // Check Gmail connection status
  // FIXED: Removed agentState from dependencies (it's a context object that changes identity)
  useEffect(() => {
    const checkGmailStatus = async () => {
      try {
        const response = await fetch('/api/gmail/status')
        if (response.ok) {
          const data = await response.json()
          const connected = data.connected || false
          setGmailConnected(connected)
          setGmailStatus(connected)
        }
      } catch (error) {
        console.error('Error checking Gmail status:', error)
        setGmailConnected(false)
        setGmailStatus(false)
      }
    }

    checkGmailStatus()
    const interval = setInterval(checkGmailStatus, 30000) // Check every 30s
    return () => clearInterval(interval)
  }, [setGmailStatus])

  // Fetch case details for PO History timeline (loop-safe: primitive dep only)
  useEffect(() => {
    if (!caseId) {
      setCaseDetails(null)
      return
    }

    const controller = new AbortController()

    const fetchCaseDetails = async () => {
      try {
        const response = await fetch(`/api/confirmations/case/${encodeURIComponent(caseId)}`, {
          signal: controller.signal,
        })

        if (response.ok) {
          const data = await response.json()
          setCaseDetails({
            case: data.case,
            recent_events: data.recent_events || [],
            parsed_best_fields: data.parsed_best_fields || null,
            parsed_best_fields_v1: data.parsed_best_fields_v1 || null,
          })
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.error('[PO_HISTORY] Fetch failed:', err)
        }
      }
    }

    fetchCaseDetails()
    return () => controller.abort()
  }, [caseId])

  // Update PDFs in data sources when attachments change
  // FIXED: Removed agentState from dependencies
  useEffect(() => {
    const pdfs = attachments
      .filter(att => att.mime_type === 'application/pdf')
      .map(att => ({
        filename: att.filename,
        attachmentId: att.attachment_id,
      }))
    setPDFs(pdfs)
  }, [attachments, setPDFs])

  // Update current task when case changes
  // FIXED: Removed agentState from dependencies
  useEffect(() => {
    if (poNumber && lineId) {
      setCurrentTask(poNumber, lineId)
    } else {
      resetTask()
    }
  }, [poNumber, lineId, setCurrentTask, resetTask])

  // Look up PO data from normalizedRows for expected delivery date
  // MUST be before early return to follow Rules of Hooks
  const currentPOData = useMemo(() => {
    if (!normalizedRows || !caseDetails?.case?.po_number) return null
    
    return normalizedRows.find(row => 
      row.po_id === caseDetails.case.po_number &&
      (row.line_id || '1') === (caseDetails.case.line_id || '1')
    )
  }, [normalizedRows, caseDetails?.case?.po_number, caseDetails?.case?.line_id])

  const getStatusIcon = (status: TaskStepStatus) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
      case 'in_progress':
        return <Loader2 className="w-4 h-4 text-primary-deep flex-shrink-0 mt-0.5 animate-spin" />
      case 'failed':
        return <XCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
      case 'pending':
      default:
        return <div className="w-4 h-4 rounded-full border-2 border-border flex-shrink-0 mt-0.5" />
    }
  }

  // Circuit breaker - TEMPORARILY DISABLED for testing
  // renderCount.current++
  // if (renderCount.current > 50) {
  //   console.error('[AgentStatePanel] Too many renders detected, stopping render loop')
  //   return (
  //     <div className="h-full flex items-center justify-center p-6">
  //       <div className="text-center">
  //         <div className="text-error mb-2">Error: Too many renders detected</div>
  //         <div className="text-sm text-text-subtle">Please refresh the page</div>
  //       </div>
  //     </div>
  //   )
  // }

  // Early return if no caseId (after all hooks)
  if (!caseId) {
    return (
      <div className="h-full flex flex-col bg-surface-2/30 border-l border-border/50">
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-surface flex items-center justify-center">
              <FileText className="w-5 h-5 text-text-subtle" />
            </div>
            <p className="text-sm text-text-subtle">Select a PO to view agent state</p>
          </div>
        </div>
      </div>
    )
  }

  // Group consecutive identical event types
  function groupEvents(events: any[]): any[] {
    if (!events || events.length === 0) return []
    
    // Filter out technical events that aren't useful to buyers
    const filtered = events.filter(event => 
      event.event_type !== 'ATTACHMENT_INGESTED' &&
      event.event_type !== 'PDF_TEXT_EXTRACTED' &&
      event.event_type !== 'INBOX_SEARCH_STARTED'  // Always show result events instead
    )
    
    const grouped: any[] = []
    let currentGroup: any = null
    
    for (const event of filtered) {
      if (currentGroup && currentGroup.event_type === event.event_type) {
        // Same type - increment count
        currentGroup.count = (currentGroup.count || 1) + 1
      } else {
        // Different type - push previous group and start new
        if (currentGroup) grouped.push(currentGroup)
        currentGroup = { ...event, count: 1 }
      }
    }
    
    if (currentGroup) grouped.push(currentGroup)
    
    // Limit to 5 most recent groups
    return grouped.slice(0, 5)
  }

  const sortedEvents = groupEvents(
    (caseDetails?.recent_events || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  )
  const missingFields: string[] = Array.isArray(caseDetails?.case?.missing_fields) ? caseDetails!.case.missing_fields : []
  const caseState: string | null = (caseDetails?.case?.state ?? null) as string | null
  const isAwaitingSupplierReply =
    caseState === 'OUTREACH_SENT' || caseState === 'WAITING' || caseState === 'FOLLOWUP_SENT'

  return (
    <div className="h-full flex flex-col bg-surface-2/30 border-l border-border/50">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border/50 bg-surface">
        <h2 className="text-sm font-medium text-text">Agent State</h2>
        {isRunning && (
          <div className="flex items-center gap-1.5 mt-1">
            <div className="w-2 h-2 rounded-full bg-primary-deep animate-pulse" />
            <span className="text-xs text-text-muted">Processing...</span>
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* CARD 1: PO HISTORY */}
        <div className="border-b border-border/30">
          <button
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-2/30 transition-colors"
          >
            <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
              PO History
            </span>
            <ChevronDown
              className={`w-4 h-4 text-text-subtle transition-transform ${
                historyExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>
          {historyExpanded && (
            <div className="px-4 pb-3 space-y-3">
              {/* Events timeline */}
              {sortedEvents.length > 0 ? (
                sortedEvents.map((event: any, idx: number) => (
                  <div key={event.event_id || `${event.timestamp}-${idx}`} className="space-y-0.5">
                    <div className="flex items-start gap-2 text-sm">
                      <span className="shrink-0 mt-0.5">{getEventIcon(event.event_type)}</span>
                      <span className="font-medium text-text">
                        {getEventLabel(event.event_type)}
                        {event.count > 1 && <span className="text-text-muted ml-1">({event.count}×)</span>}
                      </span>
                    </div>
                    <div className="text-xs text-text-muted ml-6">
                      {formatRelativeTime(event.timestamp)}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-xs text-text-muted">No activity yet</p>
              )}

              {/* CONFIRMATION DETAILS */}
              {caseState !== 'RESOLVED' && (
                <div className="space-y-0.5 pt-2 border-t border-border/30">
                  <div className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-0.5">📋</span>
                    <span className="font-medium text-text">Confirmation Details</span>
                  </div>
                  <ul className="ml-6 text-xs space-y-1 mt-2">
                    <li className="flex items-center gap-2">
                      {(() => {
                        const parsed = caseDetails?.case?.meta?.parsed_best_fields_v1
                        const value = parsed?.fields?.supplier_order_number?.value || caseDetails?.parsed_best_fields?.supplier_order_number
                        return value ? (
                          <>
                            <span className="text-success">✓</span>
                            <span className="text-text">Supplier Reference: </span>
                            <span className="text-text font-medium">{value}</span>
                          </>
                        ) : isAwaitingSupplierReply ? (
                          <>
                            <span className="text-warning">⏳</span>
                            <span className="text-text-muted">Supplier Reference (waiting for reply)</span>
                          </>
                        ) : (
                          <>
                            <span className="text-error">✗</span>
                            <span className="text-text-muted">Supplier Reference (missing)</span>
                          </>
                        )
                      })()}
                    </li>
                    <li className="flex items-center gap-2">
                      {(() => {
                        const parsed = caseDetails?.case?.meta?.parsed_best_fields_v1
                        const confirmed = parsed?.fields?.confirmed_delivery_date?.value || caseDetails?.parsed_best_fields?.confirmed_delivery_date
                        
                        if (confirmed) {
                          // Has confirmed value - check if it matches expected
                          const expectedDate = currentPOData?.due_date
                          const expected = expectedDate ? new Date(expectedDate).toISOString().split('T')[0] : null
                          const hasMismatch = expected && confirmed !== expected
                          
                          return hasMismatch ? (
                            // Mismatch - yellow warning
                            <>
                              <span className="text-warning">⚠️</span>
                              <span className="text-text">Delivery Date: </span>
                              <span className="text-text font-medium">{confirmed}</span>
                              <span className="text-text-muted text-xs ml-1">(Expected: {expected})</span>
                            </>
                          ) : (
                            // Match - green check
                            <>
                              <span className="text-success">✓</span>
                              <span className="text-text">Delivery Date: </span>
                              <span className="text-text font-medium">{confirmed}</span>
                            </>
                          )
                        } else if (isAwaitingSupplierReply) {
                          return (
                            <>
                              <span className="text-warning">⏳</span>
                              <span className="text-text-muted">Delivery Date (waiting for reply)</span>
                            </>
                          )
                        } else {
                          return (
                            <>
                              <span className="text-error">✗</span>
                              <span className="text-text-muted">Delivery Date (missing)</span>
                            </>
                          )
                        }
                      })()}
                    </li>
                    <li className="flex items-center gap-2">
                      {(() => {
                        const parsed = caseDetails?.case?.meta?.parsed_best_fields_v1
                        const qty = parsed?.fields?.confirmed_quantity?.value
                        const confirmed = (qty !== null && qty !== undefined) ? qty : (caseDetails?.parsed_best_fields?.confirmed_quantity !== null && caseDetails?.parsed_best_fields?.confirmed_quantity !== undefined) ? caseDetails.parsed_best_fields.confirmed_quantity : null
                        
                        if (confirmed !== null) {
                          // Has confirmed value - check if it matches expected
                          const expected = caseDetails?.case?.meta?.po_line?.ordered_quantity
                          const hasMismatch = expected !== null && expected !== undefined && confirmed !== expected
                          
                          return hasMismatch ? (
                            // Mismatch - yellow warning
                            <>
                              <span className="text-warning">⚠️</span>
                              <span className="text-text">Quantity: </span>
                              <span className="text-text font-medium">{confirmed}</span>
                              <span className="text-text-muted text-xs ml-1">(Expected: {expected})</span>
                            </>
                          ) : (
                            // Match - green check
                            <>
                              <span className="text-success">✓</span>
                              <span className="text-text">Quantity: </span>
                              <span className="text-text font-medium">{confirmed}</span>
                            </>
                          )
                        } else if (isAwaitingSupplierReply) {
                          return (
                            <>
                              <span className="text-warning">⏳</span>
                              <span className="text-text-muted">Quantity (waiting for reply)</span>
                            </>
                          )
                        } else {
                          return (
                            <>
                              <span className="text-error">✗</span>
                              <span className="text-text-muted">Quantity (missing)</span>
                            </>
                          )
                        }
                      })()}
                    </li>
                  </ul>
                </div>
              )}

              {/* Next check */}
              {caseDetails?.case?.next_check_at && (
                <div className="space-y-0.5 pt-2 border-t border-border/30">
                  <div className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-0.5">⏭️</span>
                    <span className="font-medium text-text">
                      Next check: {formatRelativeTime(caseDetails.case.next_check_at)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* CARD 2: CURRENT TASK - only show if steps exist */}
        {agentState.currentTask.steps.length > 0 && (
          <div className="border-b border-border/30">
            <button
              onClick={() => setTaskExpanded(!taskExpanded)}
              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface/50 transition-colors"
            >
              <span className="text-xs font-medium text-text-muted uppercase tracking-wide">Current Task</span>
              {taskExpanded ? (
                <ChevronDown className="w-4 h-4 text-text-subtle" />
              ) : (
                <ChevronRight className="w-4 h-4 text-text-subtle" />
              )}
            </button>
            {taskExpanded && (
              <div className="px-4 pb-3">
                <div className="text-xs text-text-muted mb-3">
                  Working on: PO {agentState.currentTask.poNumber}{agentState.currentTask.lineId ? `-${agentState.currentTask.lineId}` : ''}
                </div>
                <div className="space-y-2">
                  {agentState.currentTask.steps.map((step) => (
                    <div key={step.id} className="flex items-start gap-2">
                      {getStatusIcon(step.status)}
                      <span className="text-xs text-text-muted">{step.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* CARD 3: DATA SOURCES */}
        <div>
          <button
            onClick={() => setSourcesExpanded(!sourcesExpanded)}
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface/50 transition-colors"
          >
            <span className="text-xs font-medium text-text-muted uppercase tracking-wide">Data Sources</span>
            {sourcesExpanded ? (
              <ChevronDown className="w-4 h-4 text-text-subtle" />
            ) : (
              <ChevronRight className="w-4 h-4 text-text-subtle" />
            )}
          </button>
          {sourcesExpanded && (
            <div className="px-4 pb-4 space-y-3">
              {/* CSV Source - Always show */}
              {agentState.dataSources.csvFilename ? (
                <div>
                  <div className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    CSV Upload
                  </div>
                  <div className="text-[10px] text-text-subtle ml-5">
                    {agentState.dataSources.csvFilename}
                  </div>
                  <div className="text-[10px] text-text-subtle ml-5">
                    {agentState.dataSources.csvPOCount} PO{agentState.dataSources.csvPOCount !== 1 ? 's' : ''}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-text-subtle">
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  No CSV uploaded
                </div>
              )}

              {/* Email Attachments (PDFs) - Only show when PDFs exist */}
              {agentState.dataSources.pdfs.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <Paperclip className="w-3.5 h-3.5" />
                      Email Attachments
                    </div>
                    {agentState.dataSources.pdfs.length > 3 && (
                      <button
                        onClick={() => setPdfsExpanded(!pdfsExpanded)}
                        className="text-[10px] text-text-subtle hover:text-text-muted"
                      >
                        {pdfsExpanded ? 'Hide' : 'Show all'}
                      </button>
                    )}
                  </div>
                  <div className="space-y-1 ml-5">
                    {(pdfsExpanded ? agentState.dataSources.pdfs : agentState.dataSources.pdfs.slice(0, 3)).map((pdf, idx) => (
                      <div key={idx} className="flex items-center gap-1.5 text-xs">
                        <Paperclip className="w-3 h-3 text-text-subtle flex-shrink-0" />
                        <span className="text-text-muted truncate">{pdf.filename}</span>
                      </div>
                    ))}
                    {!pdfsExpanded && agentState.dataSources.pdfs.length > 3 && (
                      <div className="text-[10px] text-text-subtle">
                        +{agentState.dataSources.pdfs.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function getEventIcon(eventType: string): string {
  const icons: Record<string, string> = {
    CASE_CREATED: '📝',
    INBOX_SEARCH_STARTED: '🔍',
    EMAIL_SENT: '✅',
    EMAIL_DRAFTED: '✉️',
    PDF_PARSED: '📄',
    CASE_RESOLVED: '✅',
    REPLY_RECEIVED: '📧',
    AGENT_EMAIL_SENT: '✅',
  }
  return icons[eventType] || '•'
}

function getEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    CASE_CREATED: 'Case created',
    INBOX_SEARCH_STARTED: 'Searched inbox',
    EMAIL_SENT: 'Sent confirmation request',
    EMAIL_DRAFTED: 'Drafted email',
    PDF_PARSED: 'Parsed PDF',
    CASE_RESOLVED: 'Confirmed all details',
    REPLY_RECEIVED: 'Received supplier reply',
    AGENT_EMAIL_SENT: 'Agent sent email',
  }
  return labels[eventType] || eventType.replace(/_/g, ' ').toLowerCase()
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = Math.abs(now - timestamp)
  const future = timestamp > now

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return future ? `in ${days}d` : `${days}d ago`
  if (hours > 0) return future ? `in ${hours}h` : `${hours}h ago`
  if (minutes > 5) return future ? `in ${minutes}m` : `${minutes}m ago`
  return 'Just now'
}

function formatFieldName(field: string): string {
  return field
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
