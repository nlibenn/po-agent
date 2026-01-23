'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Loader2, Bot, User, AlertCircle, Sparkles, Play, Mail, CheckSquare } from 'lucide-react'
import { useAckChat, AckMessage } from './AcknowledgementChatProvider'
import { useAgentState } from './AgentStateContext'
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
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastAgentResultRef = useRef<AgentResult | null>(null)
  const [customEmailInput, setCustomEmailInput] = useState('')
  const [showCustomEmailInput, setShowCustomEmailInput] = useState(false)
  const [isSavingEmail, setIsSavingEmail] = useState(false)
  const [caseState, setCaseState] = useState<{
    case_id: string
    po_number: string
    line_id: string
    supplier_name: string | null
    state: string
    status?: string
    next_check_at: number | null
    updated_at: number
    meta: any
    missing_fields?: string[]
  } | null>(null)

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
    setCaseState(null)
    // Reset task when case changes
    agentState.setCurrentTask(poNumber || '', lineId || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, setCaseId, poNumber, lineId])

  // Poll case state - FIXED: Use refs to prevent overlapping intervals
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const isPollingRef = useRef(false)
  const lastFetchTimeRef = useRef(0)

  useEffect(() => {
    // Don't poll when no case selected - stop any existing polling and return immediately
    if (!caseId) {
      // Clean up any existing polling
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      isPollingRef.current = false
      // Don't call setCaseState(null) here - avoid state updates when no case
      return
    }

    // Prevent multiple intervals
    if (isPollingRef.current) {
      return
    }

    const pollCase = async () => {
      // Request deduplication: skip if fetched within last second
      const now = Date.now()
      if (now - lastFetchTimeRef.current < 1000) {
        return
      }
      lastFetchTimeRef.current = now

      try {
        const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}`)
        if (response.ok) {
          const data = await response.json()
          setCaseState(data)
        }
      } catch (error) {
        console.error('Error polling case state:', error)
      }
    }

    // Initial poll
    pollCase()

    // Start polling with appropriate interval
    isPollingRef.current = true
    const interval = isLoading ? 2000 : 10000
    pollIntervalRef.current = setInterval(pollCase, interval)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      isPollingRef.current = false
    }
  }, [caseId, isLoading])

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
  
  // Context-aware prompt suggestions
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([])
  const [inputHasFocus, setInputHasFocus] = useState(false)
  const [suggestionClicked, setSuggestionClicked] = useState(false)
  
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
  const sendEmail = useCallback(async (): Promise<string> => {
    const draft = lastAgentResultRef.current?.drafted_email
    if (!draft) {
      return '❌ No draft available. Run the agent first.'
    }

    if (!caseId) {
      return '❌ No case selected.'
    }

    onRunningChange(true)

    try {
      const response = await fetch('/api/confirmations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId,
          subject: draft.subject,
          body: draft.body,
          threadId: draft.threadId || lastAgentResultRef.current?.evidence_summary?.thread_id,
          supplierEmail: draft.to,
          forceSend: true,
          intent: draft.threadId ? 'followup' : 'initial',
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `Send failed: ${response.status}`)
      }

      const result = await response.json()

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
          console.error('Failed to refresh agent state after send:', e)
        }
      }, 500)

      return `✅ **Email sent!**\n\nTo: ${draft.to}\nSubject: "${draft.subject}"\n\nMessage ID: \`${result.gmailMessageId || result.messageId || 'N/A'}\``
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return `❌ **Send failed**: ${errorMessage}`
    } finally {
      onRunningChange(false)
    }
  }, [caseId, onAgentResult, onRunningChange])

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
              
              // Add message showing orchestrator result
              const { decision } = refreshResult
              let responseText = `**Agent completed** (${decision.action_type})\n\n`
              responseText += `${decision.reason}\n\n`
              
              if (refreshResult.drafted_email) {
                responseText += `📝 **Draft ready**: "${refreshResult.drafted_email.subject}"\n`
              }
              
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
      
      // Add assistant response to chat
        addMessage({
          role: 'assistant',
        content: assistantResponse,
      })

      // Update conversation history state
      setConversationHistory(prev => [...prev, { 
        role: 'assistant', 
        content: assistantResponse
      }])
      
      // Reset suggestion clicked flag when agent responds
      setSuggestionClicked(false)
      
      // Update suggestions after assistant responds
      setTimeout(() => {
        const newPrompts = getSuggestedPrompts()
        setSuggestedPrompts(newPrompts)
      }, 100)

      // If tools were used, update task steps and agent result
      if (result.tool_calls && result.tool_calls.length > 0) {
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
          if (lastAgentResultRef.current) {
            lastAgentResultRef.current.drafted_email = {
              subject: draft.subject,
              body: draft.body,
              to: draft.to,
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
                to: draft.to,
                threadId: draft.thread_id,
                demoModeActive: draft.demo_mode,
                demoModeMessage: draft.demo_warning,
              },
              requires_user_approval: true,
            }
          }
          onAgentResult(lastAgentResultRef.current)
        }
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
  }, [caseId, conversationHistory, addMessage, setIsLoading, onRunningChange, onAgentResult])

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

  // Determine which action chips to show
  // Quick action chips - always show these shortcuts
  const showApplyChip = !!(
    lastAgentResultRef.current?.decision?.action_type === 'APPLY_UPDATES_READY' ||
    (lastAgentResultRef.current?.extracted_fields_best && (
      lastAgentResultRef.current.extracted_fields_best.supplier_order_number?.value ||
      lastAgentResultRef.current.extracted_fields_best.confirmed_delivery_date?.value ||
      lastAgentResultRef.current.extracted_fields_best.confirmed_quantity?.value !== null
    ))
  )

  // Generate context-aware prompt suggestions
  const getSuggestedPrompts = useCallback((): string[] => {
    if (!caseId) {
      return []
    }

    // Determine case state
    const caseStateValue = caseState?.state
    const missingFields = caseState?.missing_fields || []
    const isResolved = caseStateValue === CaseState.RESOLVED
    const isConfirmed = isResolved || (missingFields.length === 0 && caseStateValue !== CaseState.INBOX_LOOKUP)
    const isOutreachSent = caseStateValue === CaseState.OUTREACH_SENT || 
                          caseStateValue === CaseState.FOLLOWUP_SENT
    
    if (isConfirmed || isResolved) {
      // Case is complete - show view/export options instead
      return ['View confirmation details', 'Export confirmation data']
    }

    const lastMessage = messages[messages.length - 1]
    const agentLastSaid = lastMessage?.role === 'assistant' ? lastMessage.content : ''
    
    // Just selected PO, no conversation yet
    if (messages.length === 0 || (messages.length === 1 && messages[0].role === 'system')) {
      if (isOutreachSent) {
        return ['Check for supplier reply', 'Send follow-up email']
      }
      return ['Check if we have confirmation', 'What information is missing?']
    }
    
    // Agent asked if you want to draft
    if (agentLastSaid.includes('Would you like me to draft') || agentLastSaid.includes('want me to draft')) {
      return ['Yes, please draft it', 'Not right now']
    }
    
    // Agent drafted an email
    if (agentLastSaid.includes('Subject:') || agentLastSaid.includes("I've drafted") || lastAgentResultRef.current?.drafted_email) {
      return ['Send it', 'Change the subject', 'Start over']
    }
    
    // Agent found partial data (has ✗ indicators)
    if (agentLastSaid.includes('✗')) {
      return ['Draft email for missing fields', 'Mark as complete anyway']
    }
    
    // Default fallback
    if (isOutreachSent) {
      return ['Check for supplier reply', 'Send follow-up email']
    }
    return ['Check confirmation status', 'Draft an email']
  }, [caseId, messages, caseState])

  // Update suggestions when conversation changes
  useEffect(() => {
    if (!isLoading && !suggestionClicked) {
      const newPrompts = getSuggestedPrompts()
      setSuggestedPrompts(newPrompts)
      // Reset suggestion clicked flag when agent responds
      if (messages.length > 0 && messages[messages.length - 1]?.role === 'assistant') {
        setSuggestionClicked(false)
      }
    }
  }, [messages.length, isLoading, getSuggestedPrompts, suggestionClicked])

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
      <div className="flex-shrink-0 px-6 py-3 border-b border-border/50 bg-surface">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary-deep/10 flex items-center justify-center">
            <Bot className="w-4 h-4 text-primary-deep" />
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
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-text-muted mb-3">
                Ask me anything about this PO
              </p>
              <p className="text-xs text-text-subtle">
                Try: "Check for supplier responses" or "What's the delivery date?"
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            
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

      {/* Action chips + Input */}
      <div className="flex-shrink-0 border-t border-border/50 bg-surface">
        {/* Quick action chips */}
        {caseId && (() => {
          // Determine which buttons to show based on case state
          const caseStateValue = caseState?.state
          const missingFields = caseState?.missing_fields || []
          const isResolved = caseStateValue === CaseState.RESOLVED
          const isConfirmed = isResolved || (missingFields.length === 0 && caseStateValue !== CaseState.INBOX_LOOKUP)
          const isOutreachSent = caseStateValue === CaseState.OUTREACH_SENT || 
                                caseStateValue === CaseState.FOLLOWUP_SENT
          const needsOutreach = caseStateValue === CaseState.INBOX_LOOKUP || 
                               caseStateValue === CaseState.WAITING ||
                               caseStateValue === CaseState.PARSED
          
          // Hide action buttons if case is confirmed/resolved
          if (isConfirmed || isResolved) {
            return null // Don't show action buttons for completed cases
          }
          
          // Show different buttons based on state
          const showCheckConfirmation = !isOutreachSent && needsOutreach
          const showDraftEmail = needsOutreach
          const showCheckReply = isOutreachSent
          const showFollowUp = isOutreachSent
          
          return (
            <div className="px-6 pt-3 pb-2 flex gap-2 flex-wrap">
              {showCheckConfirmation && (
                <button
                  onClick={() => handleUserInput('Check if we have confirmation for this PO')}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-2 text-text hover:bg-surface-2/80 border border-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Play className="w-3 h-3" />
                  Check confirmation
                </button>
              )}
              {showDraftEmail && (
                <button
                  onClick={() => handleUserInput('Draft an email requesting missing information')}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-2 text-text hover:bg-surface-2/80 border border-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Mail className="w-3 h-3" />
                  Draft email
                </button>
              )}
              {showCheckReply && (
                <button
                  onClick={() => handleUserInput('Check for supplier reply')}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-2 text-text hover:bg-surface-2/80 border border-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Play className="w-3 h-3" />
                  Check for reply
                </button>
              )}
              {showFollowUp && (
                <button
                  onClick={() => handleUserInput('Send follow-up email')}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-2 text-text hover:bg-surface-2/80 border border-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Mail className="w-3 h-3" />
                  Send follow-up
                </button>
              )}
              {showApplyChip && (
                <button
                  onClick={() => handleUserInput('Please apply the extracted fields to the confirmation record')}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-success/10 text-success hover:bg-success/20 border border-success/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <CheckSquare className="w-3 h-3" />
                  Apply updates
                </button>
              )}
            </div>
          )
        })()}

        {/* Context-aware prompt suggestions */}
        {suggestedPrompts.length > 0 && !isLoading && (
          <div className="px-6 pt-2 pb-2 flex gap-2 flex-wrap">
            {suggestedPrompts.map((prompt, index) => (
              <button
                key={index}
                onClick={() => handleUserInput(prompt)}
                className="px-3 py-1 text-xs font-medium rounded-full bg-surface-2 text-text hover:bg-surface-2/80 border border-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {/* Text input */}
        <div className="px-6 pb-4 flex gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputHasFocus(true)}
            onBlur={() => setInputHasFocus(false)}
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

        {/* Context-aware prompt suggestions - below input */}
        {suggestedPrompts.length > 0 && !isLoading && !inputHasFocus && !suggestionClicked && (
          <div className="px-6 pb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-text-subtle">Suggested:</span>
              {suggestedPrompts.map((prompt, index) => (
                <button
                  key={index}
                  onClick={() => {
                    setSuggestionClicked(true)
                    handleUserInput(prompt)
                  }}
                  className="px-2.5 py-1 text-xs text-text-muted rounded-full bg-gray-100 hover:bg-gray-200 border border-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
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
          <Bot className="w-4 h-4 text-primary-deep" />
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
        <Bot className="w-4 h-4 text-primary-deep" />
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
