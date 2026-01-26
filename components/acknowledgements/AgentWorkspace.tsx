'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Loader2, User, AlertCircle, Sparkles, Copy, Check } from 'lucide-react'
import { useAckChat, AckMessage } from './AcknowledgementChatProvider'
import { useAgentState } from './AgentStateContext'

type EmailDraftState = 'idle' | 'editing' | 'sent'
type EmailDraft = { to: string; subject: string; body: string; threadId?: string }

const __DEBUG_INGEST = 'http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56'
const __DEBUG_SESSION = 'debug-session'

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
  missing_supplier_email?: {
    status: 'MISSING'
    candidates: Array<{
      email: string
      label: string
      messageId: string
      threadId: string | null
    }>
  }
}

interface AgentWorkspaceProps {
  caseId: string | null
  poNumber?: string
  lineId?: string
  supplierName?: string
  supplierEmail?: string
  onAgentResult: (result: AgentResult | null) => void
  onRunningChange: (running: boolean) => void
  onCaseUpdated?: () => void // Callback when case is updated (e.g., after apply)
}

/**
 * Center panel: Agent Workspace (heart)
 * Chat is the control plane. All execution happens through chat commands.
 * 
 * Commands:
 * - "run" / "scan" -> calls /api/agent/ack-orchestrate
 * - "send" -> calls /api/confirmations/send with drafted_email
 * - "apply" -> calls /api/confirmations/case/[caseId]/apply-updates
 */
export function AgentWorkspace({
  caseId,
  poNumber,
  lineId,
  supplierName,
  supplierEmail,
  onAgentResult,
  onRunningChange,
  onCaseUpdated,
}: AgentWorkspaceProps) {
  // EMERGENCY: Circuit breaker to prevent infinite loops
  const renderCount = useRef(0)
  const prevCaseIdRef = useRef<string | null>(null)
  
  // Reset render count when caseId changes (new case = fresh start)
  if (prevCaseIdRef.current !== caseId) {
    renderCount.current = 0
    prevCaseIdRef.current = caseId
  }
  
  renderCount.current++
  
  const { messages, addMessage, clearMessages, isLoading, setIsLoading, setCaseId } = useAckChat()
  const agentState = useAgentState()
  const { setCurrentTask } = agentState
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastAgentResultRef = useRef<AgentResult | null>(null)
  const [customEmailInput, setCustomEmailInput] = useState('')
  const [showCustomEmailInput, setShowCustomEmailInput] = useState(false)
  const [isSavingEmail, setIsSavingEmail] = useState(false)
  const [isSendingDraft, setIsSendingDraft] = useState(false)

  // Email editor state machine:
  // - idle|sent -> editing when a draft is created (mount editor)
  // - editing -> sent after successful send (unmount editor by clearing draft)
  // - any -> idle on case change / reset
  const [emailDraftState, setEmailDraftState] = useState<EmailDraftState>('idle')
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null)
  const prevEmailUiRef = useRef<{ state: EmailDraftState; hasDraft: boolean } | null>(null)
  const justSentEmailRef = useRef<boolean>(false) // Guard to prevent remounting editor immediately after send

  // TEMP DEBUG: invariant guard (should never hold a draft when not editing)
  useEffect(() => {
    if (emailDraftState !== 'editing' && emailDraft !== null) {
      console.error('Invariant violation', { emailDraftState, emailDraft })
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H2',location:'AgentWorkspace.tsx:116-121',message:'Invariant violation (draft exists while not editing)',data:{emailDraftState,hasDraft:!!emailDraft,ua:typeof navigator!=='undefined'?navigator.userAgent:null,origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }, [emailDraftState, emailDraft])

  // TEMP DEBUG: trace email editor state transitions
  useEffect(() => {
    const next = { state: emailDraftState, hasDraft: !!emailDraft }
    const prev = prevEmailUiRef.current
    if (!prev || prev.state !== next.state || prev.hasDraft !== next.hasDraft) {
      prevEmailUiRef.current = next
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H6',location:'AgentWorkspace.tsx:122-140',message:'email editor state changed',data:{prev,next,origin:typeof window!=='undefined'?window.location.origin:null,ua:typeof navigator!=='undefined'?navigator.userAgent:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }, [emailDraftState, emailDraft])

  // TEMP DEBUG: verify whether editor DOM still exists after unmount
  useEffect(() => {
    const canQuery = typeof document !== 'undefined'
    const subjectInputs = canQuery ? document.querySelectorAll('input[placeholder="Email subject"]').length : null
    const bodyTextareas = canQuery ? document.querySelectorAll('textarea[placeholder="Email body"]').length : null
    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H9',location:'AgentWorkspace.tsx:dom-check',message:'editor DOM presence check',data:{emailDraftState,hasDraft:!!emailDraft,subjectInputs,bodyTextareas,origin:typeof window!=='undefined'?window.location.origin:null,ua:typeof navigator!=='undefined'?navigator.userAgent:null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [emailDraftState, emailDraft])

  // TEMP DEBUG: single entry point for editor mounts
  const enterEditing = useCallback((draft: EmailDraft) => {
    console.trace('Editor mounted')
    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H1',location:'AgentWorkspace.tsx:123-128',message:'enterEditing called (mount editor)',data:{draftState:emailDraftState,hasDraft:!!emailDraft,ua:typeof navigator!=='undefined'?navigator.userAgent:null,origin:typeof window!=='undefined'?window.location.origin:null,stack:(new Error('enterEditing')).stack},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    setEmailDraft(draft)
    setEmailDraftState('editing')
  }, [])

  // Sync caseId with chat provider
  // FIXED: Don't run any side effects when caseId is null
  useEffect(() => {
    if (!caseId) {
      // No case selected - don't do anything
      return
    }
    
    setCaseId(caseId)
    // Clear last agent result when case changes
    lastAgentResultRef.current = null
    // Reset temporary email editor UI when case changes
    setEmailDraftState('idle')
    setEmailDraft(null)
    justSentEmailRef.current = false // Clear guard on case change
    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H3',location:'AgentWorkspace.tsx:130-146',message:'caseId sync effect ran',data:{caseIdSuffix:caseId.slice(-6),poNumber, lineId, origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // Reset task when case changes
    setCurrentTask(poNumber || '', lineId || '')
  }, [caseId, setCaseId, poNumber, lineId, setCurrentTask])

  // Auto-scroll to bottom - only when case is selected
  useEffect(() => {
    if (!caseId) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, caseId])

  // Focus input when case changes
  useEffect(() => {
    if (caseId) {
      inputRef.current?.focus()
    }
  }, [caseId])

  // Conversation history for chat mode (state instead of ref for proper reactivity)
  const [conversationHistory, setConversationHistory] = useState<Array<{ role: string; content: string }>>([])
  
  // Track previous caseId to detect changes (using separate ref for this purpose)
  const prevCaseIdForHistoryRef = useRef<string | null>(null)
  
  // Inject context switch message when caseId changes (instead of clearing history)
  // FIXED: Don't run when caseId is null
  useEffect(() => {
    // Don't run any side effects when no case selected
    if (!caseId) {
      prevCaseIdForHistoryRef.current = null
      return
    }
    
    // Skip on initial mount (when prevCaseIdForHistoryRef.current is null and caseId is set)
    if (prevCaseIdForHistoryRef.current === null) {
      prevCaseIdForHistoryRef.current = caseId
      return
    }
    
    // Only inject message if caseId actually changed and we have conversation history
    if (caseId !== prevCaseIdForHistoryRef.current) {
      // Check conversationHistory length using functional update to avoid dependency
      setConversationHistory(prev => {
        if (prev.length > 0) {
          // User switched to a different PO
          const contextSwitchMessage = {
            role: 'system' as const,
            content: `[Context: User has now selected a different PO. Current PO: ${caseId}. Focus on this PO for all subsequent questions.]`
          }
          return [...prev, contextSwitchMessage]
        }
        return prev
      })
    }
    
    // Update ref for next comparison
    prevCaseIdForHistoryRef.current = caseId
  }, [caseId])


  // Quick "Run" action - sends a natural language message
  const runQuickCheck = useCallback(async (): Promise<void> => {
    if (!caseId) {
      addMessage({
        role: 'assistant',
        content: 'No case selected. Please select a PO from the work queue first.',
      })
      return
    }

    const quickMessage = 'Can you check if we have confirmation for this PO?'
    await sendChatMessage(quickMessage)
  }, [caseId, addMessage])

  // Send drafted email
  const sendEmail = useCallback(async (draft: EmailDraft): Promise<void> => {
    if (!caseId) {
      throw new Error('No case selected.')
    }

    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT3',location:'AgentWorkspace.tsx:sendEmail',message:'sendEmail called with draft values',data:{draftSubject:draft.subject,draftBody:draft.body.substring(0,100)+'...',draftTo:draft.to,willSendSubject:draft.subject,willSendBody:draft.body.substring(0,100)+'...'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    onRunningChange(true)

    try {
      // Use supplierEmail prop as fallback, then demo email if both are missing
      const DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'
      const emailTo = draft.to || supplierEmail || DEMO_SUPPLIER_EMAIL
      
      // Include all required fields for send route validation
      // The route can look these up from case if missing, but including them is more reliable
      const requestBody = {
        caseId,
        poNumber: poNumber || undefined, // Include if available
        lineId: lineId || undefined, // Include if available
        supplierEmail: emailTo,
        missingFields: [], // Empty array is valid - route will use case's missingFields if needed
        subject: draft.subject,
        body: draft.body,
        threadId: draft.threadId,
        forceSend: true,
        intent: draft.threadId ? 'followup' : 'initial',
      }
      
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT4',location:'AgentWorkspace.tsx:sendEmail',message:'API request body being sent',data:{requestSubject:requestBody.subject,requestBody:requestBody.body.substring(0,100)+'...',requestTo:requestBody.supplierEmail},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      
      const response = await fetch('/api/confirmations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        // #region agent log
        fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'SEND_ERROR',location:'AgentWorkspace.tsx:sendEmail',message:'API send failed',data:{status:response.status,error:errorData.error||'Unknown error',supplierEmail:emailTo,errorData,fullError:JSON.stringify(errorData)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const errorMessage = errorData.error || errorData.message || `Send failed: ${response.status}`
        const errorDetails = errorData.details ? ` Details: ${errorData.details}` : ''
        console.error('[SEND_EMAIL] API error:', { 
          status: response.status, 
          error: errorData,
          errorMessage,
          errorDetails,
          fullErrorData: JSON.stringify(errorData, null, 2)
        })
        throw new Error(`${errorMessage}${errorDetails}`)
      }

      const responseData = await response.json().catch(() => ({}))
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'SEND_SUCCESS',location:'AgentWorkspace.tsx:sendEmail',message:'API send succeeded',data:{responseData,requestedTo:emailTo,gmailMessageId:responseData.gmailMessageId,threadId:responseData.threadId,action:responseData.action},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      
      // Log if email was actually sent
      if (!responseData.gmailMessageId) {
        console.warn('[SEND_EMAIL] API returned success but no gmailMessageId:', responseData)
        // #region agent log
        fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'SEND_WARNING',location:'AgentWorkspace.tsx:sendEmail',message:'API succeeded but no gmailMessageId',data:{responseData},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }

      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT5',location:'AgentWorkspace.tsx:sendEmail',message:'sendEmail API call succeeded',data:{caseId},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      // Re-run orchestrator to refresh state
      setTimeout(async () => {
        try {
          // #region agent log
          fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT6',location:'AgentWorkspace.tsx:sendEmail.orchestrator',message:'Starting orchestrator refresh',data:{caseId},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          const refreshResponse = await fetch('/api/agent/ack-orchestrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              caseId,
              mode: 'queue_only',
              lookbackDays: 30,
            }),
          })
          if (refreshResponse.ok) {
            const refreshResult = await refreshResponse.json()
            // #region agent log
            fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT7',location:'AgentWorkspace.tsx:sendEmail.orchestrator',message:'Orchestrator refresh completed',data:{hasDraft:!!refreshResult.drafted_email,decisionAction:refreshResult.decision?.action_type},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            lastAgentResultRef.current = refreshResult
            onAgentResult(refreshResult)
          }
        } catch (e) {
          // #region agent log
          fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT8',location:'AgentWorkspace.tsx:sendEmail.orchestrator',message:'Orchestrator refresh error',data:{error:e instanceof Error?e.message:String(e)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          console.error('Failed to refresh agent state after send:', e)
        }
      }, 500)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(errorMessage)
    } finally {
      onRunningChange(false)
    }
  }, [caseId, onAgentResult, onRunningChange])

  const handleSendDraft = useCallback(async (subject: string, body: string): Promise<void> => {
    if (!emailDraft) return
    const nextDraft: EmailDraft = { ...emailDraft, subject, body }

    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT2',location:'AgentWorkspace.tsx:handleSendDraft',message:'handleSendDraft received edited values',data:{receivedSubject:subject,receivedBody:body,emailDraftSubject:emailDraft.subject,emailDraftBody:emailDraft.body,nextDraftSubject:nextDraft.subject,nextDraftBody:nextDraft.body},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    setIsSendingDraft(true)
    try {
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H7',location:'AgentWorkspace.tsx:262-293',message:'handleSendDraft start',data:{emailDraftState,hasDraft:!!emailDraft,origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      await sendEmail(nextDraft)

      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT9',location:'AgentWorkspace.tsx:handleSendDraft',message:'sendEmail completed, about to unmount editor',data:{emailDraftState,hasDraft:!!emailDraft},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      // editing -> sent (unmount editor by clearing draft immediately)
      setEmailDraftState('sent')
      setEmailDraft(null)
      justSentEmailRef.current = true // Set guard to prevent remounting from orchestrator refresh
      
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT10',location:'AgentWorkspace.tsx:handleSendDraft',message:'Editor state set to sent, draft cleared',data:{},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      
      // Clear guard after a delay (orchestrator refresh happens ~500ms later)
      setTimeout(() => {
        justSentEmailRef.current = false
      }, 2000)

      // Force aggressive repaint in Electron webview to clear stale paint artifacts
      if (typeof window !== 'undefined') {
        // #region agent log
        fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H13',location:'AgentWorkspace.tsx:repaint-trigger-handleSend',message:'repaint trigger executing (handleSendDraft)',data:{hasMessagesEnd:!!messagesEndRef.current,hasMessagesContainer:!!messagesContainerRef.current,origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        
        // Multiple repaint techniques for Electron webview
        requestAnimationFrame(() => {
          const container = messagesContainerRef.current
          const endMarker = messagesEndRef.current
          
          if (container) {
            // Technique 1: Force layout recalculation
            void container.offsetHeight
            // Technique 2: Micro-scroll to trigger repaint
            const scrollTop = container.scrollTop
            container.scrollTop = scrollTop + 0.1
            requestAnimationFrame(() => {
              container.scrollTop = scrollTop
            })
          }
          
          if (endMarker) {
            void endMarker.offsetHeight
          }
        })
      }

      // Keep ref for logging, but never render editor from it
      if (lastAgentResultRef.current) {
        lastAgentResultRef.current.drafted_email = undefined
      }

      if (onCaseUpdated) onCaseUpdated()

      addMessage({
        role: 'assistant',
        content: nextDraft.subject
          ? `Email sent to supplier\n\nSubject: "${nextDraft.subject}"`
          : 'Email sent to supplier',
      })
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H7',location:'AgentWorkspace.tsx:262-293',message:'handleSendDraft success -> requested unmount',data:{origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'SEND_CATCH',location:'AgentWorkspace.tsx:handleSendDraft',message:'handleSendDraft caught error',data:{error:msg,errorStack:err instanceof Error?err.stack:undefined},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      console.error('[SEND_EMAIL] Error in handleSendDraft:', err)
      addMessage({ role: 'assistant', content: `❌ Send failed: ${msg}` })
    } finally {
      setIsSendingDraft(false)
    }
  }, [addMessage, emailDraft, onCaseUpdated, sendEmail])

  // Save supplier email and re-run orchestrator
  const saveSupplierEmail = useCallback(async (email: string): Promise<string> => {
    if (!caseId) {
      return '❌ No case selected.'
    }

    setIsSavingEmail(true)

    try {
      // Determine if email is a domain (starts with @)
      const isDomain = email.startsWith('@')
      const supplierDomain = isDomain ? email.slice(1) : (email.includes('@') ? email.split('@')[1] : null)
      const supplierEmail = isDomain ? null : email

      const response = await fetch('/api/confirmations/case/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId, // Use caseId to update existing case
          supplierEmail: supplierEmail || null,
          supplierDomain: supplierDomain || undefined,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Save failed: ${response.status}`)
      }

      const result = await response.json()
      
      // Update case data
      if (result.case) {
        // Re-run orchestrator to continue flow
        setTimeout(async () => {
          try {
            const refreshResponse = await fetch('/api/agent/ack-orchestrate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caseId,
                mode: 'queue_only',
                lookbackDays: 30,
              }),
            })
            if (refreshResponse.ok) {
              const refreshResult = await refreshResponse.json()
              lastAgentResultRef.current = refreshResult
              onAgentResult(refreshResult)
              
              // Add message showing orchestrator result (skip draft mention - inline editor is the UI for drafts)
              const { decision } = refreshResult
              let responseText = `**Agent completed** (${decision.action_type})\n\n`
              responseText += `${decision.reason}`
              
              // LEGACY REMOVED: Do not mention "Draft ready" in text - inline editor card is the UI for drafts
              
              addMessage({
                role: 'assistant',
                content: responseText,
              })
            }
          } catch (e) {
            console.error('Failed to re-run orchestrator after email save:', e)
          }
        }, 500)

        return `Got it — I'll use ${email}.`
      }

      return `✅ Supplier email saved: ${email}`
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return `❌ **Save failed**: ${errorMessage}`
    } finally {
      setIsSavingEmail(false)
      setShowCustomEmailInput(false)
      setCustomEmailInput('')
    }
  }, [caseId, poNumber, lineId, onAgentResult, addMessage])

  // Apply extracted fields
  const applyUpdates = useCallback(async (): Promise<string> => {
    const extracted = lastAgentResultRef.current?.extracted_fields_best
    if (!extracted) {
      return '❌ No extracted fields available. Run the agent first.'
    }

    if (!caseId) {
      return '❌ No case selected.'
    }

    // Check if there's anything to apply
    const hasSO = extracted.supplier_order_number?.value
    const hasDate = extracted.confirmed_delivery_date?.value
    const hasQty = extracted.confirmed_quantity?.value !== null && extracted.confirmed_quantity?.value !== undefined

    if (!hasSO && !hasDate && !hasQty) {
      return '❌ No fields to apply. All extracted values are empty.'
    }

    onRunningChange(true)

    try {
      // Build payload for apply-updates endpoint
      const fields: Record<string, { value: any; confidence?: number }> = {}
      
      if (hasSO) {
        fields.supplier_order_number = {
          value: extracted.supplier_order_number!.value,
          confidence: extracted.supplier_order_number!.confidence,
        }
      }
      
      if (hasDate) {
        fields.confirmed_ship_or_delivery_date = {
          value: extracted.confirmed_delivery_date!.value,
          confidence: extracted.confirmed_delivery_date!.confidence,
        }
      }
      
      if (hasQty) {
        fields.confirmed_quantity = {
          value: extracted.confirmed_quantity!.value,
          confidence: extracted.confirmed_quantity!.confidence,
        }
      }

      const response = await fetch(`/api/confirmations/case/${caseId}/apply-updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: extracted.evidence_source === 'pdf' ? 'pdf' : 'email',
          fields,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Apply failed: ${response.status}`)
      }

      const result = await response.json()

      // Notify parent to refresh work queue
      if (onCaseUpdated) {
        onCaseUpdated()
      }

      // Build success message
      const appliedFields: string[] = []
      if (hasSO) appliedFields.push(`SO#: ${extracted.supplier_order_number!.value}`)
      if (hasDate) appliedFields.push(`Date: ${extracted.confirmed_delivery_date!.value}`)
      if (hasQty) appliedFields.push(`Qty: ${extracted.confirmed_quantity!.value}`)

      let message = `✅ **Updates applied!**\n\n${appliedFields.join('\n')}`
      
      if (result.deduped) {
        message = `ℹ️ **Already applied** - No changes needed.\n\n${appliedFields.join('\n')}`
      }

      // Re-run orchestrator to refresh state
      setTimeout(async () => {
        try {
          const refreshResponse = await fetch('/api/agent/ack-orchestrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              caseId,
              mode: 'queue_only',
              lookbackDays: 30,
            }),
          })
          if (refreshResponse.ok) {
            const refreshResult = await refreshResponse.json()
            lastAgentResultRef.current = refreshResult
            onAgentResult(refreshResult)
          }
        } catch (e) {
          console.error('Failed to refresh agent state after apply:', e)
        }
      }, 500)

      return message
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return `❌ **Apply failed**: ${errorMessage}`
    } finally {
      onRunningChange(false)
    }
  }, [caseId, onAgentResult, onRunningChange, onCaseUpdated])

  // Conversational chat with OpenAI function calling
  const sendChatMessage = useCallback(async (userMessage: string): Promise<void> => {
    if (!caseId) {
      console.warn('[AgentWorkspace] caseId is missing! Cannot send message.')
      addMessage({
        role: 'assistant',
        content: 'No case selected. Please select a PO from the work queue first.',
      })
      return
    }

    // Local view of state transitions within this request (React state updates are async).
    let draftStateAtRequest: EmailDraftState = emailDraftState

    // Add user message to chat immediately
    addMessage({
      role: 'user',
      content: userMessage,
    })

    // Build conversation history with current message included
    const updatedHistory = [...conversationHistory, { role: 'user', content: userMessage }]
    
    // Update conversation history state
    setConversationHistory(updatedHistory)

    setIsLoading(true)
    onRunningChange(true)

    // Initialize task steps for "Check confirmation" workflow
    if (userMessage.toLowerCase().includes('check') || userMessage.toLowerCase().includes('confirmation')) {
      agentState.setCurrentTask(poNumber || '', lineId || '')
      agentState.addTaskStep({
        id: 'search_inbox',
        label: `Searching inbox for PO ${poNumber || 'N/A'}`,
        status: 'in_progress',
      })
    }

    const requestBody = {
      message: userMessage,
      caseId,
      conversationHistory: updatedHistory.slice(-10), // Keep last 10 messages for context
    }
    

    try {
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Chat failed: ${response.status}`)
      }

      const result = await response.json()
      
      const assistantResponse = result.response || result.message || 'I received your message but had trouble generating a response.'

      // If tools were used, update task steps and agent result
      if (result.tool_calls && result.tool_calls.length > 0) {
        // NOTE: This is intentionally the ONLY place we transition the email editor.
        // Legacy path removed: we do NOT render the editor from refs, messages, or tool results directly.
        let draftStateDuringThisResponse: EmailDraftState = draftStateAtRequest
        let shouldUseCompactSentMessage = false
        let shouldSkipAssistantResponse = false // Skip verbose response when inline editor mounts
        let sentSubject: string | null = emailDraft?.subject ?? null

        // Update task steps based on tool calls
        for (const toolCall of result.tool_calls) {
          const tool = toolCall.tool
          const toolResult = toolCall.result
          
          if (tool === 'search_inbox') {
            // Step 1: Searching inbox
            agentState.updateTaskStep('search_inbox', 'completed', `Searching inbox for PO ${poNumber || 'N/A'}`)
            
            // Step 2: Found PDFs
            if (toolResult?.pdf_count > 0) {
              agentState.addTaskStep({
                id: 'found_pdfs',
                label: `Found ${toolResult.pdf_count} PDF${toolResult.pdf_count !== 1 ? 's' : ''}`,
                status: 'completed',
              })
              
              // Step 3: Parsing PDFs (if PDFs found and parsed)
              if (toolResult?.has_parsed_data) {
                agentState.addTaskStep({
                  id: 'parsing_pdfs',
                  label: 'Parsing PDF attachments',
                  status: 'completed',
                })
              } else if (toolResult?.pdf_count > 0) {
                agentState.addTaskStep({
                  id: 'parsing_pdfs',
                  label: 'Parsing PDF attachments',
                  status: 'in_progress',
                })
              }
            }
          } else if (tool === 'read_confirmation') {
            // Step 3: Parsing PDFs
            agentState.updateTaskStep('parsing_pdfs', 'completed', 'Parsing PDF attachments')
            
            // Step 4: Extracting confirmation data
            agentState.addTaskStep({
              id: 'extracting_data',
              label: 'Extracting confirmation data',
              status: toolResult?.status === 'success' ? 'completed' : toolResult?.status === 'error' ? 'failed' : 'in_progress',
            })
          } else if (tool === 'draft_email') {
            // Step 5: Drafting email
            agentState.addTaskStep({
              id: 'drafting_email',
              label: 'Drafting email to supplier',
              status: toolResult?.status === 'draft_ready' ? 'completed' : 'in_progress',
            })
          } else if (tool === 'send_email') {
            // Step 6: Sending email
            agentState.addTaskStep({
              id: 'sending_email',
              label: 'Sending email to supplier',
              status: toolResult?.status === 'sent' ? 'completed' : toolResult?.status === 'error' ? 'failed' : 'in_progress',
            })

            // Treat any non-error send_email tool result as success, and hard-unmount editor.
            // This is intentionally strict: after a successful send, the editor must be impossible to keep alive.
            const sendSucceeded = !!toolResult?.status && toolResult.status !== 'error'
            if (sendSucceeded) {
              // editing -> sent (guaranteed editor unmount)
              draftStateDuringThisResponse = 'sent'
              shouldUseCompactSentMessage = true

              console.trace('Editor unmounted (send_email)')
              // #region agent log
              fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H4',location:'AgentWorkspace.tsx:622-648',message:'send_email tool success -> unmount editor',data:{toolStatus:toolResult?.status,emailDraftStateBefore:emailDraftState,hasDraftBefore:!!emailDraft,origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
              // #endregion
              setEmailDraftState('sent')
              setEmailDraft(null)
              
              // Force aggressive repaint in Electron webview to clear stale paint artifacts
              if (typeof window !== 'undefined') {
                // #region agent log
                fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H13',location:'AgentWorkspace.tsx:repaint-trigger',message:'repaint trigger executing',data:{hasMessagesEnd:!!messagesEndRef.current,hasMessagesContainer:!!messagesContainerRef.current,origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
                
                // Multiple repaint techniques for Electron webview
                requestAnimationFrame(() => {
                  const container = messagesContainerRef.current
                  const endMarker = messagesEndRef.current
                  
                  if (container) {
                    // Technique 1: Force layout recalculation
                    void container.offsetHeight
                    // Technique 2: Micro-scroll to trigger repaint
                    const scrollTop = container.scrollTop
                    container.scrollTop = scrollTop + 0.1
                    requestAnimationFrame(() => {
                      container.scrollTop = scrollTop
                    })
                  }
                  
                  if (endMarker) {
                    void endMarker.offsetHeight
                  }
                })
              }

              // Legacy cleanup: ensure no other UI can resurrect this draft from refs
              if (lastAgentResultRef.current) {
                lastAgentResultRef.current.drafted_email = undefined
              }

              if (onCaseUpdated) onCaseUpdated()
            }
          }
        }
        
        // Check if we got extracted fields from read_confirmation
        const readResult = result.tool_calls.find((tc: any) => tc.tool === 'read_confirmation')
        if (readResult?.result?.extracted_fields) {
          const fields = readResult.result.extracted_fields
          const mockResult: AgentResult = {
            caseId,
            decision: {
              action_type: readResult.result.missing_fields?.length > 0 ? 'DRAFT_EMAIL' : 'APPLY_UPDATES_READY',
              reason: readResult.result.summary || 'Fields extracted',
              missing_fields_remaining: readResult.result.missing_fields || [],
              risk_level: 'LOW',
            },
            extracted_fields_best: {
              supplier_order_number: { value: fields.supplier_order_number || null, confidence: 0.9 },
              confirmed_delivery_date: { value: fields.delivery_date || null, confidence: 0.9 },
              confirmed_quantity: { value: fields.quantity || null, confidence: 0.9 },
              evidence_source: readResult.result.evidence_source || 'pdf',
            },
            requires_user_approval: true,
          }
          lastAgentResultRef.current = mockResult
          onAgentResult(mockResult)
        }

        // Check if we got a draft from draft_email
        const draftResult = result.tool_calls.find((tc: any) => tc.tool === 'draft_email')
        if (draftResult?.result?.status === 'draft_ready') {
          const draft = draftResult.result
          // Use supplierEmail prop as fallback, then demo email if both are missing
          const DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'
          const draftTo = draft.to || supplierEmail || DEMO_SUPPLIER_EMAIL
          const nextDraft: EmailDraft = {
            to: draftTo,
            subject: draft.subject,
            body: draft.body,
            threadId: draft.thread_id,
          }

          if (lastAgentResultRef.current) {
            lastAgentResultRef.current.drafted_email = {
              subject: draft.subject,
              body: draft.body,
              to: draftTo,
              threadId: draft.thread_id,
              demoModeActive: draft.demo_mode,
              demoModeMessage: draft.demo_warning,
            }
          } else {
            lastAgentResultRef.current = {
              caseId,
              decision: {
                action_type: 'DRAFT_EMAIL',
                reason: 'Draft ready for review',
                missing_fields_remaining: [],
                risk_level: 'LOW',
              },
              drafted_email: {
                subject: draft.subject,
                body: draft.body,
                to: draftTo,
                threadId: draft.thread_id,
                demoModeActive: draft.demo_mode,
                demoModeMessage: draft.demo_warning,
              },
              requires_user_approval: true,
            }
          }
          onAgentResult(lastAgentResultRef.current)

          // Only mount if we're not already editing (single editor instance).
          // Note: sent -> editing is allowed when a NEW draft is created, BUT NOT immediately after we just sent an email.
          if (draftStateDuringThisResponse !== 'editing' && !justSentEmailRef.current) {
            // #region agent log
            fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H5',location:'AgentWorkspace.tsx:676-723',message:'draft_email tool ready -> attempting enterEditing',data:{draftStateDuringThisResponse,emailDraftState,hasDraft:!!emailDraft,justSentEmail:justSentEmailRef.current,origin:typeof window!=='undefined'?window.location.origin:null},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            enterEditing(nextDraft)
            draftStateDuringThisResponse = 'editing'
            // Skip verbose assistant response - inline editor card is self-explanatory
            shouldSkipAssistantResponse = true
          } else if (justSentEmailRef.current) {
            // #region agent log
            fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT11',location:'AgentWorkspace.tsx:draft_email',message:'Blocked remounting editor - just sent email',data:{draftStateDuringThisResponse,emailDraftState},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
          }
        }

        // Add assistant response to chat (optionally compacted for send confirmation, or skipped if inline editor mounted)
        if (!shouldSkipAssistantResponse) {
          const finalAssistantResponse = shouldUseCompactSentMessage
            ? sentSubject
              ? `Email sent to supplier\n\nSubject: "${sentSubject}"`
              : 'Email sent to supplier'
            : assistantResponse

          addMessage({
            role: 'assistant',
            content: finalAssistantResponse,
          })

          setConversationHistory(prev => [
            ...prev,
            { role: 'assistant', content: finalAssistantResponse },
          ])
        }
      } else {
        // No tool calls: just add assistant response to chat
        addMessage({
          role: 'assistant',
          content: assistantResponse,
        })

        setConversationHistory(prev => [
          ...prev,
          { role: 'assistant', content: assistantResponse },
        ])
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      addMessage({
        role: 'assistant',
        content: `❌ **Error**: ${errorMessage}`,
        metadata: { error: 'true' },
      })
    } finally {
      setIsLoading(false)
      onRunningChange(false)
    }
  }, [
    caseId,
    conversationHistory,
    addMessage,
    setIsLoading,
    onRunningChange,
    onAgentResult,
    onCaseUpdated,
    enterEditing,
    emailDraftState,
    emailDraft?.subject,
  ])

  // Handle user input - everything is natural language now
  const handleUserInput = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return

    // Only special case: "clear" command
    if (trimmed.toLowerCase() === 'clear') {
      clearMessages()
      setConversationHistory([])
      return
    }

    // Everything else goes to conversational chat
    await sendChatMessage(trimmed)
  }, [sendChatMessage, clearMessages])

  // Handle send from input
  const handleSend = async () => {
    if (!input.trim() || isLoading) return
    const userMessage = input.trim()
    setInput('')
    await handleUserInput(userMessage)
  }

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Circuit breaker - TEMPORARILY DISABLED for testing
  // renderCount.current++
  // if (renderCount.current > 50) {
  //   console.error('[AgentWorkspace] Too many renders detected, stopping render loop')
  //   return (
  //     <div className="h-full flex items-center justify-center p-6">
  //       <div className="text-center">
  //         <div className="text-error mb-2">Error: Too many renders detected</div>
  //         <div className="text-sm text-text-subtle">Please refresh the page</div>
  //       </div>
  //     </div>
  //   )
  // }

  // Early return when no case selected - show empty state WITHOUT any side effects
  // This happens AFTER all hooks are called (React rules)
  if (!caseId) {
    return (
      <div className="h-full flex flex-col bg-white">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-surface-2 flex items-center justify-center">
              <Sparkles className="w-7 h-7 text-text-subtle" />
            </div>
            <h2 className="text-lg font-medium text-text mb-2">Agent Workspace</h2>
            <p className="text-sm text-text-muted mb-4">
              Select a PO from the work queue to begin. The agent will help you chase down acknowledgements.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-3 bg-surface">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary-deep/10 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-deep" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text">
              {poNumber}{lineId ? `-${lineId}` : ''}
            </div>
            <div className="text-xs text-text-muted truncate">
              {supplierName || 'Unknown supplier'}
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-text-muted mb-3">
                Ask me anything about this PO
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {/* Temporary draft email editor: only renders while editing */}
            {/* LEGACY REMOVED: do not render from `lastAgentResultRef.current?.drafted_email` (single render path only) */}
            {emailDraftState === 'editing' && emailDraft && (
              <EmailDraftCard
                key={`${caseId || 'no-case'}:${emailDraft.to}:${emailDraft.subject}`}
                initialSubject={emailDraft.subject}
                initialBody={emailDraft.body}
                to={emailDraft.to}
                onSend={handleSendDraft}
                isSending={isSendingDraft}
              />
            )}
            
            {/* Missing supplier email prompt */}
            {lastAgentResultRef.current?.decision?.action_type === 'NEEDS_HUMAN' &&
             lastAgentResultRef.current?.missing_supplier_email?.status === 'MISSING' && (
              <MissingSupplierEmailPrompt
                candidates={lastAgentResultRef.current.missing_supplier_email.candidates}
                onSelectCandidate={async (email) => {
                  // Add user selection message
                  addMessage({
                    role: 'user',
                    content: `Use ${email}`,
                  })
                  
                  // Save and confirm
                  const result = await saveSupplierEmail(email)
                  addMessage({
                    role: 'assistant',
                    content: result,
                  })
                }}
                onEnterCustom={async (email) => {
                  // Add user input message
                  addMessage({
                    role: 'user',
                    content: `Use ${email}`,
                  })
                  
                  // Save and confirm
                  const result = await saveSupplierEmail(email)
                  addMessage({
                    role: 'assistant',
                    content: result,
                  })
                }}
                customEmailInput={customEmailInput}
                setCustomEmailInput={setCustomEmailInput}
                showCustomEmailInput={showCustomEmailInput}
                setShowCustomEmailInput={setShowCustomEmailInput}
                isSaving={isSavingEmail}
              />
            )}
            
            {isLoading && (
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-primary-deep/10 flex items-center justify-center flex-shrink-0">
                  <Loader2 className="w-4 h-4 text-primary-deep animate-spin" />
                </div>
                <div className="flex-1 py-1">
                  <span className="text-sm text-text-muted">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary-deep animate-pulse mr-2" />
                    Thinking...
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex-shrink-0 bg-surface">
        {/* Text input */}
        <div className="px-6 pb-4 flex gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question or give an instruction..."
            className="flex-1 px-4 py-2.5 text-sm border border-border/70 rounded-xl bg-white resize-none focus:outline-none focus:ring-2 focus:ring-primary-deep/20 focus:border-primary-deep/50 placeholder:text-text-subtle"
            rows={1}
            disabled={isLoading}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="px-4 py-2.5 rounded-xl bg-primary-deep text-white hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

interface EmailDraftCardProps {
  initialSubject: string
  initialBody: string
  to: string
  onSend: (subject: string, body: string) => Promise<void>
  isSending: boolean
}

function EmailDraftCard({ initialSubject, initialBody, to, onSend, isSending }: EmailDraftCardProps) {
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H8',location:'AgentWorkspace.tsx:EmailDraftCard',message:'EmailDraftCard mounted',data:{origin:typeof window!=='undefined'?window.location.origin:null,ua:typeof navigator!=='undefined'?navigator.userAgent:null,isSending},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return () => {
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'divergence-pre',hypothesisId:'H8',location:'AgentWorkspace.tsx:EmailDraftCard',message:'EmailDraftCard unmounted',data:{origin:typeof window!=='undefined'?window.location.origin:null,ua:typeof navigator!=='undefined'?navigator.userAgent:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }, [isSending])
  
  // Log when isSending changes
  useEffect(() => {
    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT_SEND_STATE',location:'AgentWorkspace.tsx:EmailDraftCard.isSending',message:'isSending state changed',data:{isSending},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [isSending])

  const handleCopy = () => {
    navigator.clipboard.writeText(`To: ${to}\nSubject: ${subject}\n\n${body}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSendClick = async () => {
    // #region agent log
    fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT1',location:'AgentWorkspace.tsx:EmailDraftCard.handleSendClick',message:'EmailDraftCard handleSendClick called',data:{subject,body,initialSubject,initialBody,subjectChanged:subject!==initialSubject,bodyChanged:body!==initialBody,isSending},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    try {
      await onSend(subject, body)
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT1B',location:'AgentWorkspace.tsx:EmailDraftCard.handleSendClick',message:'EmailDraftCard onSend completed',data:{},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    } catch (err) {
      // #region agent log
      fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT1C',location:'AgentWorkspace.tsx:EmailDraftCard.handleSendClick',message:'EmailDraftCard onSend error',data:{error:err instanceof Error?err.message:String(err)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      throw err
    }
  }

  return (
    <div className="bg-surface border border-border/70 rounded-2xl shadow-soft overflow-hidden my-4 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/70">
        <span className="text-sm text-text-muted">Email</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="p-2 hover:bg-surface-2/50 rounded-lg transition-colors"
            title="Copy to clipboard"
            type="button"
          >
            {copied ? (
              <Check className="w-4 h-4 text-success" />
            ) : (
              <Copy className="w-4 h-4 text-text-muted" />
            )}
          </button>
          <button
            onClick={(e) => {
              // #region agent log
              fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT0',location:'AgentWorkspace.tsx:EmailDraftCard.button.onClick',message:'Send button clicked',data:{isSending,disabled:isSending},timestamp:Date.now()})}).catch(()=>{});
              // #endregion
              if (!isSending) {
                handleSendClick().catch((err) => {
                  // #region agent log
                  fetch(__DEBUG_INGEST,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:__DEBUG_SESSION,runId:'edit-trace',hypothesisId:'EDIT0B',location:'AgentWorkspace.tsx:EmailDraftCard.button.onClick',message:'Send button handler error',data:{error:err instanceof Error?err.message:String(err)},timestamp:Date.now()})}).catch(()=>{});
                  // #endregion
                  console.error('[EmailDraftCard] Send failed:', err)
                })
              }
            }}
            disabled={isSending}
            className="p-2 hover:bg-surface-2/50 rounded-lg transition-colors disabled:opacity-50"
            title="Send email"
            type="button"
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 text-text-muted animate-spin" />
            ) : (
              <Send className="w-4 h-4 text-text-muted" />
            )}
          </button>
        </div>
      </div>

      {/* To field (read-only) */}
      <div className="px-4 py-2 border-b border-border/70 text-xs text-text-subtle">
        To: {to}
      </div>

      {/* Subject */}
      <div className="px-4 py-3 border-b border-border/70">
        <div className="text-xs text-text-subtle mb-1">Subject</div>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full bg-transparent text-text text-sm focus:outline-none placeholder:text-text-subtle"
          placeholder="Email subject"
        />
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full bg-transparent text-text text-sm focus:outline-none placeholder:text-text-subtle resize-none min-h-[200px] leading-relaxed font-mono"
          placeholder="Email body"
        />
      </div>
    </div>
  )
}

// Message bubble component
function MessageBubble({ message }: { message: AckMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  return (
    <div className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isUser ? 'bg-surface-2' : isSystem ? 'bg-warning/10' : 'bg-primary-deep/10'
      }`}>
        {isUser ? (
          <User className="w-4 h-4 text-text-muted" />
        ) : isSystem ? (
          <AlertCircle className="w-4 h-4 text-warning" />
        ) : (
          <Sparkles className="w-4 h-4 text-primary-deep" />
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block max-w-[90%] px-4 py-2.5 rounded-xl ${
          isUser 
            ? 'bg-primary-deep text-white' 
            : 'bg-surface-2/70 text-text'
        }`}>
          <div className="text-sm whitespace-pre-wrap">
            {formatMessageContent(message.content)}
          </div>
        </div>
        <div className="text-[10px] text-text-subtle mt-1 px-1">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

// Missing supplier email prompt component
function MissingSupplierEmailPrompt({
  candidates,
  onSelectCandidate,
  onEnterCustom,
  customEmailInput,
  setCustomEmailInput,
  showCustomEmailInput,
  setShowCustomEmailInput,
  isSaving,
}: {
  candidates: Array<{ email: string; label: string; messageId: string; threadId: string | null }>
  onSelectCandidate: (email: string) => void
  onEnterCustom: (email: string) => void
  customEmailInput: string
  setCustomEmailInput: (value: string) => void
  showCustomEmailInput: boolean
  setShowCustomEmailInput: (show: boolean) => void
  isSaving: boolean
}) {
  const handleSaveCustom = () => {
    if (customEmailInput.trim()) {
      onEnterCustom(customEmailInput.trim())
    }
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-lg bg-primary-deep/10 flex items-center justify-center flex-shrink-0">
        <Sparkles className="w-4 h-4 text-primary-deep" />
      </div>
      <div className="flex-1">
        <div className="inline-block max-w-[90%] px-4 py-2.5 rounded-xl bg-surface-2/70 text-text">
          <div className="text-sm mb-3">
            {candidates.length > 0 && 'Which one should I use?'}
            {candidates.length === 0 && 'Please provide a supplier email address or domain.'}
          </div>
          
          {candidates.length > 0 && (
            <div className="flex flex-col gap-2 mb-3">
              {candidates.map((candidate) => (
                <button
                  key={candidate.email}
                  onClick={() => !isSaving && onSelectCandidate(candidate.email)}
                  disabled={isSaving}
                  className="text-left px-3 py-2 text-xs font-medium rounded-lg bg-white border border-border/50 hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <div className="font-medium text-text">Use {candidate.email}</div>
                  <div className="text-text-subtle text-[10px] mt-0.5">{candidate.label}</div>
                </button>
              ))}
            </div>
          )}
          
          {showCustomEmailInput ? (
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={customEmailInput}
                onChange={(e) => setCustomEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customEmailInput.trim()) {
                    handleSaveCustom()
                  }
                }}
                placeholder="Enter email or @domain"
                disabled={isSaving}
                className="px-3 py-2 text-xs border border-border/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-deep/20 focus:border-primary-deep/50 disabled:opacity-50"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveCustom}
                  disabled={!customEmailInput.trim() || isSaving}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary-deep text-white hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setShowCustomEmailInput(false)
                    setCustomEmailInput('')
                  }}
                  disabled={isSaving}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-2 text-text hover:bg-surface-2/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowCustomEmailInput(true)}
              disabled={isSaving}
              className="px-3 py-2 text-xs font-medium rounded-lg bg-surface-2 text-text hover:bg-surface-2/80 border border-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Enter a different email
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Simple markdown-like formatting
function formatMessageContent(content: string): React.ReactNode {
  // Split by bold markers and inline code
  const parts = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={idx} className="bg-black/10 px-1 py-0.5 rounded text-xs">{part.slice(1, -1)}</code>
    }
    return part
  })
}
