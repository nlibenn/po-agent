'use client'

import { useState, useEffect, useRef } from 'react'
import { MessageCircle, Send, Copy, Trash2, Loader2, X, Sparkles } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { useChat } from './chat/ChatProvider'
import { useChatScope } from './chat/useChatScope'
import { normalizeRow, deriveExceptions, NormalizedPORow } from '@/src/lib/po'

// Helper to extract compact fields from normalized row
function extractCompactFields(row: NormalizedPORow): any {
  return {
    po_id: row.po_id,
    line_id: row.line_id,
    part_num: row.part_num,
    description: row.description,
    order_qty: row.order_qty,
    unit_price: row.unit_price,
    due_date: row.due_date ? row.due_date.toISOString().split('T')[0] : null,
    receipt_date: row.receipt_date,
    line_open: row.line_open,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
  }
}

// Helper to calculate simple text similarity
function calculateSimilarity(desc1: string, desc2: string): number {
  if (!desc1 || !desc2) return 0
  const tokens1 = new Set(desc1.toLowerCase().split(/\s+/))
  const tokens2 = new Set(desc2.toLowerCase().split(/\s+/))
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)))
  const union = new Set([...tokens1, ...tokens2])
  return union.size > 0 ? intersection.size / union.size : 0
}

export function CompanionChat() {
  const [isExpanded, setIsExpanded] = useState(false)
  const [input, setInput] = useState('')
  const { messages, addMessage, clearMessages, isLoading, setIsLoading } = useChat()
  const scope = useChatScope()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (isExpanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isLoading, isExpanded])

  // Close on outside click when expanded
  useEffect(() => {
    if (!isExpanded) return

    const handleClickOutside = (event: MouseEvent) => {
      if (widgetRef.current && !widgetRef.current.contains(event.target as Node)) {
        setIsExpanded(false)
      }
    }

    // Delay to avoid immediate close on open click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isExpanded])

  // Get context info
  const [contextInfo, setContextInfo] = useState<{
    filename?: string
  }>({})

  useEffect(() => {
    const updateContext = () => {
      try {
        const filename = sessionStorage.getItem('po_filename') || undefined
        setContextInfo({ filename })
      } catch (e) {
        // Ignore errors
      }
    }
    updateContext()
    const interval = setInterval(updateContext, 2000)
    return () => clearInterval(interval)
  }, [])

  const sendMessage = async (userMessage: string) => {
    if (!userMessage.trim() || isLoading) return

    addMessage({ role: 'user', content: userMessage })
    setIsLoading(true)

    try {
      if (scope.type === 'case' && scope.id) {
        // Case-scoped: call /api/resolve
        const storedData = sessionStorage.getItem('po_rows')
        if (!storedData) {
          addMessage({
            role: 'assistant',
            content: 'No CSV data found. Please upload a CSV file first.',
          })
          setIsLoading(false)
          return
        }

        const rawRows = JSON.parse(storedData) as Record<string, any>[]
        const normalizedRows = rawRows.map(row => normalizeRow(row))
        const matchingRow = normalizedRows.find(row => `${row.po_id}-${row.line_id}` === scope.id)

        if (!matchingRow) {
          addMessage({
            role: 'assistant',
            content: 'Case not found in uploaded data.',
          })
          setIsLoading(false)
          return
        }

        // Build context arrays
        const currentId = `${matchingRow.po_id}-${matchingRow.line_id}`
        const supplierHistory = normalizedRows
          .filter(row => 
            row.supplier_id && 
            row.supplier_id === matchingRow.supplier_id &&
            `${row.po_id}-${row.line_id}` !== currentId
          )
          .slice(0, 30)
          .map(extractCompactFields)

        const partHistory = normalizedRows
          .filter(row => 
            row.part_num && 
            row.part_num === matchingRow.part_num &&
            `${row.po_id}-${row.line_id}` !== currentId
          )
          .slice(0, 30)
          .map(extractCompactFields)

        const similarLines = normalizedRows
          .filter(row => {
            const rowId = `${row.po_id}-${row.line_id}`
            if (rowId === currentId) return false
            if (!row.supplier_id || row.supplier_id !== matchingRow.supplier_id) return false
            if (!row.description || !matchingRow.description) return false
            return calculateSimilarity(row.description, matchingRow.description) > 0.2
          })
          .sort((a, b) => {
            const simA = calculateSimilarity(a.description, matchingRow.description)
            const simB = calculateSimilarity(b.description, matchingRow.description)
            return simB - simA
          })
          .slice(0, 20)
          .map(extractCompactFields)

        const response = await fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            case: extractCompactFields(matchingRow),
            supplier_history: supplierHistory,
            part_history: partHistory,
            similar_lines: similarLines,
            user_message: userMessage,
          }),
        })

        if (!response.ok) {
          throw new Error(`API error: ${response.statusText}`)
        }

        const data = await response.json()
        addMessage({ role: 'assistant', content: data.answer })
      } else {
        // Global mode: call API with CSV data
        const storedData = sessionStorage.getItem('po_rows')
        if (!storedData) {
          addMessage({
            role: 'assistant',
            content: 'Upload a CSV file first to enable analysis. Go to the home page to upload your data.',
          })
          setIsLoading(false)
          return
        }

        const rawRows = JSON.parse(storedData) as Record<string, any>[]
        const normalizedRows = rawRows.map(row => normalizeRow(row))
        
        // Check if asking case-specific question
        const lowerQuestion = userMessage.toLowerCase()
        if (lowerQuestion.includes('this case') || lowerQuestion.includes('this po') || lowerQuestion.includes('this line')) {
          addMessage({
            role: 'assistant',
            content: 'To ask questions about a specific case, please open an exception detail page first. Then I can help you with case-specific questions.',
          })
          setIsLoading(false)
          return
        }

        // Determine if dataset is small or large
        const isSmallDataset = normalizedRows.length < 100
        
        let requestBody: any
        
        if (isSmallDataset) {
          // Small dataset: send all rows
          const compactRows = normalizedRows.map(row => extractCompactFields(row))
          requestBody = {
            rows: compactRows,
            user_message: userMessage,
          }
        } else {
          // Large dataset: send exceptions + schema summary
          const today = new Date()
          const exceptions = deriveExceptions(normalizedRows, today)
          const compactExceptions = exceptions.map(ex => extractCompactFields(ex.rowData))
          
          // Build exception breakdown
          const exceptionBreakdown: Record<string, number> = {}
          exceptions.forEach(ex => {
            if (ex.exception_type) {
              exceptionBreakdown[ex.exception_type] = (exceptionBreakdown[ex.exception_type] || 0) + 1
            }
          })
          
          // Get column names from first row
          const columnNames = rawRows.length > 0 ? Object.keys(rawRows[0]) : []
          
          requestBody = {
            exceptions: compactExceptions,
            schema_summary: {
              total_rows: normalizedRows.length,
              total_exceptions: exceptions.length,
              exception_breakdown: exceptionBreakdown,
              column_names: columnNames,
            },
            user_message: userMessage,
          }
        }

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        })

        if (!response.ok) {
          throw new Error(`API error: ${response.statusText}`)
        }

        const data = await response.json()
        addMessage({ role: 'assistant', content: data.answer })
      }
    } catch (error) {
      console.error('Error sending message:', error)
      addMessage({
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to get response'}`,
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleSend = async () => {
    if (!input.trim() || isLoading) return
    const userMessage = input.trim()
    setInput('')
    await sendMessage(userMessage)
  }

  const handleQuickPrompt = (prompt: string) => {
    sendMessage(prompt)
  }

  const handleCopyLast = () => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (lastAssistant) {
      navigator.clipboard.writeText(lastAssistant.content)
    }
  }

  const caseQuickPrompts = [
    "What's risky here?",
    "Explain the risk",
    "What should I do?",
  ]

  const globalQuickPrompts = [
    "Summarize flagged POs",
    "Suppliers with highest risk",
    "Most common risk patterns",
  ]

  const quickPrompts = scope.type === 'case' ? caseQuickPrompts : globalQuickPrompts

  return (
    <div
      ref={widgetRef}
      className={`companion-widget fixed bottom-6 right-6 z-50 transition-all duration-200 ${
        isExpanded ? 'companion-widget-expanded' : ''
      }`}
    >
      {/* Compact widget state */}
      {!isExpanded && (
        <button
          onClick={() => setIsExpanded(true)}
          className="flex items-center gap-2 px-4 py-3 bg-neutral-900 hover:bg-neutral-800 text-white rounded-lg shadow-lg hover:shadow-xl transition-all duration-200 group"
          aria-label="Open Companion Chat"
        >
          <Sparkles className="h-4 w-4" />
          <span className="text-sm font-medium">PO Risk Copilot</span>
        </button>
      )}

      {/* Expanded chat window */}
      {isExpanded && (
        <div className="bg-white rounded-2xl shadow-2xl border border-neutral-200 w-[380px] h-[600px] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex-shrink-0 px-4 py-3 border-b border-neutral-200 bg-white">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-start gap-2.5 flex-1 min-w-0">
                <div className="p-1 bg-neutral-900 rounded-lg flex-shrink-0 mt-0.5">
                  <Sparkles className="h-3.5 w-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-neutral-900 leading-tight">PO Risk Copilot</h3>
                  <p className="text-xs text-neutral-500 leading-tight mt-1">Continuously reviewing purchase orders for inconsistencies and risk.</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCopyLast}
                      disabled={!messages.some(m => m.role === 'assistant')}
                      className="h-7 w-7 p-0 text-neutral-500 hover:text-neutral-700"
                      title="Copy last response"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={clearMessages}
                      className="h-7 w-7 p-0 text-neutral-500 hover:text-neutral-700"
                      title="Clear chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsExpanded(false)}
                  className="h-7 w-7 p-0 text-neutral-500 hover:text-neutral-700"
                  title="Minimize"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            
            {/* Context badges */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              <Badge variant={scope.type === 'case' ? 'default' : 'outline'} className="text-xs px-1.5 py-0.5 h-5">
                {scope.type === 'case' ? `Case` : 'Global'}
              </Badge>
              {contextInfo?.filename && (
                <Badge variant="outline" className="text-xs px-1.5 py-0.5 h-5 text-neutral-600">
                  {contextInfo.filename.length > 15 ? `${contextInfo.filename.substring(0, 15)}...` : contextInfo.filename}
                </Badge>
              )}
            </div>
          </div>

          {/* Messages area - scrollable */}
          <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0 bg-neutral-50">
            <div className="space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-8">
                  <div className="w-10 h-10 mx-auto mb-3 rounded-lg bg-neutral-100 flex items-center justify-center">
                    <MessageCircle className="h-5 w-5 text-neutral-600" />
                  </div>
                  
                  {/* Quick prompt chips */}
                  <div className="flex flex-wrap gap-1.5 justify-center">
                    {quickPrompts.map((prompt, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleQuickPrompt(prompt)}
                        className="px-2.5 py-1 text-xs font-medium text-neutral-700 bg-white hover:bg-neutral-50 rounded-lg border border-neutral-200 transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 ${
                      msg.role === 'user'
                        ? 'bg-neutral-900 text-white'
                        : 'bg-white text-neutral-800 border border-neutral-200'
                    }`}
                  >
                    <div className="text-xs whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                  </div>
                </div>
              ))}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-white border border-neutral-200 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <Loader2 className="h-3 w-3 animate-spin text-neutral-600" />
                      <span>Analyzing...</span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Quick prompts (when messages exist) */}
          {messages.length > 0 && (
            <div className="flex-shrink-0 px-4 py-2 border-t border-neutral-100 bg-white">
              <div className="flex flex-wrap gap-1.5">
                {quickPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleQuickPrompt(prompt)}
                    disabled={isLoading}
                    className="px-2 py-0.5 text-xs font-medium text-neutral-600 bg-neutral-50 hover:bg-neutral-100 rounded-lg border border-neutral-200 transition-colors disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input area - sticky at bottom */}
          <div className="flex-shrink-0 px-4 py-3 border-t border-neutral-200 bg-white">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                placeholder="Ask about a flagged PO, supplier, or risk…"
                className="flex-1 text-xs border border-neutral-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900 bg-neutral-50 placeholder:text-neutral-400"
                rows={2}
                disabled={isLoading}
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                size="sm"
                className="px-3 bg-neutral-900 hover:bg-neutral-800 rounded-lg"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
