'use client'

/**
 * Manual test steps (B2):
 * 1) Open a PO with a PDF attachment
 * 2) See "Extracting…" badge appear, then "Text extracted" or "Scanned / no text"
 * 3) Expand "Debug (B2)" disclosure to see extraction results
 * 4) Verify SQLite attachments.text_extract is populated (optional: SELECT text_extract FROM attachments WHERE attachment_id = ?)
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { generateEmailDraft } from '@/app/actions/supplierOutreach'
import type { SupplierChaseAttachment, SupplierChaseCase, SupplierChaseEvent, SupplierChaseMessage } from '@/src/lib/supplier-agent/types'
import type { ConfirmationEmailParams } from '@/src/lib/supplier-agent/emailDraft'
import { summarizeAgentEvents, isErrorEvent } from '@/src/lib/supplier-agent/eventSummarizer'
import { formatRelativeTime, formatTimestampWithRelative } from '@/src/lib/utils/relativeTime'
import { Disclosure } from '@/components/ui/disclosure'

const DEBUG_PDF = true // Set to false to hide debug panel

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
  attachments?: SupplierChaseAttachment[]
  parsed_best_fields?: any
  parsed_best_fields_v1?: any
  recent_events?: SupplierChaseEvent[]
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
  const [caseDetails, setCaseDetails] = useState<CaseDetails | null>(null)
  const [emailDraft, setEmailDraft] = useState<{ subject: string; bodyText: string } | null>(null)
  const [lastSendResult, setLastSendResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sentEmail, setSentEmail] = useState<{ subject: string; bodyText: string; timestamp: number } | null>(null)
  const [extractedFields, setExtractedFields] = useState<{
    supplierReferenceNumber?: string
    shipDate?: string
    deliveryDate?: string
    quantity?: string
  } | null>(null)
  const [applying, setApplying] = useState(false)
  const [pdfAttachments, setPdfAttachments] = useState<Array<{
    attachment_id: string
    message_id: string
    gmail_attachment_id?: string | null
    thread_id: string | null
    filename: string
    mime_type: string
    size_bytes: number | null
    received_at: number | null
    created_at: number
    text_extract?: string | null
    extracted_length?: number
    scanned_like?: boolean
    _extracted_length?: number // Ephemeral: from extract-text results
    _scanned_like?: boolean // Ephemeral: from extract-text results
    _extract_error?: string // Ephemeral: from extract-text results
  }>>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null)
  const [extractingText, setExtractingText] = useState(false)
  const [lastExtractTextRunAt, setLastExtractTextRunAt] = useState<number | null>(null)
  const [extractTextResults, setExtractTextResults] = useState<Array<{
    // Support both shapes:
    // - legacy: attachment_id
    // - current: attachmentId
    attachment_id?: string
    attachmentId?: string
    extracted_length: number
    scanned_like: boolean
    skipped: boolean
    ok?: boolean
    error?: string
  }>>([])
  const [extractionErrorById, setExtractionErrorById] = useState<Map<string, string>>(new Map())
  const [b3Parsed, setB3Parsed] = useState<null | {
    supplier_order_number: { value: string | null; confidence: number; evidence_snippet: string | null; source: 'pdf' | 'email' | 'none'; attachment_id: string | null; message_id: string | null }
    confirmed_delivery_date: { value: string | null; confidence: number; evidence_snippet: string | null; source: 'pdf' | 'email' | 'none'; attachment_id: string | null; message_id: string | null }
    confirmed_quantity: { value: number | null; confidence: number; evidence_snippet: string | null; source: 'pdf' | 'email' | 'none'; attachment_id: string | null; message_id: string | null }
    evidence_source: 'email' | 'pdf' | 'none'
    evidence_attachment_id?: string | null
    evidence_message_id?: string | null
    raw_excerpt?: string | null
  }>(null)
  const [confirmationRecord, setConfirmationRecord] = useState<null | {
    po_id: string
    line_id: string
    supplier_order_number: string | null
    confirmed_ship_date: string | null
    confirmed_quantity: number | null
    confirmed_uom: string | null
    source_type: string
    source_message_id: string | null
    source_attachment_id: string | null
    updated_at: number
  }>(null)
  const [applyAnyway, setApplyAnyway] = useState(false)
  const [applyToast, setApplyToast] = useState<string | null>(null)
  const [followupDraft, setFollowupDraft] = useState<{ subject: string; body: string; missingFields: string[]; contextSnippet?: string | null } | null>(null)
  const [localDraft, setLocalDraft] = useState<{ subject: string; body: string } | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [showFollowupModal, setShowFollowupModal] = useState(false)
  const [draftingFollowup, setDraftingFollowup] = useState(false)
  const [followupDraftError, setFollowupDraftError] = useState<string | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  // UI state for collapsible sections
  const [evidenceExpanded, setEvidenceExpanded] = useState(false)
  const [agentExpanded, setAgentExpanded] = useState(false)
  const [draftEditorOpen, setDraftEditorOpen] = useState(false)
  const [emailsSentExpanded, setEmailsSentExpanded] = useState(false)
  const [technicalExpanded, setTechnicalExpanded] = useState(false)
  const [nextActionExpanded, setNextActionExpanded] = useState(false)
  const [expandedEmailIds, setExpandedEmailIds] = useState<Set<string>>(new Set())
  const [expandedDebugAttachmentIds, setExpandedDebugAttachmentIds] = useState<Set<string>>(new Set())
  // Agent orchestrator state
  const [agentResult, setAgentResult] = useState<{
    caseId: string
    policy_version: string
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
    }
    requires_user_approval: boolean
  } | null>(null)
  const [runningAgent, setRunningAgent] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)
  
  // Simple hover tooltip component
  const EmailTooltip = ({ email, children }: { email: SupplierChaseMessage; children: React.ReactNode }) => {
    const [show, setShow] = useState(false)
    const timeInfo = formatTimestampWithRelative(email.received_at || email.created_at)
    return (
      <div
        className="relative"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        {children}
        {show && (
          <div className="absolute z-50 left-0 bottom-full mb-1 px-2 py-1.5 bg-primary-deep text-surface text-xs rounded shadow-lg whitespace-nowrap">
            <div>Subject: {email.subject || '—'}</div>
            <div>Sent: {timeInfo.absolute}</div>
          </div>
        )}
      </div>
    )
  }
  const [gmailRetrieved, setGmailRetrieved] = useState(false)
  const retrievedThreadsRef = useRef<Set<string>>(new Set())
  const extractedAttachmentIdsRef = useRef<Set<string>>(new Set())
  
  // Refs for follow-up draft fetching (prevent duplicate requests)
  const inFlightRef = useRef(false)
  const lastFetchedSigRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const parsedFieldsRef = useRef<Set<string>>(new Set())

  // Helper to normalize parsed fields structure (handles both flat and fields-wrapped formats)
  const normalizeParsedFields = (data: any): typeof b3Parsed => {
    if (!data) return null
    // If it has a fields wrapper (from parsed_best_fields_v1), extract it
    if (data.fields && typeof data.fields === 'object') {
      // Extract fields to top level, preserving top-level metadata (evidence_source, evidence_attachment_id, etc.)
      const normalized = { ...data, ...data.fields }
      // Remove the fields wrapper since we've extracted it
      delete (normalized as any).fields
      
      // Log normalization for confirmed_quantity
      if ('confirmed_quantity' in (normalized as any)) {
        const qty = (normalized as any).confirmed_quantity
        console.log('[QTY_TRACE] normalizeParsedFields extracted confirmed_quantity', {
          has_value: 'value' in (qty || {}),
          value_type: typeof qty?.value,
          value: qty?.value,
          value_not_null: qty?.value !== null,
          value_not_undefined: qty?.value !== undefined,
          shape: qty ? Object.keys(qty) : null,
        })
      }
      
      return normalized
    }
    // Otherwise assume it's already in the flat format (from parse-fields response)
    return data
  }

  // Reset state when drawer closes or caseId changes
  useEffect(() => {
    if (!open) {
      setExtractedFields(null)
      setPdfAttachments([])
      setAttachmentsLoading(false)
      setAttachmentsError(null)
      setExtractingText(false)
      setLastExtractTextRunAt(null)
      setExtractTextResults([])
      setExtractionErrorById(new Map())
      setB3Parsed(null)
      setCaseDetails(null)
      setApplyToast(null)
      setConfirmationRecord(null)
      setApplyAnyway(false)
      setGmailRetrieved(false)
      setLocalDraft(null)
      setIsEditing(false)
      setEvidenceExpanded(false)
      setAgentExpanded(false)
      setDraftEditorOpen(false)
      setEmailsSentExpanded(false)
      setTechnicalExpanded(false)
      setNextActionExpanded(false)
      setExpandedEmailIds(new Set())
      setExpandedDebugAttachmentIds(new Set())
      setAgentResult(null)
      setRunningAgent(false)
      setAgentError(null)
      retrievedThreadsRef.current.clear()
      extractedAttachmentIdsRef.current.clear()
      parsedFieldsRef.current.clear()
    }
  }, [open, caseId])

  // Load case data when drawer opens
  useEffect(() => {
    if (!open) return

    const loadData = async () => {
      setLoading(true)
      setError(null)
      setExtractedFields(null)

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

        // 2. Load existing attachments from DB (before Gmail retrieval)
        try {
          const dbAttachmentsResponse = await fetch(`/api/confirmations/attachments/list?caseId=${encodeURIComponent(newCaseId)}`)
          if (dbAttachmentsResponse.ok) {
            const dbData = (await dbAttachmentsResponse.json()) as any
            const dbAttachments = (Array.isArray(dbData?.attachments) ? dbData.attachments : []) as Array<{
              attachment_id: string
              message_id: string
              gmail_attachment_id?: string | null
              thread_id: string | null
              filename: string
              mime_type: string
              size_bytes: number | null
              received_at: number | null
              created_at: number
              updated_at?: number
              text_extract?: string | null
              extracted_length?: number
              scanned_like?: boolean
            }>
            // Filter to PDFs only
            const pdfAttachments = dbAttachments.filter(att => att.mime_type === 'application/pdf')
            setPdfAttachments(pdfAttachments)
            
            // Log evidence render
            if (pdfAttachments.length > 0) {
              const filenames = pdfAttachments.slice(0, 3).map(a => a.filename)
              console.log(`[EVIDENCE] render {dbCount: ${pdfAttachments.length}, filenames: [${filenames.join(', ')}${pdfAttachments.length > 3 ? '...' : ''}], caseId: ${newCaseId}}`)
            }
          }
        } catch (err) {
          console.error('[EVIDENCE] error loading DB attachments:', err)
        }

        // 3. Run inbox search
        let matchedThreadId: string | null = null

        // 3a) Inbox search (best-effort, don't fail whole drawer)
        try {
          const inboxResponse = await fetch('/api/confirmations/inbox-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caseId: newCaseId }),
          })

          if (inboxResponse.ok) {
            const inboxData = (await inboxResponse.json()) as any

            const extracted = (inboxData?.extractedFields || {}) as {
              supplierReferenceNumber?: string
              shipDate?: string
              deliveryDate?: string
              quantity?: string
            }

            setExtractedFields({
              supplierReferenceNumber: extracted.supplierReferenceNumber,
              shipDate: extracted.shipDate,
              deliveryDate: extracted.deliveryDate,
              quantity: extracted.quantity,
            })

            if (Array.isArray(inboxData?.missingFields)) {
              currentMissingFields = inboxData.missingFields
              setMissingFields(currentMissingFields)
            }

            matchedThreadId = typeof inboxData?.matchedThreadId === 'string' ? inboxData.matchedThreadId : null
            // Store threadId from inbox search if found
            if (matchedThreadId) {
              setThreadId(matchedThreadId)
            }
          } else {
            const t = await inboxResponse.text()
            console.error('[INBOX_SEARCH_UI] error', { caseId: newCaseId, error: t })
          }
        } catch (err) {
          console.error('[INBOX_SEARCH_UI] error', err)
        }

        // 3b) If we found a thread, retrieve PDF attachments from Gmail and merge with DB (best-effort).
        if (matchedThreadId && !retrievedThreadsRef.current.has(matchedThreadId)) {
          retrievedThreadsRef.current.add(matchedThreadId)
          setAttachmentsLoading(true)
          setAttachmentsError(null)

          try {
            const attachmentsResponse = await fetch('/api/confirmations/attachments/retrieve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ caseId: newCaseId, threadId: matchedThreadId }),
            })

            if (attachmentsResponse.ok) {
              setGmailRetrieved(true)
              
              // ALWAYS refetch from DB after retrieval (DB is source of truth)
              // Do NOT merge Gmail results into state; just refetch DB list
              try {
                const dbRefreshResponse = await fetch(`/api/confirmations/attachments/list?caseId=${encodeURIComponent(newCaseId)}`)
                if (dbRefreshResponse.ok) {
                  const dbRefreshData = (await dbRefreshResponse.json()) as any
                  const dbRefreshAttachments = (Array.isArray(dbRefreshData?.attachments) ? dbRefreshData.attachments : []) as Array<{
                    attachment_id: string
                    message_id: string
                    gmail_attachment_id?: string | null
                    thread_id: string | null
                    filename: string
                    mime_type: string
                    size_bytes: number | null
                    received_at: number | null
                    created_at: number
                    updated_at?: number
                    text_extract?: string | null
                    extracted_length?: number
                    scanned_like?: boolean
                  }>
                  // Filter to PDFs only - DB is source of truth, no merging needed
                  const pdfRefreshAttachments = dbRefreshAttachments.filter((att: any) => att.mime_type === 'application/pdf')
                  setPdfAttachments(pdfRefreshAttachments.map(att => ({
                    ...att,
                    thread_id: att.thread_id || matchedThreadId || null,
                  })))
                  
                  // Log evidence render
                  if (pdfRefreshAttachments.length > 0) {
                    const filenames = pdfRefreshAttachments.slice(0, 3).map(a => a.filename)
                    console.log(`[EVIDENCE] render {dbCount: ${pdfRefreshAttachments.length}, filenames: [${filenames.join(', ')}${pdfRefreshAttachments.length > 3 ? '...' : ''}], caseId: ${newCaseId}}`)
                  }
                }
              } catch (err) {
                console.error('[EVIDENCE] error refreshing DB attachments:', err)
              }

              // Extract text for attachments without text_extract (idempotent)
              setPdfAttachments(prev => {
                const attachmentIdsToExtract = prev
                  .filter((att: any) => !att.text_extract || att.text_extract.trim().length === 0)
                  .map((att: any) => att.attachment_id)
                  .filter((id: string) => !extractedAttachmentIdsRef.current.has(id))
                
                if (attachmentIdsToExtract.length > 0) {
                  // Trigger extraction
                  setTimeout(() => {
                    setExtractingText(true)
                    setExtractionErrorById(new Map())
                    
                    fetch('/api/confirmations/attachments/extract-text', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ attachmentIds: attachmentIdsToExtract }),
                    })
                      .then(extractResp => extractResp.ok ? extractResp.json() : null)
                      .then(extractData => {
                        if (!extractData) return
                        const results = (Array.isArray(extractData?.results) ? extractData.results : []) as Array<{
                          attachmentId: string
                          ok: boolean
                          extracted_length: number
                          scanned_like: boolean
                          skipped: boolean
                          error?: string
                        }>

                        setLastExtractTextRunAt(Date.now())
                        setExtractTextResults(results)

                        const nextErrorMap = new Map<string, string>()
                        results.forEach(r => {
                          extractedAttachmentIdsRef.current.add(r.attachmentId)
                          if (!r.ok && r.error) nextErrorMap.set(r.attachmentId, r.error)
                        })
                        setExtractionErrorById(nextErrorMap)

                        // Refresh from DB after extraction to get updated text_extract
                        fetch(`/api/confirmations/attachments/list?caseId=${encodeURIComponent(newCaseId)}`)
                          .then(dbRefreshResponse => dbRefreshResponse.ok ? dbRefreshResponse.json() : null)
                          .then(dbRefreshData => {
                            if (!dbRefreshData) return
                            const dbRefreshAttachments = (Array.isArray(dbRefreshData?.attachments) ? dbRefreshData.attachments : []) as Array<{
                              attachment_id: string
                              message_id: string
                              gmail_attachment_id?: string | null
                              thread_id: string | null
                              filename: string
                              mime_type: string
                              size_bytes: number | null
                              received_at: number | null
                              created_at: number
                              updated_at?: number
                              text_extract?: string | null
                              extracted_length?: number
                              scanned_like?: boolean
                            }>
                            // Filter to PDFs only - DB is source of truth, preserve ephemeral extraction results
                            const pdfRefreshAttachments = dbRefreshAttachments.filter((att: any) => att.mime_type === 'application/pdf')
                            setPdfAttachments(pdfRefreshAttachments.map(att => {
                              const r = results.find(x => x.attachmentId === att.attachment_id)
                              return {
                                ...att,
                                thread_id: att.thread_id || matchedThreadId || null,
                                // Preserve ephemeral extraction results if available (from just-completed extraction)
                                extracted_length: r?.extracted_length ?? att.extracted_length ?? (att.text_extract?.length || 0),
                                scanned_like: r?.scanned_like ?? att.scanned_like ?? (att.text_extract ? att.text_extract.length < 50 : false),
                              }
                            }))
                            
                            // Log evidence render after extraction
                            if (pdfRefreshAttachments.length > 0) {
                              const filenames = pdfRefreshAttachments.slice(0, 3).map(a => a.filename)
                              console.log(`[EVIDENCE] render {dbCount: ${pdfRefreshAttachments.length}, filenames: [${filenames.join(', ')}${pdfRefreshAttachments.length > 3 ? '...' : ''}], caseId: ${newCaseId}}`)
                            }
                          })
                          .catch((err: any) => {
                            console.error('[EVIDENCE] error refreshing DB attachments after extraction:', err)
                            // Fallback: Merge ephemeral extraction results into attachment rows for UI
                            setPdfAttachments(prevAtts =>
                              prevAtts.map(att => {
                                const r = results.find(x => x.attachmentId === att.attachment_id)
                                if (!r) return att
                                return {
                                  ...att,
                                  _extracted_length: r.extracted_length,
                                  _scanned_like: r.scanned_like,
                                  _extract_error: r.ok ? undefined : r.error,
                                }
                              })
                            )
                          })
                          .finally(() => setExtractingText(false))
                      })
                      .catch((err: any) => {
                        console.error('[EXTRACT_TEXT] error', err)
                        setExtractingText(false)
                      })
                  }, 100)
                }
                return prev
              })
            } else {
              const errorData = (await attachmentsResponse.json()) as any
              setAttachmentsError(errorData?.error || 'Failed to retrieve attachments')
              console.error('Failed to retrieve attachments:', errorData?.error)
            }
          } catch (err) {
            setAttachmentsError(err instanceof Error ? err.message : 'Failed to retrieve attachments')
            console.error('Error retrieving attachments:', err)
          } finally {
            setAttachmentsLoading(false)
          }
        }

        // 2c) B3: parse fields after text extraction completes (retry if no fields found)
        const tryParseFields = async () => {
          if (!newCaseId) return
          try {
            const resp = await fetch('/api/confirmations/parse-fields', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ caseId: newCaseId }),
            })
            if (resp.ok) {
              const data = await resp.json()
              const parsed = data.parsed || null
              const normalized = normalizeParsedFields(parsed)
              const hasAnyField =
                normalized?.supplier_order_number?.value ||
                normalized?.confirmed_delivery_date?.value ||
                (normalized?.confirmed_quantity?.value !== null && normalized?.confirmed_quantity?.value !== undefined)
              if (hasAnyField) {
                setB3Parsed(normalized)
                parsedFieldsRef.current.add(newCaseId)
                
                // Refetch case details to get updated parsed_best_fields_v1 from DB
                try {
                  const detailsResp = await fetch(`/api/confirmations/case/${newCaseId}`)
                  if (detailsResp.ok) {
                    const details: CaseDetails = await detailsResp.json()
                    setCaseDetails(details)
                    // Update b3Parsed from persisted snapshot (normalize structure if needed)
                    if (details.parsed_best_fields_v1) {
                      const v1Normalized = normalizeParsedFields(details.parsed_best_fields_v1)
                      if (v1Normalized) {
                        setB3Parsed(v1Normalized)
                      }
                    }
                  }
                } catch (err) {
                  console.error('[B3_PARSE_UI] case refetch error', err)
                }
              } else {
                // No fields found yet - don't cache, allow retry after more text extraction
                console.log('[B3_PARSE_UI] no fields found yet, will retry', { caseId: newCaseId })
              }
            } else {
              const t = await resp.text()
              console.error('[B3_PARSE_UI] error', { caseId: newCaseId, error: t })
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Unknown error'
            console.error('[B3_PARSE_UI] error', { caseId: newCaseId, error: msg })
          }
        }

        // Initial parse attempt (may run before text extraction completes)
        if (newCaseId && !parsedFieldsRef.current.has(newCaseId)) {
          tryParseFields()
        }

        // 3. Fetch case details (events, messages)
        const detailsResponse = await fetch(`/api/confirmations/case/${newCaseId}`)
        if (detailsResponse.ok) {
          const details: CaseDetails = await detailsResponse.json()
          setCaseDetails(details)
          setEvents(details.events || [])
          if (Array.isArray(details.case?.missing_fields)) {
            setMissingFields(details.case.missing_fields)
          }
          
          // Extract threadId from case meta or messages
          const meta = (details.case?.meta && typeof details.case.meta === 'object' ? details.case.meta : {}) as Record<string, any>
          const threadIdFromMeta = meta.thread_id || meta.gmail_threadId || null
          if (threadIdFromMeta) {
            setThreadId(threadIdFromMeta)
          } else if (details.messages && details.messages.length > 0) {
            // Get threadId from first message that has it
            const messageWithThread = details.messages.find(m => m.thread_id)
            if (messageWithThread?.thread_id) {
              setThreadId(messageWithThread.thread_id)
            }
          }
          // Normalize parsed_best_fields_v1 structure: if it has fields wrapper, extract it
          if (details.parsed_best_fields_v1) {
            const normalized = normalizeParsedFields(details.parsed_best_fields_v1)
            if (normalized) {
              // Only set if we don't already have parsed data, or if this is newer (check parsed_at if available)
              const v1ParsedAt = (normalized as any).parsed_at
              const currentParsedAt = (b3Parsed as any)?.parsed_at
              if (!b3Parsed || (v1ParsedAt && (!currentParsedAt || v1ParsedAt > currentParsedAt))) {
                setB3Parsed(normalized)
              }
            }
          } else if (details.parsed_best_fields && !b3Parsed) {
            // Fallback: use confirmation_extractions table data (flat structure)
            const flat = details.parsed_best_fields as any
            if (flat.supplier_order_number || flat.confirmed_delivery_date || flat.confirmed_quantity) {
              setB3Parsed({
                supplier_order_number: { value: flat.supplier_order_number || null, confidence: 0.8, evidence_snippet: null, source: (flat.evidence_source || 'none') as any, attachment_id: flat.evidence_attachment_id || null, message_id: flat.evidence_message_id || null },
                confirmed_delivery_date: { value: flat.confirmed_delivery_date || null, confidence: 0.8, evidence_snippet: null, source: (flat.evidence_source || 'none') as any, attachment_id: flat.evidence_attachment_id || null, message_id: flat.evidence_message_id || null },
                confirmed_quantity: { value: flat.confirmed_quantity ? Number(flat.confirmed_quantity) : null, confidence: 0.8, evidence_snippet: null, source: (flat.evidence_source || 'none') as any, attachment_id: flat.evidence_attachment_id || null, message_id: flat.evidence_message_id || null },
                evidence_source: (flat.evidence_source || 'none') as any,
                evidence_attachment_id: flat.evidence_attachment_id || null,
                evidence_message_id: flat.evidence_message_id || null,
                raw_excerpt: flat.raw_excerpt || null,
              })
            }
          }
          
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

        // 4. Generate email preview with current missing fields (only if no supplier evidence yet)
        // This will be regenerated by useEffect if needed based on nextEmailMode
        // For now, generate it if we don't have supplier evidence
        const hasEvidence = pdfAttachments.length > 0 || 
          (caseDetails?.case?.meta?.parsed_best_fields_v1?.evidence_source === 'pdf') ||
          (caseDetails?.case?.meta?.parsed_best_fields_v1?.evidence_attachment_id) ||
          (caseDetails?.messages || []).some(m => m.direction === 'INBOUND')
        
        if (!hasEvidence && currentMissingFields.length > 0) {
          const draft = await generateEmailDraft({
            poNumber,
            lineId,
            supplierName,
            supplierEmail,
            missingFields: currentMissingFields,
          })
          setEmailDraft(draft)
        }

        // 5. Fetch current confirmation record (for diff gating)
        try {
          const resp = await fetch(`/api/confirmations/records?poIds=${encodeURIComponent(poNumber)}`)
          if (resp.ok) {
            const records = (await resp.json()) as any[]
            const rec = records.find(r => r?.po_id === poNumber && String(r?.line_id) === String(lineId)) || null
            setConfirmationRecord(rec)
          }
        } catch (e) {
          // best-effort
        }
      } catch (err) {
        console.error('Error loading drawer data:', err)
        setError(err instanceof Error ? err.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [open, poNumber, lineId, supplierName, supplierEmail])

  // Cleanup follow-up draft refs when drawer closes or caseId changes
  useEffect(() => {
    if (!open) {
      // Reset refs when drawer closes
      inFlightRef.current = false
      lastFetchedSigRef.current = null
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
      setFollowupDraft(null)
      setFollowupDraftError(null)
      setDraftingFollowup(false)
    }
  }, [open])

  // Reset follow-up draft cache when caseId changes
  useEffect(() => {
    lastFetchedSigRef.current = null
    setFollowupDraft(null)
    setFollowupDraftError(null)
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    inFlightRef.current = false
  }, [caseId])

  // B3 missing chips: derived from parsed fields (delivery date + quantity)
  const displayMissingFields = useMemo(() => {
    if (!b3Parsed) return missingFields
    const m: string[] = []
    if (!b3Parsed.confirmed_delivery_date?.value) m.push('delivery_date')
    if (!(b3Parsed.confirmed_quantity?.value !== null && b3Parsed.confirmed_quantity?.value !== undefined)) m.push('quantity')
    return m
  }, [b3Parsed, missingFields])

  // Determine hasSupplierEvidence: TRUE if ANY of:
  // a) case.meta.parsed_best_fields_v1?.evidence_source === 'pdf' OR evidence_attachment_id present
  // b) attachments list for the case has >= 1 item
  // c) latest supplier reply messageId exists (inbound messages)
  const hasSupplierEvidence = useMemo(() => {
    // Check a) parsed_best_fields_v1 evidence
    const hasParsedEvidence = !!(
      caseDetails?.case?.meta?.parsed_best_fields_v1?.evidence_source === 'pdf' ||
      caseDetails?.case?.meta?.parsed_best_fields_v1?.evidence_attachment_id ||
      b3Parsed?.evidence_source === 'pdf' ||
      b3Parsed?.evidence_attachment_id
    )
    
    // Check b) attachments list
    const hasAttachments = pdfAttachments.length >= 1
    
    // Check c) inbound messages (supplier replies)
    const hasInboundMessages = (caseDetails?.messages || []).some(m => m.direction === 'INBOUND')
    
    return hasParsedEvidence || hasAttachments || hasInboundMessages
  }, [caseDetails, pdfAttachments, b3Parsed])

  // Determine nextEmailMode: 'initial' | 'followup' | 'none'
  const nextEmailMode = useMemo(() => {
    const missingCount = displayMissingFields.length
    
    if (hasSupplierEvidence && missingCount > 0) {
      return 'followup'
    } else if (!hasSupplierEvidence) {
      return 'initial'
    } else {
      // hasSupplierEvidence && missingCount === 0
      return 'none'
    }
  }, [hasSupplierEvidence, displayMissingFields])

  // Stable signature for missing fields (for caching follow-up drafts)
  const missingSig = useMemo(() => {
    return displayMissingFields.slice().sort().join('|')
  }, [displayMissingFields])

  // Regenerate email draft when missingFields change (only for initial mode)
  useEffect(() => {
    // Only generate draft if we don't have supplier evidence (initial mode)
    const shouldGenerateDraft = !hasSupplierEvidence && missingFields.length > 0 && poNumber && lineId && supplierEmail
    if (shouldGenerateDraft) {
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
    } else if (hasSupplierEvidence) {
      // Clear email draft when we have supplier evidence (will use followup draft instead)
      setEmailDraft(null)
    }
  }, [hasSupplierEvidence, missingFields, poNumber, lineId, supplierName, supplierEmail])

  // Debug log when mode is computed
  useEffect(() => {
    if (caseId) {
      console.log(`[NEXT_EMAIL_MODE] { caseId: ${caseId}, nextEmailMode: ${nextEmailMode}, missingFieldsCount: ${displayMissingFields.length}, hasSupplierEvidence: ${hasSupplierEvidence} }`)
    }
  }, [caseId, nextEmailMode, displayMissingFields.length, hasSupplierEvidence])

  // Fetch follow-up draft when mode is 'followup' (with deduplication and caching)
  useEffect(() => {
    // Only run when in followup mode, caseId exists, and missing fields are present
    if (nextEmailMode !== 'followup' || !caseId || !missingSig) {
      return
    }

    // Create stable signature for this fetch
    const fetchSig = `${caseId}:${missingSig}`

    // If we already have a draft for this exact signature, skip fetch
    if (lastFetchedSigRef.current === fetchSig && followupDraft) {
      return
    }

    // If a request is already in flight, skip
    if (inFlightRef.current) {
      return
    }

    // Abort any prior request
    if (abortRef.current) {
      abortRef.current.abort()
    }

    // Create new AbortController for this request
    const abortController = new AbortController()
    abortRef.current = abortController

    // Mark as in-flight and set loading state
    inFlightRef.current = true
    setDraftingFollowup(true)
    setFollowupDraftError(null)

    // Fetch follow-up draft
    fetch('/api/confirmations/followup/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId }),
      signal: abortController.signal,
    })
      .then(res => {
        if (!res.ok) {
          return res.json().then(data => {
            throw new Error(data.error || 'Failed to fetch follow-up draft')
          })
        }
        return res.json()
      })
      .then(data => {
        // Check if request was aborted
        if (abortController.signal.aborted) {
          return
        }

        if (data.error) {
          throw new Error(data.error)
        }

        // Success: set draft and cache signature
        setFollowupDraft({
          subject: data.subject,
          body: data.body,
          missingFields: data.missingFields || [],
          contextSnippet: data.contextSnippet || null,
        })
        lastFetchedSigRef.current = fetchSig
        setFollowupDraftError(null)
      })
      .catch(err => {
        // Ignore AbortError (request was cancelled)
        if (err.name === 'AbortError') {
          return
        }

        // Other errors: log and set error state
        console.error('[FOLLOWUP_DRAFT] error:', err)
        setFollowupDraftError(err instanceof Error ? err.message : 'Failed to fetch follow-up draft')
      })
      .finally(() => {
        // Only clear in-flight flag if this is still the current request
        if (abortRef.current === abortController) {
          inFlightRef.current = false
          setDraftingFollowup(false)
        }
      })
  }, [nextEmailMode, caseId, missingSig, followupDraft, threadId, displayMissingFields])

  // Initialize localDraft from followupDraft when signature changes (only if not editing)
  useEffect(() => {
    const fetchSig = `${caseId}:${missingSig}`
    
    if (followupDraft && !isEditing) {
      // Only re-init if signature changed or localDraft is null
      const shouldInit = !localDraft || lastFetchedSigRef.current !== fetchSig
      
      if (shouldInit) {
        setLocalDraft({
          subject: followupDraft.subject,
          body: followupDraft.body,
        })
        console.log('[FOLLOWUP_EDIT] init localDraft', { sig: fetchSig })
      }
    }
  }, [followupDraft, missingSig, caseId, isEditing, localDraft])
  
  // Retry handler for follow-up draft fetch
  const handleRetryFollowupDraft = () => {
    // Clear cached signature to force refetch
    lastFetchedSigRef.current = null
    setFollowupDraftError(null)
    // Effect will re-run due to missingSig dependency
  }
  
  // Handle Edit button click
  const handleEditFollowup = () => {
    if (!followupDraft) return
    // Initialize localDraft if not already set
    if (!localDraft) {
      setLocalDraft({
        subject: followupDraft.subject,
        body: followupDraft.body,
      })
    }
    setIsEditing(true)
    // Focus subject input after state update (using setTimeout to allow DOM update)
    setTimeout(() => {
      const subjectInput = document.querySelector('[data-followup-subject-input]') as HTMLInputElement
      subjectInput?.focus()
    }, 0)
  }
  
  // Handle Cancel editing
  const handleCancelEdit = () => {
    // Revert to followupDraft values
    if (followupDraft) {
      setLocalDraft({
        subject: followupDraft.subject,
        body: followupDraft.body,
      })
    }
    setIsEditing(false)
  }

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
        setCaseDetails(details)
        setEvents(details.events || [])
        if (Array.isArray(details.case?.missing_fields)) {
          setMissingFields(details.case.missing_fields)
        }
        
        // Load sent email from case.meta.last_sent_message_id (preferred) or most recent OUTBOUND message
        const meta = (details.case?.meta && typeof details.case.meta === 'object' ? details.case.meta : {}) as Record<string, any>
        if (meta.last_sent_message_id && meta.last_sent_at && meta.last_sent_subject) {
          const sentMessage = details.messages?.find(m => m.message_id === meta.last_sent_message_id)
          if (sentMessage) {
            setSentEmail({
              subject: meta.last_sent_subject || sentMessage.subject || '',
              bodyText: sentMessage.body_text || '',
              timestamp: meta.last_sent_at,
            })
            console.log('[EMAIL_SENT_UI] loaded from meta', {
              showingMessageId: meta.last_sent_message_id,
              threadId: meta.last_sent_thread_id,
              timestamp: meta.last_sent_at,
            })
          } else if (meta.last_sent_subject && meta.last_sent_at) {
            setSentEmail({
              subject: meta.last_sent_subject,
              bodyText: emailDraft?.bodyText || '',
              timestamp: meta.last_sent_at,
            })
          }
        } else {
          // Fallback: Find the most recent sent email from messages
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

  const handleApply = async () => {
    if (!caseId || !canApplyUpdates) return

    setApplying(true)
    setError(null)

    try {
      const supplierOrderNumber = b3Parsed?.supplier_order_number?.value ?? null
      const confirmedShipOrDelivery = b3Parsed?.confirmed_delivery_date?.value ?? null
      const confirmedQuantity = b3Parsed?.confirmed_quantity?.value ?? null

      const evidenceSource = b3Parsed?.evidence_source
      const source: 'pdf' | 'email' =
        evidenceSource === 'pdf' ? 'pdf' : 'email'

      const body = {
        source,
        fields: {
          ...(supplierOrderNumber
            ? {
                supplier_order_number: {
                  value: supplierOrderNumber,
                  confidence: b3Parsed?.supplier_order_number?.confidence,
                  attachment_id: b3Parsed?.supplier_order_number?.attachment_id ?? b3Parsed?.evidence_attachment_id ?? undefined,
                  evidence_snippet: b3Parsed?.supplier_order_number?.evidence_snippet ?? b3Parsed?.raw_excerpt ?? undefined,
                },
              }
            : {}),
          ...(confirmedShipOrDelivery
            ? {
                confirmed_ship_or_delivery_date: {
                  value: confirmedShipOrDelivery,
                  confidence: b3Parsed?.confirmed_delivery_date?.confidence,
                  attachment_id: b3Parsed?.confirmed_delivery_date?.attachment_id ?? b3Parsed?.evidence_attachment_id ?? undefined,
                  evidence_snippet: b3Parsed?.confirmed_delivery_date?.evidence_snippet ?? b3Parsed?.raw_excerpt ?? undefined,
                },
              }
            : {}),
          ...(confirmedQuantity && Number.isFinite(Number(confirmedQuantity))
            ? {
                confirmed_quantity: {
                  value: Number(confirmedQuantity),
                  confidence: b3Parsed?.confirmed_quantity?.confidence,
                  attachment_id: b3Parsed?.confirmed_quantity?.attachment_id ?? b3Parsed?.evidence_attachment_id ?? undefined,
                  evidence_snippet: b3Parsed?.confirmed_quantity?.evidence_snippet ?? b3Parsed?.raw_excerpt ?? undefined,
                },
              }
            : {}),
        },
      }

      const response = await fetch(`/api/confirmations/case/${caseId}/apply-updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to apply updates')
      }

      // Refresh case details after apply
      const detailsResponse = await fetch(`/api/confirmations/case/${caseId}`)
      if (detailsResponse.ok) {
        const details: CaseDetails = await detailsResponse.json()
        setCaseDetails(details)
        setEvents(details.events || [])
        if (Array.isArray(details.case?.missing_fields)) {
          setMissingFields(details.case.missing_fields)
        }
      }

      // Refresh current confirmation record
      try {
        const resp = await fetch(`/api/confirmations/records?poIds=${encodeURIComponent(poNumber)}`)
        if (resp.ok) {
          const records = (await resp.json()) as any[]
          const rec = records.find(r => r?.po_id === poNumber && String(r?.line_id) === String(lineId)) || null
          setConfirmationRecord(rec)
        }
      } catch {
        // best-effort
      }

      setApplyToast('Updates applied')
      setTimeout(() => setApplyToast(null), 2500)
    } catch (err) {
      console.error('Error applying confirmation data:', err)
      setError(err instanceof Error ? err.message : 'Failed to apply updates')
    } finally {
      setApplying(false)
    }
  }

  const handleDraftFollowup = async () => {
    if (!caseId) return

    setDraftingFollowup(true)
    setError(null)

    try {
      // Build payload with caseId and optional threadId
      const payload: { caseId: string; threadId?: string; missingFields?: string[] } = { caseId }
      if (threadId) {
        payload.threadId = threadId
      }
      if (displayMissingFields.length > 0) {
        payload.missingFields = displayMissingFields
      }
      
      const response = await fetch('/api/confirmations/followup/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to draft follow-up')
      }

      const data = await response.json()
      setFollowupDraft({
        subject: data.subject,
        body: data.body,
        missingFields: data.missingFields,
        contextSnippet: data.contextSnippet,
      })
      setShowFollowupModal(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to draft follow-up')
    } finally {
      setDraftingFollowup(false)
    }
  }

  const handleSendFollowup = async () => {
    console.log('[SEND_FOLLOWUP] click start')
    
    if (!caseId || !followupDraft) {
      console.log('[SEND_FOLLOWUP] early return - missing caseId or followupDraft', { caseId: !!caseId, hasDraft: !!followupDraft })
      setApplyToast('Cannot send: missing case or draft. Please refresh the drawer.')
      setTimeout(() => setApplyToast(null), 3000)
      return
    }

    // Derive required fields from case data
    const caseData = caseDetails?.case
    if (!caseData) {
      console.log('[SEND_FOLLOWUP] early return - case data not loaded')
      setApplyToast('Case data not loaded. Please refresh the drawer.')
      setTimeout(() => setApplyToast(null), 3000)
      return
    }

    const poNumberValue = caseData.po_number
    const lineIdValue = caseData.line_id
    const supplierEmailValue = caseData.supplier_email || supplierEmail
    
    // Use localDraft if available and edited, otherwise fall back to followupDraft
    const subjectToUse = localDraft?.subject?.trim() || followupDraft.subject
    const bodyToUse = localDraft?.body?.trim() || followupDraft.body
    const hasEdits = localDraft && (
      localDraft.subject.trim() !== followupDraft.subject ||
      localDraft.body.trim() !== followupDraft.body
    )
    
    console.log('[FOLLOWUP_EDIT] send using localDraft', { hasEdits })
    
    // Validate required fields
    const missing: string[] = []
    if (!caseId) missing.push('caseId')
    if (!poNumberValue) missing.push('poNumber')
    if (!lineIdValue) missing.push('lineId')
    if (!supplierEmailValue) missing.push('supplierEmail')
    if (!subjectToUse) missing.push('subject')
    if (!bodyToUse) missing.push('body')
    
    if (missing.length > 0) {
      console.log('[SEND_FOLLOWUP] early return - missing fields', missing)
      setApplyToast(`Missing required fields: ${missing.join(', ')}`)
      setTimeout(() => setApplyToast(null), 3000)
      return
    }

    const payload = {
      caseId,
      poNumber: String(poNumberValue),
      lineId: String(lineIdValue),
      supplierEmail: supplierEmailValue,
      supplierName: caseData.supplier_name || supplierName || null,
      missingFields: displayMissingFields.length > 0 ? displayMissingFields : (followupDraft.missingFields || []),
      subject: subjectToUse,
      body: bodyToUse,
      intent: 'followup',
      forceSend: true,
      runInboxSearch: true,
    }

    console.log('[SEND_FOLLOWUP] before fetch', {
      caseId,
      poNumber: String(poNumberValue),
      lineId: String(lineIdValue),
      hasSubject: !!followupDraft.subject,
      hasBody: !!followupDraft.body,
      missingFieldsCount: payload.missingFields.length,
    })

    setSending(true)
    setError(null)

    try {
      // Send with all required fields
      const response = await fetch(`/api/confirmations/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const responseData = await response.json()
      console.log('[SEND_FOLLOWUP] after fetch', {
        status: response.status,
        ok: response.ok,
        hasOk: 'ok' in responseData,
        hasError: 'error' in responseData,
        hasGmailMessageId: 'gmailMessageId' in responseData,
        hasThreadId: 'threadId' in responseData,
      })

      if (!response.ok) {
        const errorMsg = responseData.error || responseData.message || 'Failed to send follow-up'
        console.error('[SEND_FOLLOWUP] fetch failed', { status: response.status, error: errorMsg })
        setApplyToast(`Failed to send: ${errorMsg}`)
        setTimeout(() => setApplyToast(null), 4000)
        return
      }

      // Check for ok:false in response body
      if (responseData.ok === false) {
        const errorMsg = responseData.error || 'Failed to send follow-up'
        console.error('[SEND_FOLLOWUP] server returned ok:false', { error: errorMsg })
        setApplyToast(`Failed to send: ${errorMsg}`)
        setTimeout(() => setApplyToast(null), 4000)
        return
      }

      // Success path - verify we have messageId
      if (!responseData.gmailMessageId && !responseData.messageId) {
        console.warn('[SEND_FOLLOWUP] success but no messageId', responseData)
      }

      // Refetch case + attachments + records after send (same as handleSend)
      const detailsResponse = await fetch(`/api/confirmations/case/${caseId}`)
      if (detailsResponse.ok) {
        const details: CaseDetails = await detailsResponse.json()
        setCaseDetails(details)
        setEvents(details.events || [])
        if (Array.isArray(details.case?.missing_fields)) {
          setMissingFields(details.case.missing_fields)
        }
        // Update b3Parsed if available
        if (details.parsed_best_fields_v1) {
          const normalized = normalizeParsedFields(details.parsed_best_fields_v1)
          if (normalized) {
            setB3Parsed(normalized)
          }
        }
        
        // Load sent email from case.meta.last_sent_message_id if available
        const meta = (details.case?.meta && typeof details.case.meta === 'object' ? details.case.meta : {}) as Record<string, any>
        if (meta.last_sent_message_id && meta.last_sent_at && meta.last_sent_subject) {
          // Find the sent message in details.messages
          const sentMessage = details.messages?.find(m => m.message_id === meta.last_sent_message_id)
          if (sentMessage) {
            setSentEmail({
              subject: meta.last_sent_subject || sentMessage.subject || '',
              bodyText: sentMessage.body_text || '',
              timestamp: meta.last_sent_at,
            })
            console.log('[EMAIL_SENT_UI] showing latest sent', {
              showingMessageId: meta.last_sent_message_id,
              threadId: meta.last_sent_thread_id,
              timestamp: meta.last_sent_at,
            })
          } else if (meta.last_sent_subject && meta.last_sent_at) {
            // Fallback: use meta if message not found
            setSentEmail({
              subject: meta.last_sent_subject,
              bodyText: '', // Body might not be in meta
              timestamp: meta.last_sent_at,
            })
          }
        }
      }

      // Refetch attachments
      try {
        const attachmentsResponse = await fetch(`/api/confirmations/attachments/list?caseId=${encodeURIComponent(caseId)}`)
        if (attachmentsResponse.ok) {
          const attachmentsData = (await attachmentsResponse.json()) as any
          const dbAttachments = (Array.isArray(attachmentsData?.attachments) ? attachmentsData.attachments : []) as Array<{
            attachment_id: string
            message_id: string
            gmail_attachment_id?: string | null
            thread_id: string | null
            filename: string
            mime_type: string
            size_bytes: number | null
            received_at: number | null
            created_at: number
            updated_at?: number
            text_extract?: string | null
            extracted_length?: number
            scanned_like?: boolean
          }>
          const pdfAttachments = dbAttachments.filter(att => att.mime_type === 'application/pdf')
          setPdfAttachments(pdfAttachments)
        }
      } catch (err) {
        console.error('[EVIDENCE] error refreshing attachments:', err)
      }

      // Refetch confirmation record
      try {
        const resp = await fetch(`/api/confirmations/records?poIds=${encodeURIComponent(poNumber)}`)
        if (resp.ok) {
          const records = (await resp.json()) as any[]
          const rec = records.find(r => r?.po_id === poNumber && String(r?.line_id) === String(lineId)) || null
          setConfirmationRecord(rec)
        }
      } catch (e) {
        // best-effort
      }

      setShowFollowupModal(false)
      setIsEditing(false)
      // Clear localDraft after successful send (will be re-initialized if draft refetches)
      setLocalDraft(null)
      const successMsg = responseData.gmailMessageId 
        ? `Follow-up sent successfully (message ID: ${responseData.gmailMessageId.substring(0, 20)}...)`
        : 'Follow-up sent successfully'
      setApplyToast(successMsg)
      setTimeout(() => setApplyToast(null), 4000)
      console.log('[SEND_FOLLOWUP] success', {
        gmailMessageId: responseData.gmailMessageId,
        threadId: responseData.threadId,
        action: responseData.action,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send follow-up'
      console.error('[SEND_FOLLOWUP] exception', err)
      setApplyToast(`Failed to send: ${errorMsg}`)
      setTimeout(() => setApplyToast(null), 4000)
    } finally {
      setSending(false)
    }
  }

  const handleCopyFollowup = () => {
    if (!followupDraft) return
    const text = `Subject: ${followupDraft.subject}\n\n${followupDraft.body}`
    navigator.clipboard.writeText(text)
    setApplyToast('Follow-up copied to clipboard')
    setTimeout(() => setApplyToast(null), 2500)
  }

  // Agent orchestrator handlers
  const handleRunAgent = async () => {
    if (!caseId) return

    setRunningAgent(true)
    setAgentError(null)

    try {
      const response = await fetch('/api/agent/ack-orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId,
          mode: 'queue_only',
          lookbackDays: 30,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to run agent')
      }

      const result = await response.json()
      setAgentResult(result)

      // If agent drafted an email, populate the draft editor
      if (result.drafted_email) {
        setLocalDraft({
          subject: result.drafted_email.subject,
          body: result.drafted_email.body,
        })
        // Update followupDraft if we're in followup mode, otherwise set emailDraft
        if (nextEmailMode === 'followup') {
          setFollowupDraft({
            subject: result.drafted_email.subject,
            body: result.drafted_email.body,
            missingFields: result.decision.missing_fields_remaining || [],
            contextSnippet: null,
          })
        }
        // Update threadId if present
        if (result.drafted_email.threadId) {
          setThreadId(result.drafted_email.threadId)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to run agent'
      setAgentError(errorMsg)
      console.error('[AGENT_UI] error:', err)
    } finally {
      setRunningAgent(false)
    }
  }

  const handleApproveAndSend = async () => {
    if (!caseId || !agentResult?.drafted_email) return

    setSending(true)
    setError(null)

    try {
      // Use localDraft if edited, otherwise use agent's draft
      const subjectToUse = localDraft?.subject?.trim() || agentResult.drafted_email.subject
      const bodyToUse = localDraft?.body?.trim() || agentResult.drafted_email.body

      const response = await fetch('/api/confirmations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId,
          poNumber,
          lineId,
          supplierEmail,
          supplierName,
          missingFields: agentResult.decision.missing_fields_remaining || [],
          subject: subjectToUse,
          body: bodyToUse,
          ...(agentResult.drafted_email.threadId ? { threadId: agentResult.drafted_email.threadId } : {}),
          runInboxSearch: false, // Already done by agent
          forceSend: true,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to send email')
      }

      const result = await response.json()

      // Refresh case details after send
      const detailsResponse = await fetch(`/api/confirmations/case/${caseId}`)
      if (detailsResponse.ok) {
        const details: CaseDetails = await detailsResponse.json()
        setCaseDetails(details)
        setEvents(details.events || [])
        if (Array.isArray(details.case?.missing_fields)) {
          setMissingFields(details.case.missing_fields)
        }
      }

      // Clear agent result after successful send
      setAgentResult(null)
      setLocalDraft(null)

      // Show success toast
      setApplyToast('Email sent successfully')
      setTimeout(() => setApplyToast(null), 3000)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send email'
      setError(errorMsg)
      setApplyToast(`Failed to send: ${errorMsg}`)
      setTimeout(() => setApplyToast(null), 4000)
      console.error('[AGENT_UI] send error:', err)
    } finally {
      setSending(false)
    }
  }

  const handleDiscardAgentAction = () => {
    setAgentResult(null)
    // Reset draft to original state if we had one
    if (followupDraft) {
      setLocalDraft({
        subject: followupDraft.subject,
        body: followupDraft.body,
      })
    } else {
      setLocalDraft(null)
    }
  }

  const hasExtractedFields = extractedFields && (
    extractedFields.supplierReferenceNumber ||
    extractedFields.shipDate ||
    extractedFields.deliveryDate ||
    extractedFields.quantity
  )

  // Merge email and PDF fields (prefer email if present)
  const mergedFields = useMemo(() => {
    const src = b3Parsed?.evidence_source
    const srcLabel =
      src === 'pdf' ? 'PDF' : src === 'email' ? 'Email' : null
    
    // Extract confirmed_quantity with proper null/undefined checking
    const qtyValue = b3Parsed?.confirmed_quantity?.value
    const hasQtyValue = qtyValue !== null && qtyValue !== undefined
    const mergedQty = hasQtyValue ? String(qtyValue) : (extractedFields?.quantity || null)
    
    console.log('[QTY_TRACE] ui merged confirmed_quantity', {
      value: qtyValue,
      hasQtyValue,
      mergedQty,
      b3Parsed_qty_shape: b3Parsed?.confirmed_quantity ? {
        has_value: 'value' in b3Parsed.confirmed_quantity,
        value_type: typeof b3Parsed.confirmed_quantity.value,
        value: b3Parsed.confirmed_quantity.value,
        has_confidence: 'confidence' in b3Parsed.confirmed_quantity,
        has_source: 'source' in b3Parsed.confirmed_quantity,
      } : null,
    })
    
    return {
      supplierReferenceNumber: b3Parsed?.supplier_order_number?.value || extractedFields?.supplierReferenceNumber || null,
      shipDate: b3Parsed?.confirmed_delivery_date?.value || extractedFields?.shipDate || extractedFields?.deliveryDate || null,
      deliveryDate: b3Parsed?.confirmed_delivery_date?.value || extractedFields?.deliveryDate || null,
      quantity: mergedQty,
      uom: null,
      // Track source for each field
      supplierReferenceNumberSource: b3Parsed?.supplier_order_number?.value ? (b3Parsed?.supplier_order_number?.source === 'pdf' ? 'PDF' : 'Email') : (extractedFields?.supplierReferenceNumber ? 'Email' : null),
      shipDateSource: b3Parsed?.confirmed_delivery_date?.value ? (b3Parsed?.confirmed_delivery_date?.source === 'pdf' ? 'PDF' : 'Email') : ((extractedFields?.shipDate || extractedFields?.deliveryDate) ? 'Email' : null),
      quantitySource: hasQtyValue
        ? (b3Parsed?.confirmed_quantity?.source === 'pdf' ? 'PDF' : 'Email')
        : (extractedFields?.quantity ? 'Email' : null),
    }
  }, [b3Parsed, extractedFields])

  // B3 completeness: confirmed if supplier_order_number AND delivery/ship date exist (quantity optional)
  const hasAllRequiredFields = !!mergedFields.supplierReferenceNumber && !!mergedFields.shipDate

  // Check if at least 1 confirmation field is populated (from either source)
  const hasAnyConfirmationField = mergedFields.supplierReferenceNumber ||
    mergedFields.shipDate ||
    mergedFields.quantity

  const hasAnyParsedField = !!(
    b3Parsed?.supplier_order_number?.value ||
    b3Parsed?.confirmed_delivery_date?.value ||
    (b3Parsed?.confirmed_quantity?.value !== null && b3Parsed?.confirmed_quantity?.value !== undefined)
  )

  const lastAppliedEvent = useMemo(() => {
    const recent = (caseDetails?.recent_events || []) as SupplierChaseEvent[]
    const fromRecent = recent.find(e => e.event_type === 'APPLY_UPDATES')
    if (fromRecent) return fromRecent
    const fromAll = (events || []).slice().sort((a, b) => b.timestamp - a.timestamp).find(e => e.event_type === 'APPLY_UPDATES')
    return fromAll || null
  }, [caseDetails?.recent_events, events])

  const hasParsedDiffFromRecord = useMemo(() => {
    if (!hasAnyParsedField) return false
    if (!confirmationRecord) return true

    const sameStr = (a: any, b: any) => (typeof a === 'string' ? a.trim() : '') === (typeof b === 'string' ? b.trim() : '')
    const normalizeDate = (s: string | null) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : s)

    const parsedSupplier = b3Parsed?.supplier_order_number?.value ?? null
    const parsedDate = b3Parsed?.confirmed_delivery_date?.value ?? null
    const parsedQty = b3Parsed?.confirmed_quantity?.value ?? null

    const supplierDiff =
      parsedSupplier !== null && !sameStr(confirmationRecord.supplier_order_number, parsedSupplier)
    const dateDiff =
      parsedDate !== null && !sameStr(normalizeDate(confirmationRecord.confirmed_ship_date), normalizeDate(parsedDate))
    const qtyDiff =
      parsedQty !== null &&
      Number.isFinite(parsedQty) &&
      (confirmationRecord.confirmed_quantity === null || Number(confirmationRecord.confirmed_quantity) !== Number(parsedQty))

    return supplierDiff || dateDiff || qtyDiff
  }, [
    hasAnyParsedField,
    confirmationRecord,
    b3Parsed?.supplier_order_number?.value,
    b3Parsed?.confirmed_delivery_date?.value,
    b3Parsed?.confirmed_quantity?.value,
  ])

  const canApplyUpdates = useMemo(() => {
    if (applying || !hasAnyParsedField) return false
    if (applyAnyway) return true
    return hasParsedDiffFromRecord
  }, [
    applying,
    hasAnyParsedField,
    applyAnyway,
    hasParsedDiffFromRecord,
  ])

  // Determine confirmation status based on data completeness
  const getConfirmationStatus = () => {
    if (!hasAnyConfirmationField) {
      return 'Unconfirmed'
    }
    if (hasAllRequiredFields) {
      return 'Confirmed'
    }
    return 'Partially confirmed'
  }

  // Derive presence booleans (treat null value as missing, especially for confirmed_quantity)
  const hasOrder = !!(mergedFields.supplierReferenceNumber && mergedFields.supplierReferenceNumber.trim() !== '')
  const hasDate = !!(mergedFields.shipDate && mergedFields.shipDate.trim() !== '')
  const hasQty = !!(mergedFields.quantity && mergedFields.quantity.trim() !== '')
  
  // Derive counts for compact UI
  const missingCount = displayMissingFields.length
  const docCount = pdfAttachments.length
  
  // Count sent emails
  const sentEmails = useMemo(() => {
    return (caseDetails?.messages || []).filter(m => m.direction === 'OUTBOUND')
  }, [caseDetails?.messages])
  const sentEmailCount = sentEmails.length
  
  // Get most recent supplier reply timestamp
  const latestSupplierReply = useMemo(() => {
    const inboundMessages = (caseDetails?.messages || []).filter(m => m.direction === 'INBOUND')
    if (inboundMessages.length === 0) return null
    return inboundMessages.sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
  }, [caseDetails?.messages])
  



  if (!open) return null

  return (
    <>
      <div className="h-full w-full bg-surface flex flex-col">
        {/* Header */}
        <div className="flex-shrink-0 px-8 py-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold text-text">Supplier Confirmation</h2>
            <button
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-surface-2 transition-colors"
            >
              <X className="w-5 h-5 text-text-subtle" />
            </button>
          </div>
          <div className="text-sm text-text-muted">
            PO {poNumber} · Line {lineId}
          </div>
          <div className="text-xs text-text-subtle mt-1">{supplierEmail}</div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-8 pb-6 space-y-2.5">
          {loading ? (
            <div className="text-center py-12 text-text-subtle">Loading...</div>
          ) : error ? (
            <div className="bg-surface-2 rounded-xl p-4 text-sm text-text border border-border/70">
              Error: {error}
            </div>
          ) : (
            <>
              {/* Confirmation card - checklist with values inline, always expanded */}
              <div className="bg-surface-2 rounded-xl p-2.5 space-y-2 border border-border/70">
                <h3 className="text-sm font-semibold text-text">Confirmation</h3>
                {applyToast && (
                  <div className="text-xs text-success bg-success/15 border border-success/30 rounded px-2 py-1">
                    {applyToast}
                  </div>
                )}
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className={hasOrder ? 'text-success' : 'text-text-subtle'}>
                        {hasOrder ? '✓' : '✕'}
                      </span>
                      <span className="text-text-muted">Supplier order #</span>
                    </div>
                    <span className="text-text font-medium">
                      {hasOrder ? mergedFields.supplierReferenceNumber : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className={hasDate ? 'text-success' : 'text-text-subtle'}>
                        {hasDate ? '✓' : '✕'}
                      </span>
                      <span className="text-text-muted">Confirmed ship date</span>
                    </div>
                    <span className="text-text font-medium">
                      {hasDate ? mergedFields.shipDate : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2">
                      <span className={hasQty ? 'text-success' : 'text-text-subtle'}>
                        {hasQty ? '✓' : '✕'}
                      </span>
                      <span className="text-text-muted">Quantity</span>
                    </div>
                    <span className="text-text font-medium">
                      {hasQty ? mergedFields.quantity : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Agent section - minimal, always present */}
              <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-text">Agent</h3>
                  <div className="flex items-center gap-2">
                    {agentResult && (
                      <>
                        <button
                          onClick={handleDiscardAgentAction}
                          className="px-2 py-1 text-xs font-medium text-text-subtle hover:text-text bg-surface border border-border/70 rounded transition-colors"
                        >
                          Discard
                        </button>
                        <button
                          onClick={handleApproveAndSend}
                          disabled={
                            !agentResult.drafted_email ||
                            agentResult.decision.action_type === 'NO_OP' ||
                            agentResult.decision.action_type === 'NEEDS_HUMAN' ||
                            sending
                          }
                          className="px-3 py-1 text-xs font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded"
                        >
                          {sending ? 'Sending...' : 'Approve & Send'}
                        </button>
                      </>
                    )}
                    <button
                      onClick={handleRunAgent}
                      disabled={!caseId || runningAgent}
                      className="px-3 py-1 text-xs font-medium text-text bg-surface border border-border/70 hover:bg-surface-tint disabled:opacity-50 disabled:cursor-not-allowed transition-colors rounded"
                    >
                      {runningAgent ? 'Running...' : 'Run Agent'}
                    </button>
                  </div>
                </div>
                {agentError && (
                  <div className="text-xs text-danger mb-2 bg-danger/15 border border-danger/30 rounded px-2 py-1">
                    {agentError}
                  </div>
                )}
                {agentResult && (
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text-muted">Decision:</span>
                      <span className={`font-medium ${
                        agentResult.decision.action_type === 'NEEDS_HUMAN' ? 'text-danger' :
                        agentResult.decision.action_type === 'NO_OP' ? 'text-text-subtle' :
                        'text-text'
                      }`}>
                        {agentResult.decision.action_type.replace(/_/g, ' ')}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        agentResult.decision.risk_level === 'HIGH' ? 'bg-danger/15 text-danger border border-danger/30' :
                        agentResult.decision.risk_level === 'MEDIUM' ? 'bg-warning/15 text-warning border border-warning/30' :
                        'bg-success/15 text-success border border-success/30'
                      }`}>
                        {agentResult.decision.risk_level}
                      </span>
                    </div>
                    <div className="text-text-subtle line-clamp-2">
                      {agentResult.decision.reason}
                    </div>
                    {agentResult.decision.action_type === 'APPLY_UPDATES_READY' && (
                      <div className="text-xs text-text-muted bg-info/15 border border-info/30 rounded px-2 py-1">
                        Ready to apply extracted fields
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Next action - collapsible, always present */}
              <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                <button
                  onClick={() => setNextActionExpanded(!nextActionExpanded)}
                  className="flex items-center justify-between w-full text-left text-sm font-medium text-text hover:text-primary-deep"
                >
                  <span>
                    Next action · {(() => {
                      const recentlySent = sentEmailCount > 0 && sentEmails.length > 0 && sentEmails[0] && (Date.now() - (sentEmails[0].received_at || sentEmails[0].created_at)) < 3600000
                      if (recentlySent) {
                        return 'Waiting on supplier'
                      }
                      if (displayMissingFields.length > 0 && displayMissingFields[0]) {
                        const fieldName = displayMissingFields[0].replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())
                        return `Missing: ${fieldName}`
                      }
                      return 'Waiting on supplier'
                    })()}
                  </span>
                  <span className="text-xs text-text-subtle">{nextActionExpanded ? '▼' : '▶'}</span>
                </button>
                {nextActionExpanded && (
                  <div className="mt-2.5">
                    {(() => {
                      const recentlySent = sentEmailCount > 0 && sentEmails.length > 0 && sentEmails[0] && (Date.now() - (sentEmails[0].received_at || sentEmails[0].created_at)) < 3600000
                      if (recentlySent) {
                        return <div className="text-sm text-text">Waiting for supplier response.</div>
                      }
                      // Show editable email draft if we have agent draft or followup draft
                      const draftToShow = agentResult?.drafted_email || followupDraft
                      if (displayMissingFields.length > 0 && draftToShow) {
                        // Use agent draft if available, otherwise use followup draft
                        const draftSubject = agentResult?.drafted_email?.subject || followupDraft?.subject || ''
                        const draftBody = agentResult?.drafted_email?.body || followupDraft?.body || ''
                        
                        return (
                          <div className="space-y-2">
                            <input
                              type="text"
                              data-followup-subject-input
                              value={localDraft?.subject || draftSubject}
                              onChange={(e) => {
                                if (!localDraft) {
                                  setLocalDraft({ subject: draftSubject, body: draftBody })
                                }
                                if (localDraft) {
                                  setLocalDraft({ ...localDraft, subject: e.target.value })
                                }
                              }}
                              className="w-full px-2 py-1.5 text-xs text-text bg-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring/70"
                              placeholder="Subject"
                            />
                            <textarea
                              data-followup-editor-textarea
                              value={localDraft?.body || draftBody}
                              onChange={(e) => {
                                if (!localDraft) {
                                  setLocalDraft({ subject: draftSubject, body: draftBody })
                                }
                                if (localDraft) {
                                  setLocalDraft({ ...localDraft, body: e.target.value })
                                }
                              }}
                              rows={8}
                              className="w-full px-2 py-1.5 text-xs text-text bg-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring/70 font-mono whitespace-pre-wrap"
                            />
                            <div className="flex justify-end gap-2">
                              {agentResult?.drafted_email && (
                                <button
                                  onClick={handleDiscardAgentAction}
                                  className="px-3 py-1.5 rounded text-xs font-medium text-text-subtle hover:text-text bg-surface border border-border/70 hover:bg-surface-tint transition-colors"
                                >
                                  Discard
                                </button>
                              )}
                              <button
                                onClick={async () => {
                                  // If agent draft exists, use approve & send; otherwise use regular send
                                  if (agentResult?.drafted_email) {
                                    await handleApproveAndSend()
                                  } else {
                                    await handleSendFollowup()
                                  }
                                  // Auto-collapse after send
                                  setNextActionExpanded(false)
                                }}
                                disabled={!draftToShow || (!localDraft && !draftBody) || sending}
                                className="px-3 py-1.5 rounded text-xs font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >
                                {sending ? 'Sending...' : 'Send'}
                              </button>
                            </div>
                          </div>
                        )
                      }
                      return <div className="text-sm text-text">No action needed.</div>
                    })()}
                  </div>
                )}
              </div>

              {/* Activity - collapsible timeline */}
              {milestones.length > 0 && (() => {
                const sortedMilestones = milestones.slice().sort((a, b) => b.timestamp - a.timestamp)
                const mostRecentLabel = sortedMilestones[0]?.label || 'Activity'
                return (
                  <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                    <button
                      onClick={() => setAgentExpanded(!agentExpanded)}
                      className="flex items-center justify-between w-full text-left text-sm font-medium text-text hover:text-primary-deep"
                    >
                      <span>Activity · {mostRecentLabel}</span>
                      <span className="text-xs text-text-subtle">{agentExpanded ? '▼' : '▶'}</span>
                    </button>
                    {agentExpanded && (
                      <div className="mt-2.5 space-y-1">
                        {milestones
                          .slice()
                          .sort((a, b) => a.timestamp - b.timestamp)
                          .map((milestone, idx) => {
                            const timeInfo = formatTimestampWithRelative(milestone.timestamp)
                            return (
                              <div
                                key={idx}
                                className="group relative py-1 text-sm text-text"
                                title={timeInfo.absolute}
                              >
                                {milestone.label}
                              </div>
                            )
                          })}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Emails sent - collapsible */}
              {sentEmailCount > 0 && (
                <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                  <button
                    onClick={() => setEmailsSentExpanded(!emailsSentExpanded)}
                    className="flex items-center justify-between w-full text-left text-sm font-medium text-text hover:text-primary-deep"
                  >
                    <span>Emails sent · {sentEmailCount}</span>
                    <span className="text-xs text-text-subtle">{emailsSentExpanded ? '▼' : '▶'}</span>
                  </button>
                  {emailsSentExpanded && (
                    <div className="mt-2 space-y-0.5">
                      {sentEmails
                        .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))
                        .map((email, idx) => {
                          const isExpanded = expandedEmailIds.has(email.message_id)
                          const isInitial = idx === sentEmails.length - 1
                          const timeInfo = formatTimestampWithRelative(email.received_at || email.created_at)
                          // Numbering: oldest (initial) = Email 1, newer ones = Follow-up 2, 3... (newest first)
                          const followUpNumber = sentEmails.length - idx
                          const tooltipText = `${email.subject || '(no subject)'}\nSent: ${timeInfo.absolute}`
                          return (
                            <div key={email.message_id}>
                              <button
                                onClick={() => {
                                  const newExpanded = new Set(expandedEmailIds)
                                  if (isExpanded) {
                                    newExpanded.delete(email.message_id)
                                  } else {
                                    newExpanded.add(email.message_id)
                                  }
                                  setExpandedEmailIds(newExpanded)
                                }}
                                className="w-full text-left text-xs py-1 hover:text-primary-deep flex items-center justify-between"
                                title={tooltipText}
                              >
                                <span className="font-medium text-text">
                                  {isInitial ? 'Email 1' : `Follow-up ${followUpNumber}`}
                                </span>
                                <span className="text-text-subtle">{timeInfo.relative}</span>
                              </button>
                              {isExpanded && (
                                <div className="ml-0 mt-1 space-y-1 pb-2">
                                  {email.body_text && (
                                    <Disclosure title="View sent email">
                                      <div className="text-xs text-text whitespace-pre-wrap font-mono bg-surface-2 p-2 rounded border border-border/70">
                                        {email.body_text}
                                      </div>
                                    </Disclosure>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                    </div>
                  )}
                </div>
              )}

              {/* Evidence - conditional: simple card if <=1, collapsible if >1 */}
              {(() => {
                const evidenceCount = pdfAttachments.length
                const deduplicatedAttachments = (() => {
                  const seen = new Set<string>()
                  return pdfAttachments.filter(att => {
                    const key = `${att.message_id}-${att.gmail_attachment_id || att.attachment_id}`
                    if (seen.has(key)) return false
                    seen.add(key)
                    return true
                  })
                })()
                const actualCount = deduplicatedAttachments.length

                if (actualCount <= 1) {
                  // Simple card (not collapsible)
                  if (actualCount === 0) return null
                  const attachment = deduplicatedAttachments[0]
                  const textExtractLength = attachment.text_extract 
                    ? (typeof attachment.text_extract === 'string' ? attachment.text_extract.length : 0)
                    : (attachment._extracted_length || 0)
                  const extractedLength = attachment.extracted_length || attachment._extracted_length || textExtractLength || 0
                  const isDebugExpanded = expandedDebugAttachmentIds.has(attachment.attachment_id)
                  const handleDownload = async () => {
                    try {
                      const response = await fetch(`/api/confirmations/attachments/${attachment.attachment_id}/download`)
                      if (!response.ok) throw new Error('Failed to download')
                      const blob = await response.blob()
                      const url = URL.createObjectURL(blob)
                      const link = document.createElement('a')
                      link.href = url
                      link.download = attachment.filename
                      document.body.appendChild(link)
                      link.click()
                      document.body.removeChild(link)
                      URL.revokeObjectURL(url)
                    } catch (err) {
                      console.error('Error downloading attachment:', err)
                    }
                  }

                  const baseFilename = attachment.filename.replace(/\.pdf$/i, '')
                  return (
                    <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                      <h3 className="text-sm font-semibold text-text mb-2">Evidence · {baseFilename}</h3>
                      <button
                        onClick={handleDownload}
                        className="w-full text-left text-sm font-medium text-text hover:text-primary-deep cursor-pointer underline-offset-2 hover:underline truncate"
                        title={attachment.filename}
                      >
                        {attachment.filename}
                      </button>
                      {extractedLength > 0 && (
                        <div className="mt-2">
                          <button
                            onClick={() => {
                              const newExpanded = new Set(expandedDebugAttachmentIds)
                              if (isDebugExpanded) {
                                newExpanded.delete(attachment.attachment_id)
                              } else {
                                newExpanded.add(attachment.attachment_id)
                              }
                              setExpandedDebugAttachmentIds(newExpanded)
                            }}
                            className="text-xs text-text-subtle hover:text-text-muted"
                          >
                            View extracted text (Debug only)
                          </button>
                          {isDebugExpanded && (
                            <div className="mt-1 text-xs text-text-subtle font-mono bg-surface-2 p-2 rounded border border-border/70 max-h-32 overflow-y-auto">
                              {attachment.text_extract && typeof attachment.text_extract === 'string'
                                ? attachment.text_extract.substring(0, 200) + (attachment.text_extract.length > 200 ? '...' : '')
                                : `Extracted ${extractedLength} characters`}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                } else {
                  // Collapsible accordion for multiple documents
                  return (
                    <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                      <button
                        onClick={() => setEvidenceExpanded(!evidenceExpanded)}
                        className="flex items-center justify-between w-full text-left text-sm font-medium text-text hover:text-primary-deep"
                      >
                        <span>Evidence · {actualCount} documents</span>
                        <span className="text-xs text-text-subtle">{evidenceExpanded ? '▼' : '▶'}</span>
                      </button>
                      {evidenceExpanded && (
                        <div className="mt-3">
                          {attachmentsLoading ? (
                            <div className="text-sm text-text-subtle">Checking for PDFs…</div>
                          ) : attachmentsError ? (
                            <div className="text-sm text-text-subtle">Unable to load attachments</div>
                          ) : (
                            <div className="space-y-0">
                              {deduplicatedAttachments.map((attachment) => {
                                const textExtractLength = attachment.text_extract 
                                  ? (typeof attachment.text_extract === 'string' ? attachment.text_extract.length : 0)
                                  : (attachment._extracted_length || 0)
                                const extractedLength = attachment.extracted_length || attachment._extracted_length || textExtractLength || 0
                                const isDebugExpanded = expandedDebugAttachmentIds.has(attachment.attachment_id)
                                const handleDownload = async () => {
                                  try {
                                    const response = await fetch(`/api/confirmations/attachments/${attachment.attachment_id}/download`)
                                    if (!response.ok) throw new Error('Failed to download')
                                    const blob = await response.blob()
                                    const url = URL.createObjectURL(blob)
                                    const link = document.createElement('a')
                                    link.href = url
                                    link.download = attachment.filename
                                    document.body.appendChild(link)
                                    link.click()
                                    document.body.removeChild(link)
                                    URL.revokeObjectURL(url)
                                  } catch (err) {
                                    console.error('Error downloading attachment:', err)
                                  }
                                }

                                return (
                                  <div key={attachment.attachment_id} className="py-1.5 border-b border-border/50 last:border-b-0">
                                    <button
                                      onClick={handleDownload}
                                      className="w-full text-left text-sm font-medium text-text hover:text-primary-deep cursor-pointer"
                                    >
                                      {attachment.filename}
                                    </button>
                                    {extractedLength > 0 && (
                                      <div className="mt-1.5">
                                        <button
                                          onClick={() => {
                                            const newExpanded = new Set(expandedDebugAttachmentIds)
                                            if (isDebugExpanded) {
                                              newExpanded.delete(attachment.attachment_id)
                                            } else {
                                              newExpanded.add(attachment.attachment_id)
                                            }
                                            setExpandedDebugAttachmentIds(newExpanded)
                                          }}
                                          className="text-xs text-text-subtle hover:text-text-muted"
                                        >
                                          View extracted text (Debug only)
                                        </button>
                                        {isDebugExpanded && (
                                          <div className="mt-1 text-xs text-text-subtle font-mono bg-surface-2 p-2 rounded border border-border/70 max-h-32 overflow-y-auto">
                                            {attachment.text_extract && typeof attachment.text_extract === 'string'
                                              ? attachment.text_extract.substring(0, 200) + (attachment.text_extract.length > 200 ? '...' : '')
                                              : `Extracted ${extractedLength} characters`}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                }
              })()}

              {/* Technical details - move all debug/technical content here, collapsed */}
              {(hasTechnicalDetails || DEBUG_PDF) && (
                <div className="bg-surface-2 rounded-xl border border-border/70 p-2.5">
                  <button
                    onClick={() => setTechnicalExpanded(!technicalExpanded)}
                    className="flex items-center justify-between w-full text-left text-sm font-medium text-text hover:text-primary-deep"
                  >
                    <span>Technical details</span>
                    <span className="text-xs text-text-subtle">{technicalExpanded ? '▼' : '▶'}</span>
                  </button>
                  {technicalExpanded && (
                    <div className="mt-3 space-y-3">
                      {DEBUG_PDF && (
                        <div className="space-y-3 text-xs">
                          <div>
                            <span className="font-medium text-text">Last extract-text run:</span>{' '}
                            <span className="text-text-muted">
                              {lastExtractTextRunAt ? new Date(lastExtractTextRunAt).toLocaleTimeString() : 'Never'}
                            </span>
                          </div>
                          {extractTextResults.length > 0 && (
                            <div>
                              <div className="font-medium text-text mb-2">Extract-text results:</div>
                              <div className="overflow-x-auto">
                                <table className="w-full border-collapse border border-border/70">
                                  <thead>
                                    <tr className="bg-surface-tint">
                                      <th className="border border-border/70 px-2 py-1 text-left">attachmentId</th>
                                      <th className="border border-border/70 px-2 py-1 text-left">extracted_length</th>
                                      <th className="border border-border/70 px-2 py-1 text-left">scanned_like</th>
                                      <th className="border border-border/70 px-2 py-1 text-left">skipped</th>
                                      <th className="border border-border/70 px-2 py-1 text-left">error</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {extractTextResults.map((result) => (
                                      <tr key={String(result.attachmentId || result.attachment_id)}>
                                        <td className="border border-border/70 px-2 py-1 font-mono text-xs">
                                          {String(result.attachmentId || result.attachment_id).substring(0, 8)}...
                                        </td>
                                        <td className="border border-border/70 px-2 py-1">{result.extracted_length}</td>
                                        <td className="border border-border/70 px-2 py-1">{result.scanned_like ? 'true' : 'false'}</td>
                                        <td className="border border-border/70 px-2 py-1">{result.skipped ? 'true' : 'false'}</td>
                                        <td className="border border-border/70 px-2 py-1 text-danger">{result.error || '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                          {b3Parsed && (
                            <div>
                              <div className="font-medium text-text mb-2">Parsed fields (v1):</div>
                              <Disclosure title="View parsed JSON (Debug only)">
                                <pre className="text-xs text-text font-mono bg-surface-2 p-2 rounded border border-border/70 overflow-x-auto">
                                  {JSON.stringify(b3Parsed, null, 2)}
                                </pre>
                              </Disclosure>
                            </div>
                          )}
                        </div>
                      )}
                      {hasTechnicalDetails && (
                        <div className="space-y-3">
                          {events.map((event) => {
                            const timeInfo = formatTimestampWithRelative(event.timestamp)
                            const isError = isErrorEvent(event)
                            return (
                              <div key={event.event_id} className="flex gap-3">
                                <div className={`flex-shrink-0 w-2 h-2 rounded-full mt-2 ${isError ? 'bg-danger' : 'bg-border'}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium text-text-muted mb-1">
                                    {getEventTypeLabel(event.event_type)}
                                  </div>
                                  <div className={`text-sm ${isError ? 'text-danger' : 'text-text'}`}>
                                    {event.summary}
                                  </div>
                                  <div className="text-xs text-text-subtle mt-1">
                                    {timeInfo.absolute}
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

            </>
          )}
        </div>
      </div>

      {/* Follow-up Draft Modal */}
      {showFollowupModal && followupDraft && (
        <div className="fixed inset-0 bg-shadow/20 z-50 flex items-center justify-center p-4">
          <div className="bg-surface rounded-xl shadow-lift max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col border border-border/70">
            <div className="flex-shrink-0 px-6 py-4 border-b border-border/70 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-text">Follow-up Draft</h3>
              <button
                onClick={() => {
                  setShowFollowupModal(false)
                  setFollowupDraft(null)
                }}
                className="p-2 rounded-lg hover:bg-surface-2 transition-colors"
              >
                <X className="w-5 h-5 text-text-subtle" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {followupDraft.contextSnippet && (
                <div className="bg-surface-2 rounded-lg p-3 border border-border/70">
                  <div className="text-xs font-medium text-text-muted mb-1">Context from latest reply:</div>
                  <div className="text-sm text-text font-mono whitespace-pre-wrap">{followupDraft.contextSnippet}</div>
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-text-muted block mb-1">Subject</label>
                <div className="text-sm text-text font-medium bg-surface-2 rounded-lg p-3 border border-border/70">
                  {followupDraft.subject}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-text-muted block mb-1">Body</label>
                <div className="text-sm text-text whitespace-pre-wrap bg-surface-2 rounded-lg p-3 border border-border/70 max-h-96 overflow-y-auto">
                  {followupDraft.body}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">Missing fields:</div>
                <div className="flex flex-wrap gap-2">
                  {followupDraft.missingFields.map((field) => (
                    <span key={field} className="px-2 py-1 rounded text-xs font-medium bg-warning/15 text-warning border border-warning/30">
                      {field.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex-shrink-0 px-6 py-4 border-t border-border/70 flex items-center justify-end gap-3">
              <button
                onClick={handleCopyFollowup}
                className="px-4 py-2 rounded-lg text-sm font-medium text-text bg-surface hover:bg-surface-2 border border-border/70 transition-colors"
              >
                Copy
              </button>
              <button
                onClick={handleSendFollowup}
                disabled={sending}
                className="px-4 py-2 rounded-lg text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
