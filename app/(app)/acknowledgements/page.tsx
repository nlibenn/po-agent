'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useWorkspace } from '@/components/WorkspaceProvider'
import { AcknowledgementWorkQueue } from '@/components/acknowledgements/AcknowledgementWorkQueue'
import { AgentWorkspace } from '@/components/acknowledgements/AgentWorkspace'
import { AgentStatePanel } from '@/components/acknowledgements/AgentStatePanel'
import { AcknowledgementChatProvider } from '@/components/acknowledgements/AcknowledgementChatProvider'
import { AgentStateProvider, useAgentState } from '@/components/acknowledgements/AgentStateContext'
import { UnconfirmedPO } from '@/src/lib/unconfirmedPOs'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'

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

/**
 * 4-Panel Acknowledgement Workbench
 * 
 * Layout:
 * - Far-left: Icon-only nav (handled by parent layout, collapses via data attribute)
 * - Left-middle: PO Work Queue (selection + prioritization)
 * - Center: Agent Workspace (chat control plane)
 * - Right: Agent State Mirror (read-only)
 */
export default function AcknowledgementsPage() {
  const { normalizedRows } = useWorkspace()
  
  // Active case state
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null) // Resolved DB case_id
  const [activeCaseKey, setActiveCaseKey] = useState<string | null>(null) // PO-LINE key for UI
  const [activePO, setActivePO] = useState<UnconfirmedPO | null>(null)
  
  
  // Agent state
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  
  // Attachments for context panel
  const [attachments, setAttachments] = useState<Array<{
    attachment_id: string
    filename: string
    mime_type: string
    text_extract?: string | null
  }>>([])
  
  // Refresh trigger for work queue (incremented to force re-fetch)
  const [workQueueRefreshKey, setWorkQueueRefreshKey] = useState(0)

  // Set data attribute for nav collapse (triggers icon-only mode)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.body.setAttribute('data-ack-workbench', 'true')
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.body.removeAttribute('data-ack-workbench')
      }
    }
  }, [])

  // Load attachments when case changes
  useEffect(() => {
    if (!activeCaseId) {
      setAttachments([])
      return
    }

    const loadAttachments = async () => {
      try {
        // Load attachments using resolved caseId
        const attachmentsResponse = await fetch(`/api/confirmations/attachments/list?caseId=${encodeURIComponent(activeCaseId)}`)
        if (attachmentsResponse.ok) {
          const data = await attachmentsResponse.json()
          const atts = data.attachments || []
          setAttachments(atts.filter((a: any) => a.mime_type === 'application/pdf'))
        }
      } catch (error) {
        console.error('Error loading attachments:', error)
      }
    }

    loadAttachments()
  }, [activeCaseId])

  // Handle case selection
  const handleSelectCase = useCallback(async (caseKey: string, po: UnconfirmedPO) => {
    // caseKey is "PO-LINE" format, need to resolve to DB case_id
    setActiveCaseKey(caseKey)
    setActivePO(po)
    setAgentResult(null) // Clear previous result
    
    try {
      const response = await fetch('/api/cases/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poNumber: po.po_id,
          lineId: po.line_id || '',
        }),
      })
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('Failed to resolve case:', errorData.error || response.status)
        setActiveCaseId(null)
        return
      }
      
      const data = await response.json()
      
      if (data.ok && data.caseId) {
        setActiveCaseId(data.caseId)
      } else {
        console.error('Invalid resolve response:', data)
        setActiveCaseId(null)
      }
    } catch (error) {
      console.error('Error resolving case:', error)
      setActiveCaseId(null)
    }
  }, [])

  // Handle agent result
  const handleAgentResult = useCallback((result: AgentResult | null) => {
    setAgentResult(result)
    
    // Refresh attachments if evidence was collected
    if (result?.evidence_summary?.pdf_attachments_count && activeCaseId) {
      // Re-trigger attachment load using resolved caseId
      const loadAttachments = async () => {
        try {
          const attachmentsResponse = await fetch(`/api/confirmations/attachments/list?caseId=${encodeURIComponent(activeCaseId)}`)
          if (attachmentsResponse.ok) {
            const data = await attachmentsResponse.json()
            const atts = data.attachments || []
            setAttachments(atts.filter((a: any) => a.mime_type === 'application/pdf'))
          }
        } catch (error) {
          console.error('Error refreshing attachments:', error)
        }
      }

      loadAttachments()
    }
  }, [activeCaseId])

  // Handle case updated (e.g., after apply) - triggers work queue refresh
  const handleCaseUpdated = useCallback(() => {
    // Trigger work queue refresh by incrementing key
    setWorkQueueRefreshKey(prev => prev + 1)
    
    // Dispatch event so work queue can refetch confirmation records
    window.dispatchEvent(new CustomEvent('confirmationRecordUpdated'))
  }, [])

  // Derive supplier email from matching row
  const supplierEmail = activePO ? (() => {
    const matchingRow = normalizedRows?.find(row => {
      const key = `${row.po_id}-${row.line_id || ''}`
      return key === activeCaseKey
    })
    const rawRow = matchingRow?.rawRow || {}
    return rawRow.supplier_email || 
           rawRow.supplierEmail ||
           rawRow['supplier email'] ||
           rawRow['Supplier Email'] ||
           ''
  })() : undefined

  return (
    <AgentStateProvider>
      <AcknowledgementChatProvider>
        <AcknowledgementsPageInner
          normalizedRows={normalizedRows}
          workQueueRefreshKey={workQueueRefreshKey}
          activeCaseId={activeCaseId}
          activeCaseKey={activeCaseKey}
          activePO={activePO}
          agentResult={agentResult}
          isRunning={isRunning}
          attachments={attachments}
          supplierEmail={supplierEmail}
          onSelectCase={handleSelectCase}
          onAgentResult={handleAgentResult}
          onRunningChange={setIsRunning}
          onCaseUpdated={handleCaseUpdated}
        />
      </AcknowledgementChatProvider>
    </AgentStateProvider>
  )
}

function AcknowledgementsPageInner({
  normalizedRows,
  workQueueRefreshKey,
  activeCaseId,
  activeCaseKey,
  activePO,
  agentResult,
  isRunning,
  attachments,
  supplierEmail,
  onSelectCase,
  onAgentResult,
  onRunningChange,
  onCaseUpdated,
}: {
  normalizedRows: any[]
  workQueueRefreshKey: number
  activeCaseId: string | null
  activeCaseKey: string | null
  activePO: UnconfirmedPO | null
  agentResult: AgentResult | null
  isRunning: boolean
  attachments: Array<{ attachment_id: string; filename: string; mime_type: string; text_extract?: string | null }>
  supplierEmail?: string
  onSelectCase: (caseKey: string, po: UnconfirmedPO) => void
  onAgentResult: (result: AgentResult | null) => void
  onRunningChange: (running: boolean) => void
  onCaseUpdated: () => void
}) {
  const { setTotalPOs, setCSVSource, addConfirmedPO } = useAgentState()
  const { filename } = useWorkspace()
  const poCount = normalizedRows?.length ?? 0

  type AgentActivityStats = { 
    active: number
    awaitingReply: number
    confirmed: number
    onHold: number 
  }

  const [agentActivityStats, setAgentActivityStats] = useState<AgentActivityStats>({
    active: 0,
    awaitingReply: 0,
    confirmed: 0,
    onHold: 0,
  })

  // Stable callback with idempotent updates (Risk 1 + 2 mitigation)
  const handleWorkQueueStatsChange = useCallback((next: AgentActivityStats) => {
    setAgentActivityStats(prev =>
      prev.active === next.active &&
      prev.awaitingReply === next.awaitingReply &&
      prev.confirmed === next.confirmed &&
      prev.onHold === next.onHold
        ? prev  // Don't update if unchanged
        : next
    )
  }, [])  // Empty deps = stable identity

  const [caseStates, setCaseStates] = useState<Record<string, { state: CaseState; status: CaseStatus }>>({})

  // Stable key from normalizedRows to trigger fetch only when dataset changes
  const poLinesKey = useMemo(() => {
    if (!normalizedRows || normalizedRows.length === 0) return ''
    return normalizedRows
      .map(row => `${row.po_id}-${row.line_id || ''}`)
      .sort()
      .join('|')
  }, [normalizedRows])

  useEffect(() => {
    if (!poLinesKey) {
      setCaseStates({})
      handleWorkQueueStatsChange({ active: 0, awaitingReply: 0, confirmed: 0, onHold: 0 })
      return
    }
    
    // Risk 3 mitigation: abort controller for race conditions
    const controller = new AbortController()
    
    const fetchCaseStates = async () => {
      try {
        const poLines = poLinesKey.split('|')
        const response = await fetch('/api/cases/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poLines }),
          signal: controller.signal,
        })
        
        if (!response.ok) return
        
        const data = await response.json()
        const nextStates = (data.cases || {}) as Record<string, { state: CaseState; status: CaseStatus }>
        setCaseStates(nextStates)

        // Compute counters from returned states (primitives only)
        let active = 0
        let awaitingReply = 0
        let confirmed = 0
        let needsAttention = 0

        for (const key of poLines) {
          const caseInfo = nextStates[key]
          if (!caseInfo) continue

          // Active: Agent is working now
          if ([CaseState.INBOX_LOOKUP, CaseState.PARSED].includes(caseInfo.state)) {
            active++
          }
          // Awaiting Reply: Email sent, waiting for supplier
          else if ([CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT].includes(caseInfo.state)) {
            awaitingReply++
          }
          // Confirmed: Complete
          else if (
            caseInfo.state === CaseState.RESOLVED ||
            [CaseStatus.CONFIRMED, CaseStatus.CONFIRMED_WITH_RISK].includes(caseInfo.status)
          ) {
            confirmed++
          }
          // Needs Attention: Manual intervention required
          else if (
            [CaseState.ESCALATED, CaseState.ERROR].includes(caseInfo.state) ||
            [CaseStatus.NEEDS_BUYER, CaseStatus.UNRESPONSIVE].includes(caseInfo.status)
          ) {
            needsAttention++
          }
        }

        handleWorkQueueStatsChange({ active, awaitingReply, confirmed, onHold: needsAttention })
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          console.error('[CASES_BULK] Fetch failed:', error)
        }
      }
    }
    
    fetchCaseStates()
    
    return () => controller.abort()
  }, [poLinesKey, workQueueRefreshKey, handleWorkQueueStatsChange])

  // Update total POs from normalized rows
  useEffect(() => {
    // Avoid depending on the whole agentState object (context value identity changes)
    // and avoid redundant updates when the count is 0.
    if (poCount > 0) setTotalPOs(poCount)
  }, [poCount, setTotalPOs])

  // Update CSV source from workspace
  useEffect(() => {
    if (poCount > 0) {
      setCSVSource(filename || 'uploaded.csv', poCount)
    }
  }, [filename, poCount, setCSVSource])

  // Track confirmed POs when case state changes
  useEffect(() => {
    if (!activeCaseId || !activePO) return

    const checkCaseStatus = async () => {
      try {
        const response = await fetch(`/api/cases/${encodeURIComponent(activeCaseId)}`)
        if (response.ok) {
          const caseData = await response.json()
          if (caseData.status === CaseStatus.CONFIRMED || caseData.status === CaseStatus.CONFIRMED_WITH_RISK) {
            // Add to confirmed POs
            addConfirmedPO({
              po_number: activePO.po_id,
              line_id: activePO.line_id || '',
              supplier_name: activePO.supplier_name || null,
              supplier_order_number: caseData.meta?.parsed_best_fields_v1?.supplier_order_number?.value || null,
              delivery_date: caseData.meta?.parsed_best_fields_v1?.confirmed_delivery_date?.value || null,
              quantity: caseData.meta?.parsed_best_fields_v1?.confirmed_quantity?.value || null,
              unit_price: caseData.meta?.po_line?.unit_price || null,
              confirmed_at: Date.now(),
            })
          }
        }
      } catch (error) {
        console.error('Error checking case status:', error)
      }
    }

    checkCaseStatus()
  }, [activeCaseId, activePO, addConfirmedPO])

  // Debug: Log when props change

  return (
    <div className="h-full flex">
        {/* Left-middle: Work Queue */}
        <div className="w-80 flex-shrink-0">
          <AcknowledgementWorkQueue
            activeCaseId={activeCaseKey}
            onSelectCase={onSelectCase}
          />
        </div>

        {/* Center: Agent Workspace */}
        <div className="flex-1 min-w-0">
          <AgentWorkspace
            caseId={activeCaseId}
            poNumber={activePO?.po_id}
            lineId={activePO?.line_id}
            supplierName={activePO?.supplier_name}
            supplierEmail={supplierEmail}
            onAgentResult={onAgentResult}
            onRunningChange={onRunningChange}
            onCaseUpdated={onCaseUpdated}
          />
        </div>

        {/* Right: Agent State Panel */}
        <div className="w-72 flex-shrink-0">
          <AgentStatePanel
            caseId={activeCaseId}
            agentActivity={agentActivityStats}
            agentResult={agentResult}
            isRunning={isRunning}
            poNumber={activePO?.po_id}
            lineId={activePO?.line_id}
            supplierName={activePO?.supplier_name}
            threadId={agentResult?.evidence_summary?.thread_id}
            attachments={attachments}
            normalizedRows={normalizedRows}
          />
        </div>
      </div>
  )
}
