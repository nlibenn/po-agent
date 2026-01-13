'use client'

import { useState, useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import { generateEmailDraft } from '@/app/actions/supplierOutreach'
import type { SupplierChaseCase, SupplierChaseEvent, SupplierChaseMessage } from '@/src/lib/supplier-agent/types'
import type { ConfirmationEmailParams } from '@/src/lib/supplier-agent/emailDraft'
import { summarizeAgentEvents, isErrorEvent } from '@/src/lib/supplier-agent/eventSummarizer'
import { formatRelativeTime, formatTimestampWithRelative } from '@/src/lib/utils/relativeTime'
import { Disclosure } from '@/components/ui/disclosure'

interface SupplierConfirmationDrawerProps {
  open: boolean
  onClose: () => void
  poNumber: string
  lineId: string
  supplierName?: string
  supplierEmail: string
}

interface CaseDetails {
  case: SupplierChaseCase
  events: SupplierChaseEvent[]
  messages: SupplierChaseMessage[]
}

export function SupplierConfirmationDrawer({
  open,
  onClose,
  poNumber,
  lineId,
  supplierName,
  supplierEmail,
}: SupplierConfirmationDrawerProps) {
  const [loading, setLoading] = useState(false)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('Unconfirmed')
  const [missingFields, setMissingFields] = useState<string[]>(['delivery_date'])
  const [events, setEvents] = useState<SupplierChaseEvent[]>([])
  const [emailDraft, setEmailDraft] = useState<{ subject: string; bodyText: string } | null>(null)
  const [lastSendResult, setLastSendResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sentEmail, setSentEmail] = useState<{ subject: string; bodyText: string; timestamp: number } | null>(null)

  // Load case data when drawer opens
  useEffect(() => {
    if (!open) return

    const loadData = async () => {
      setLoading(true)
      setError(null)

      try {
        // 1. Upsert case
        const upsertResponse = await fetch('/api/confirmations/case/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            poNumber,
            lineId,
            supplierName,
            supplierEmail,
            missingFields: ['delivery_date', 'supplier_reference'],
          }),
        })

        if (!upsertResponse.ok) {
          throw new Error('Failed to create/load case')
        }

        const { caseId: newCaseId, case: caseData } = await upsertResponse.json()
        setCaseId(newCaseId)
        let currentMissingFields = caseData.missing_fields || ['delivery_date']
        setMissingFields(currentMissingFields)

        // 2. Run inbox search
        const searchResponse = await fetch('/api/confirmations/inbox-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caseId: newCaseId,
          }),
        })

        if (searchResponse.ok) {
          const searchResult = await searchResponse.json()
          
          // Update missing fields based on search result
          if (searchResult.missingFields !== undefined) {
            currentMissingFields = searchResult.missingFields
            setMissingFields(currentMissingFields)
          }

          // Update status based on classification
          if (searchResult.classification === 'FOUND_CONFIRMED') {
            setStatus('No action needed')
          } else if (searchResult.classification === 'FOUND_INCOMPLETE') {
            setStatus('Unconfirmed')
          } else {
            setStatus('Unconfirmed')
          }
        }

        // 3. Fetch case details (events, messages)
        const detailsResponse = await fetch(`/api/confirmations/case/${newCaseId}`)
        if (detailsResponse.ok) {
          const details: CaseDetails = await detailsResponse.json()
          setEvents(details.events || [])
          
          // Update status if outreach was sent
          if (details.case.state === 'OUTREACH_SENT') {
            setStatus('Outreach sent')
            
            // Find the most recent sent email from messages
            const sentMessages = details.messages
              ?.filter(m => m.direction === 'OUTBOUND')
              .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))
            
            if (sentMessages && sentMessages.length > 0) {
              const mostRecent = sentMessages[0]
              setSentEmail({
                subject: mostRecent.subject || '',
                bodyText: mostRecent.body_text || '',
                timestamp: mostRecent.received_at || mostRecent.created_at,
              })
            }
          }
        }

        // 4. Generate email preview with current missing fields
        const draft = await generateEmailDraft({
          poNumber,
          lineId,
          supplierName,
          supplierEmail,
          missingFields: currentMissingFields,
        })
        setEmailDraft(draft)
      } catch (err) {
        console.error('Error loading drawer data:', err)
        setError(err instanceof Error ? err.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [open, poNumber, lineId, supplierName, supplierEmail])

  // Regenerate email draft when missingFields change
  useEffect(() => {
    if (missingFields.length > 0 && poNumber && lineId && supplierEmail) {
      generateEmailDraft({
        poNumber,
        lineId,
        supplierName,
        supplierEmail,
        missingFields,
      }).then(draft => {
        setEmailDraft(draft)
      }).catch(err => {
        console.error('Error generating email draft:', err)
      })
    }
  }, [missingFields, poNumber, lineId, supplierName, supplierEmail])

  const handleSend = async () => {
    if (!caseId) return

    setSending(true)
    setError(null)

    try {
      const response = await fetch('/api/confirmations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId,
          poNumber,
          lineId,
          supplierEmail,
          supplierName,
          missingFields,
          runInboxSearch: true,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to send email')
      }

      const result = await response.json()
      setLastSendResult(result)

      // Update status based on action
      if (result.action === 'NO_OP') {
        setStatus('No action needed')
      } else {
        setStatus('Outreach sent')
        // Store sent email details
        if (emailDraft) {
          setSentEmail({
            subject: emailDraft.subject,
            bodyText: emailDraft.bodyText,
            timestamp: Date.now(),
          })
        }
      }

      // Refresh case details
      const detailsResponse = await fetch(`/api/confirmations/case/${caseId}`)
      if (detailsResponse.ok) {
        const details: CaseDetails = await detailsResponse.json()
        setEvents(details.events || [])
        
        // Find the most recent sent email from messages
        const sentMessages = details.messages
          ?.filter(m => m.direction === 'OUTBOUND')
          .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))
        
        if (sentMessages && sentMessages.length > 0) {
          const mostRecent = sentMessages[0]
          setSentEmail({
            subject: mostRecent.subject || emailDraft?.subject || '',
            bodyText: mostRecent.body_text || emailDraft?.bodyText || '',
            timestamp: mostRecent.received_at || mostRecent.created_at,
          })
        }
      }
    } catch (err) {
      console.error('Error sending email:', err)
      setError(err instanceof Error ? err.message : 'Failed to send email')
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  // Summarize events into milestones
  const milestones = useMemo(() => summarizeAgentEvents(events, poNumber), [events, poNumber])
  
  // Separate error events for technical details
  const errorEvents = useMemo(() => events.filter(isErrorEvent), [events])
  const hasTechnicalDetails = errorEvents.length > 0 || events.length > milestones.length

  // Get status with relative time
  const getStatusWithTime = () => {
    if (status === 'Outreach sent' && caseId) {
      // Find the most recent EMAIL_SENT event
      const emailSentEvent = events
        .filter(e => e.event_type === 'EMAIL_SENT')
        .sort((a, b) => b.timestamp - a.timestamp)[0]
      
      if (emailSentEvent) {
        return `${status} · ${formatRelativeTime(emailSentEvent.timestamp)}`
      }
    }
    return status
  }

  // Check if we're awaiting supplier response
  const isAwaitingResponse = useMemo(() => {
    if (status !== 'Outreach sent') return false
    // Check if we have a reply
    const hasReply = events.some(e => e.event_type === 'REPLY_RECEIVED')
    return !hasReply
  }, [status, events])

  const formatTimestamp = (timestamp: number) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(timestamp))
  }

  const getEventTypeLabel = (eventType: string) => {
    return eventType
      .split('_')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ')
  }

  const canSend = status !== 'No action needed' && status !== 'Outreach sent' && !loading && emailDraft

  return (
    <>
      {/* Backdrop - Light scrim for visual reference, prevents interaction */}
      <div 
        className="fixed inset-0 bg-black/5 z-30 pointer-events-auto" 
        onClick={onClose}
        style={{ pointerEvents: 'auto' }}
      />

      {/* Side Panel */}
      <div className="fixed inset-y-0 right-0 w-[600px] bg-white/95 shadow-2xl z-40 flex flex-col border-l border-neutral-200/30">
        {/* Header */}
        <div className="flex-shrink-0 px-8 py-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold text-neutral-800">Supplier Confirmation</h2>
            <button
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-neutral-100/50 transition-colors"
            >
              <X className="w-5 h-5 text-neutral-600" />
            </button>
          </div>
          <div className="text-sm text-neutral-600">
            PO {poNumber} · Line {lineId}
          </div>
          <div className="text-xs text-neutral-500 mt-1">{supplierEmail}</div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-8 pb-6 space-y-6">
          {loading ? (
            <div className="text-center py-12 text-neutral-500">Loading...</div>
          ) : error ? (
            <div className="bg-neutral-100/80 rounded-xl p-4 text-sm text-neutral-700">
              Error: {error}
            </div>
          ) : (
            <>
              {/* Status */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">
                    Status
                  </span>
                  <span className="px-3 py-1.5 rounded-full text-sm font-medium bg-neutral-100 text-neutral-800">
                    {getStatusWithTime()}
                  </span>
                </div>
                {isAwaitingResponse && (
                  <div className="text-xs text-neutral-500 ml-20">
                    Awaiting supplier response
                  </div>
                )}
              </div>

              {/* What's Missing */}
              <div>
                <h3 className="text-sm font-semibold text-neutral-800 mb-3">What's missing</h3>
                {missingFields.length === 0 ? (
                  <div className="text-sm text-neutral-500">All fields confirmed</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {missingFields.map((field) => (
                      <span
                        key={field}
                        className="px-3 py-1.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700"
                      >
                        {field.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Agent Activity Timeline */}
              <div>
                <h3 className="text-sm font-semibold text-neutral-800 mb-3">Agent Activity</h3>
                {milestones.length === 0 ? (
                  <div className="text-sm text-neutral-500">No activity yet</div>
                ) : (
                  <div className="space-y-3">
                    {milestones.map((milestone) => {
                      const timeInfo = formatTimestampWithRelative(milestone.timestamp)
                      return (
                        <div key={milestone.id} className="flex gap-3">
                          <div className="flex-shrink-0 w-2 h-2 rounded-full bg-neutral-300 mt-2" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-neutral-600 mb-1">
                              {milestone.label}
                            </div>
                            <div className="text-xs text-neutral-500">
                              {timeInfo.relative}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Technical Details Disclosure */}
                {hasTechnicalDetails && (
                  <div className="mt-4">
                    <Disclosure title="View technical details">
                      <div className="space-y-3">
                        {events.map((event) => {
                          const timeInfo = formatTimestampWithRelative(event.timestamp)
                          const isError = isErrorEvent(event)
                          return (
                            <div key={event.event_id} className="flex gap-3">
                              <div className={`flex-shrink-0 w-2 h-2 rounded-full mt-2 ${isError ? 'bg-red-400' : 'bg-neutral-300'}`} />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium text-neutral-600 mb-1">
                                  {getEventTypeLabel(event.event_type)}
                                </div>
                                <div className={`text-sm ${isError ? 'text-red-700' : 'text-neutral-700'}`}>
                                  {event.summary}
                                </div>
                                <div className="text-xs text-neutral-500 mt-1">
                                  {timeInfo.absolute}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </Disclosure>
                  </div>
                )}
              </div>

              {/* Email Preview / Email Sent */}
              {(emailDraft || sentEmail) && (
                <div>
                  {sentEmail ? (
                    <>
                      <h3 className="text-sm font-semibold text-neutral-800 mb-3">Email sent</h3>
                      <div className="bg-neutral-50/50 rounded-2xl shadow-sm p-5 space-y-3">
                        <div>
                          <div className="text-xs font-medium text-neutral-500 mb-1">To</div>
                          <div className="text-sm text-neutral-700">{supplierEmail}</div>
                        </div>
                        <div>
                          <div className="text-xs font-medium text-neutral-500 mb-1">Subject</div>
                          <div className="text-sm text-neutral-700">{sentEmail.subject}</div>
                        </div>
                        <div>
                          <div className="text-xs font-medium text-neutral-500 mb-1">Sent</div>
                          <div className="text-sm text-neutral-700">
                            {formatTimestampWithRelative(sentEmail.timestamp).absolute}
                          </div>
                        </div>
                        <Disclosure title="View sent email">
                          <div className="text-sm text-neutral-700 whitespace-pre-wrap font-mono">
                            {sentEmail.bodyText}
                          </div>
                        </Disclosure>
                      </div>
                    </>
                  ) : emailDraft ? (
                    <>
                      <h3 className="text-sm font-semibold text-neutral-800 mb-3">Email preview</h3>
                      <div className="bg-neutral-50/50 rounded-2xl shadow-sm p-5 space-y-3">
                        <div>
                          <div className="text-xs font-medium text-neutral-500 mb-1">To</div>
                          <div className="text-sm text-neutral-700">{supplierEmail}</div>
                        </div>
                        <div>
                          <div className="text-xs font-medium text-neutral-500 mb-1">Subject</div>
                          <div className="text-sm text-neutral-700">{emailDraft.subject}</div>
                        </div>
                        <div>
                          <div className="text-xs font-medium text-neutral-500 mb-1">Body</div>
                          <div className="text-sm text-neutral-700 whitespace-pre-wrap font-mono">
                            {emailDraft.bodyText}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex-shrink-0 px-8 py-6 bg-neutral-50/50 border-t border-neutral-200/50">
          <div className="flex items-center gap-3">
            <button
              onClick={handleSend}
              disabled={!canSend || sending}
              className="flex-1 px-6 py-3 rounded-xl font-medium text-white bg-neutral-800 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {sending ? 'Sending...' : status === 'Outreach sent' ? 'Already sent' : 'Send to supplier'}
            </button>
            <button
              onClick={onClose}
              className="px-6 py-3 rounded-xl font-medium text-neutral-700 bg-white/70 hover:bg-white/85 transition-colors shadow-sm"
            >
              Cancel
            </button>
          </div>
          {status === 'No action needed' && (
            <div className="mt-3 text-xs text-neutral-500 text-center">
              Confirmation already found in inbox
            </div>
          )}
        </div>
      </div>
    </>
  )
}
