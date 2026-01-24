'use client'

import { useState, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, FileText, Mail, CheckCircle2, AlertCircle, Clock, Paperclip, Download, FileSpreadsheet, XCircle, Loader2 } from 'lucide-react'
import { useAgentState, TaskStepStatus } from './AgentStateContext'
import { exportConfirmedPOsToCSV } from './exportConfirmedPOs'

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
  const [sessionExpanded, setSessionExpanded] = useState(true)
  const [taskExpanded, setTaskExpanded] = useState(true)
  const [sourcesExpanded, setSourcesExpanded] = useState(true)
  const [gmailConnected, setGmailConnected] = useState(false)
  const [pdfsExpanded, setPdfsExpanded] = useState(false)

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

  const handleExportConfirmed = () => {
    exportConfirmedPOsToCSV(agentState.session.confirmedPOs)
  }

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

  const confirmedCount = agentState.session.confirmedPOs.length
  const inProgressCount = agentState.session.inProgressPOs
  const pendingCount = agentState.session.pendingPOs
  const totalPOs = agentState.session.totalPOs || (confirmedCount + inProgressCount + pendingCount)

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
        {/* CARD 1: SESSION PROGRESS */}
        <div className="border-b border-border/30">
          <button
            onClick={() => setSessionExpanded(!sessionExpanded)}
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface/50 transition-colors"
          >
            <span className="text-xs font-medium text-text-muted uppercase tracking-wide">Session Progress</span>
            {sessionExpanded ? (
              <ChevronDown className="w-4 h-4 text-text-subtle" />
            ) : (
              <ChevronRight className="w-4 h-4 text-text-subtle" />
            )}
          </button>
          {sessionExpanded && (
            <div className="px-4 pb-3 space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">Total POs:</span>
                  <span className="text-text font-medium">{totalPOs}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                    Confirmed:
                  </span>
                  <span className="text-success font-medium">{confirmedCount}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-primary-deep" />
                    In Progress:
                  </span>
                  <span className="text-primary-deep font-medium">{inProgressCount}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted flex items-center gap-1.5">
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-border" />
                    Pending:
                  </span>
                  <span className="text-text-subtle font-medium">{pendingCount}</span>
                </div>
              </div>

              <button
                onClick={handleExportConfirmed}
                disabled={confirmedCount === 0}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-primary-deep text-white hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Export Confirmed ({confirmedCount})
              </button>
            </div>
          )}
        </div>

        {/* CARD 2: CURRENT TASK */}
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
              {agentState.currentTask.poNumber ? (
                <>
                  <div className="text-xs text-text-muted mb-3">
                    Working on: PO {agentState.currentTask.poNumber}{agentState.currentTask.lineId ? `-${agentState.currentTask.lineId}` : ''}
                  </div>
                  <div className="space-y-2">
                    {agentState.currentTask.steps.length > 0 ? (
                      agentState.currentTask.steps.map((step) => (
                        <div key={step.id} className="flex items-start gap-2">
                          {getStatusIcon(step.status)}
                          <span className="text-xs text-text-muted">{step.label}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-text-subtle py-2">
                        No active task steps
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-xs text-text-subtle py-2">
                  No active task
                </div>
              )}
            </div>
          )}
        </div>

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
