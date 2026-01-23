/**
 * Acknowledgement Orchestrator
 * 
 * Minimal agentic layer for supplier confirmation workflow automation.
 * 
 * Policy version: ack_policy_v1
 */

import 'server-only'
import { getCase, addEvent, listEvents, listMessages, listAttachmentsForCase, updateCase, addMessage } from './store'
import { searchInboxForConfirmation } from './inboxSearch'
import { retrievePdfAttachmentsFromThread } from './emailAttachments'
import { generateConfirmationEmail } from './emailDraft'
import { sendNewEmail, sendReplyInThread } from './outreach'
import { parseConfirmationFieldsV1 } from './parseConfirmationFields'
import { extractTextFromPdfBase64 } from './pdfTextExtraction'
import { getDb } from './storage/sqlite'
import { transitionCase, TransitionEvent } from './stateMachine'
import { CaseState, CaseStatus } from './types'
import type { SupplierChaseCase, EventType } from './types'
import { computeMissingFields, CANONICAL_FIELD_KEYS, normalizeMissingFields } from './fieldMapping'
import { getGmailClient } from '../gmail/client'

const POLICY_VERSION = 'ack_policy_v1'

// DEMO OVERRIDE — do not use in production
// All outgoing supplier emails are redirected to this address for demo safety
const DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'

/**
 * Detect supplier exceptions in text (keywords indicating PO revisions, cancellations, price changes, MOQ issues)
 * 
 * Returns detected flags and severity level.
 */
function detectSupplierExceptions(text: string): { flags: string[]; severity: 'NONE' | 'HIGH' } {
  if (!text || typeof text !== 'string') {
    return { flags: [], severity: 'NONE' }
  }

  const lowerText = text.toLowerCase()
  const flags: string[] = []

  // PO revision / change order patterns
  const revisionPatterns = [
    /\b(?:revise|revised|revision|change\s+order|update\s+po|po\s+change|modify\s+po)\b/,
    /\b(?:amend|amendment|correction|corrected)\s+(?:po|order|purchase\s+order)\b/,
  ]

  // MOQ / minimum order quantity patterns
  const moqPatterns = [
    /\b(?:moq|minimum\s+order|min\s+qty|minimum\s+quantity)\b/,
    /\b(?:cannot|can't|unable\s+to)\s+(?:fulfill|meet|supply|deliver)\s+(?:order\s+)?(?:qty|quantity|qty\.|less\s+than)\b/,
  ]

  // Price change patterns
  const priceChangePatterns = [
    /\b(?:price\s+(?:increase|change|adjustment|update)|quote\s+(?:updated|revised|changed)|cost\s+(?:increase|change))\b/,
    /\b(?:new\s+price|updated\s+quote|revised\s+pricing|price\s+update)\b/,
  ]

  // Cancellation patterns
  const cancellationPatterns = [
    /\b(?:cancel|cancellation|cancelled|cannot\s+cancel|need\s+to\s+cancel)\b/,
    /\b(?:cannot\s+fulfill|cannot\s+meet|cannot\s+deliver|unable\s+to\s+fulfill)\b/,
    /\b(?:lead\s+time|cannot\s+meet\s+lead\s+time|delivery\s+date\s+issue)\b/,
  ]

  // Check for revision/change order
  for (const pattern of revisionPatterns) {
    if (pattern.test(lowerText)) {
      flags.push('po_revision_requested')
      break
    }
  }

  // Check for MOQ issues
  for (const pattern of moqPatterns) {
    if (pattern.test(lowerText)) {
      flags.push('moq_issue')
      break
    }
  }

  // Check for price changes
  for (const pattern of priceChangePatterns) {
    if (pattern.test(lowerText)) {
      flags.push('price_change')
      break
    }
  }

  // Check for cancellations
  for (const pattern of cancellationPatterns) {
    if (pattern.test(lowerText)) {
      flags.push('cancellation_request')
      break
    }
  }

  const severity: 'NONE' | 'HIGH' = flags.length > 0 ? 'HIGH' : 'NONE'

  return { flags, severity }
}

export interface OrchestratorInput {
  caseId: string
  mode?: 'dry_run' | 'queue_only' | 'auto_send'
  lookbackDays?: number
  debug?: boolean
  onProgress?: (message: string) => void
}

export interface EvidenceSummary {
  thread_id: string | null
  inbound_messages_count: number
  pdf_attachments_count: number
  attachments_with_text_count: number
  last_email_sent_at: number | null
  supplier_exception_flags: string[]
  supplier_exception_severity: 'NONE' | 'HIGH'
}

export interface ExtractedFieldsBest {
  supplier_order_number: { value: string | null; confidence: number }
  confirmed_delivery_date: { value: string | null; confidence: number }
  confirmed_quantity: { value: number | null; confidence: number }
  evidence_source: 'pdf' | 'email' | 'none'
}

export interface Decision {
  action_type: 'NO_OP' | 'DRAFT_EMAIL' | 'SEND_EMAIL' | 'APPLY_UPDATES_READY' | 'NEEDS_HUMAN'
  reason: string
  missing_fields_remaining: string[]
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH'
  auto_send_blocked_by?: string // Guardrail that blocked auto-send if any
  // Fields for NEEDS_HUMAN decisions
  blocking_reason?: string // e.g. "supplier_email missing", "qty mismatch", "supplier exception"
  what_agent_knows?: string[] // Short bullet list of extracted facts
  what_agent_needs?: string[] // Clear next inputs needed
}

export interface DraftedEmail {
  subject: string
  body: string
  to: string // Real supplier email (displayed in UI)
  threadId?: string
  bcc?: string // BCC recipient (always supplierbart@gmail.com for safety)
  demoModeActive?: boolean // True if DEMO_MODE is enabled - TO will be redirected on send
  demoModeMessage?: string // UI message: "Demo Mode: Email will be sent to test account"
}

export interface QueuedAction {
  action_type: string
  payload: Record<string, any>
  created_at: number
}

export interface MissingSupplierEmail {
  status: 'MISSING'
  candidates: Array<{
    email: string
    label: string
    messageId: string
    threadId: string | null
  }>
}

export interface OrchestratorResult {
  caseId: string
  policy_version: string
  state_before: string
  evidence_summary: EvidenceSummary
  extracted_fields_best: ExtractedFieldsBest | null
  decision: Decision
  drafted_email?: DraftedEmail
  queued_action?: QueuedAction
  requires_user_approval: boolean
  missing_supplier_email?: MissingSupplierEmail
}

/**
 * Build structured messaging for NEEDS_HUMAN decisions
 */
function buildNeedsHumanContext(params: {
  blockingReason: string
  extractedFields: ExtractedFieldsBest | null
  inboxClassification: 'FOUND_CONFIRMED' | 'FOUND_INCOMPLETE' | 'NOT_FOUND' | null
  missingFields: string[]
  supplierEmail?: string | null
  hasMessages: boolean
  hasPdfs: boolean
}): {
  blocking_reason: string
  what_agent_knows: string[]
  what_agent_needs: string[]
} {
  const { blockingReason, extractedFields, inboxClassification, missingFields, supplierEmail, hasMessages, hasPdfs } = params
  
  const knows: string[] = []
  const needs: string[] = []
  
  // What agent knows
  if (inboxClassification === 'FOUND_CONFIRMED' || inboxClassification === 'FOUND_INCOMPLETE') {
    knows.push('Supplier responded')
  }
  
  if (hasPdfs) {
    knows.push('PDF found')
  }
  
  if (hasMessages) {
    knows.push('Messages in thread')
  }
  
  if (extractedFields?.supplier_order_number?.value) {
    knows.push(`SO#: ${extractedFields.supplier_order_number.value}`)
  }
  
  if (extractedFields?.confirmed_delivery_date?.value) {
    knows.push(`Ship date: ${extractedFields.confirmed_delivery_date.value}`)
  }
  
  if (extractedFields?.confirmed_quantity?.value !== null) {
    knows.push(`Quantity: ${extractedFields?.confirmed_quantity?.value ?? ''}`)
  }
  
  // What agent needs
  if (!supplierEmail || supplierEmail.trim().length === 0) {
    needs.push('Supplier email')
  }
  
  // Map canonical field keys to user-friendly names
  const fieldNames: Record<string, string> = {
    'supplier_reference': 'Supplier order number',
    'delivery_date': 'Delivery date',
    'quantity': 'Quantity',
  }
  
  missingFields.forEach(field => {
    const friendlyName = fieldNames[field] || field
    if (!needs.includes(friendlyName)) {
      needs.push(friendlyName)
    }
  })
  
  // If no specific needs identified, add generic
  if (needs.length === 0 && blockingReason !== 'supplier_email missing') {
    needs.push('Manual review')
  }
  
  return {
    blocking_reason: blockingReason,
    what_agent_knows: knows.length > 0 ? knows : ['Processing case'],
    what_agent_needs: needs,
  }
}

/**
 * Policy v1: Decision rules based on evidence and case state
 * 
 * Policy version: ack_policy_v1
 * 
 * Rules (in order of evaluation):
 * 0. If supplier exception detected (revision, cancellation, price change, MOQ) -> NEEDS_HUMAN (HIGH risk) [unless just drafting clarifying email]
 * 1. If last email sent < 24h ago -> NO_OP
 * 2. If low confidence extraction (< 0.6) -> NEEDS_HUMAN (HIGH risk)
 * 3. If FOUND_CONFIRMED and has supplier_order_number + confirmed_delivery_date -> APPLY_UPDATES_READY
 * 4. If FOUND_INCOMPLETE -> DRAFT_EMAIL or SEND_EMAIL (if mode=auto_send and risk=LOW)
 * 5. If NOT_FOUND and last_action_at > 24h ago -> DRAFT_EMAIL or SEND_EMAIL (if mode=auto_send and risk=LOW)
 * 6. If NOT_FOUND and last_action_at <= 24h ago -> NO_OP
 * 
 * Risk classification:
 * - LOW: only asking for missing fields, no conflicts detected
 * - MEDIUM: supplier responded but still missing key fields (2+ missing)
 * - HIGH: low confidence extraction (< 0.6) or multiple missing fields (3+) or supplier exception detected
 */
function applyPolicyV1(params: {
  caseData: SupplierChaseCase
  inboxClassification: 'FOUND_CONFIRMED' | 'FOUND_INCOMPLETE' | 'NOT_FOUND' | null
  extractedFields: ExtractedFieldsBest | null
  missingFields: string[]
  lastEmailSentAt: number | null
  mode: 'dry_run' | 'queue_only' | 'auto_send'
  supplierExceptionFlags: string[]
  hasMessages?: boolean
  hasPdfs?: boolean
}): Decision {
  const { caseData, inboxClassification, extractedFields, missingFields, lastEmailSentAt, mode, supplierExceptionFlags, hasMessages = false, hasPdfs = false } = params
  const now = Date.now()
  const hoursSinceLastAction = lastEmailSentAt ? (now - lastEmailSentAt) / (1000 * 60 * 60) : Infinity
  
  // Note: supplier_email check is now done at send time, not here
  // Evidence discovery runs regardless of supplier_email status

  // Rule 0: If supplier exception detected -> NEEDS_HUMAN (HIGH risk)
  // Exception: If we're just drafting a clarifying email asking for missing fields WITHOUT committing to changes,
  // we can still draft, but risk must be HIGH and requires user approval
  if (supplierExceptionFlags.length > 0) {
    // If supplier is asking for changes but we're just asking for confirmation of missing fields,
    // we can draft a clarifying email, but it must be HIGH risk and needs approval
    const isClarifyingEmailOnly = inboxClassification === 'FOUND_INCOMPLETE' && missingFields.length > 0
    
    if (isClarifyingEmailOnly) {
      // Allow drafting clarifying email but set HIGH risk and require approval
      return {
        action_type: 'DRAFT_EMAIL', // Can draft but not auto-send
        reason: `Supplier exception detected (${supplierExceptionFlags.join(', ')}). Drafting clarifying email for missing fields only - requires human review before sending.`,
        missing_fields_remaining: missingFields,
        risk_level: 'HIGH',
      }
    } else {
      // In all other cases, escalate to human
      const context = buildNeedsHumanContext({
        blockingReason: `supplier exception: ${supplierExceptionFlags.join(', ')}`,
        extractedFields,
        inboxClassification,
        missingFields,
        supplierEmail: caseData.supplier_email,
        hasMessages,
        hasPdfs,
      })
      return {
        action_type: 'NEEDS_HUMAN',
        reason: `Supplier exception detected: ${supplierExceptionFlags.join(', ')}. Requires human review.`,
        missing_fields_remaining: missingFields,
        risk_level: 'HIGH',
        ...context,
      }
    }
  }
  
  // Rule 1: If last email was sent < 24h ago -> NO_OP (blocks auto-send)
  if (lastEmailSentAt && hoursSinceLastAction < 24) {
    return {
      action_type: 'NO_OP',
      reason: 'Email sent within last 24 hours, waiting for supplier response',
      missing_fields_remaining: missingFields,
      risk_level: 'LOW',
    }
  }

  // Rule 2: Check for low confidence or conflicts
  const minConfidence = Math.min(
    extractedFields?.supplier_order_number?.confidence ?? 1,
    extractedFields?.confirmed_delivery_date?.confidence ?? 1,
    extractedFields?.confirmed_quantity?.confidence ?? 1
  )
  
  // Check for risk indicators (price change, MOQ, revision requests)
  // This is a simplified check - in production would analyze email content
  const hasLowConfidence = minConfidence < 0.6 && extractedFields !== null
  const hasAnyField = extractedFields?.supplier_order_number?.value || 
                      extractedFields?.confirmed_delivery_date?.value ||
                      (extractedFields?.confirmed_quantity?.value !== null)
  
  if (hasLowConfidence && hasAnyField) {
    const context = buildNeedsHumanContext({
      blockingReason: `low confidence extraction (${Math.round(minConfidence * 100)}%)`,
      extractedFields,
      inboxClassification,
      missingFields,
      supplierEmail: caseData.supplier_email,
      hasMessages,
      hasPdfs,
    })
    return {
      action_type: 'NEEDS_HUMAN',
      reason: `Low confidence extraction (${Math.round(minConfidence * 100)}%). Requires manual review.`,
      missing_fields_remaining: missingFields,
      risk_level: 'HIGH',
      ...context,
    }
  }

  // Rule 3: If FOUND_CONFIRMED and has required fields -> APPLY_UPDATES_READY
  // Required fields: supplier_reference + delivery_date (using canonical keys)
  if (inboxClassification === 'FOUND_CONFIRMED' && extractedFields) {
    const hasSupplierRef = !!(
      extractedFields.supplier_order_number?.value &&
      extractedFields.supplier_order_number.value.trim().length > 0
    )
    const hasDeliveryDate = !!(
      extractedFields.confirmed_delivery_date?.value &&
      extractedFields.confirmed_delivery_date.value.trim().length > 0
    )
    
    if (hasSupplierRef && hasDeliveryDate) {
      return {
        action_type: 'APPLY_UPDATES_READY',
        reason: 'Found confirmed fields in supplier response. Ready to apply updates.',
        missing_fields_remaining: [], // All required fields found
        risk_level: 'LOW',
      }
    }
  }

  // Rule 4: If FOUND_INCOMPLETE -> DRAFT_EMAIL as reply
  if (inboxClassification === 'FOUND_INCOMPLETE') {
    const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 
      missingFields.length <= 1 ? 'LOW' : 
      missingFields.length <= 2 ? 'MEDIUM' : 'HIGH'
    
    // Guard: If missing fields > 3, never auto-send (must go through guardrails check)
    const canAutoSend = mode === 'auto_send' && riskLevel === 'LOW' && missingFields.length <= 3
    
    return {
      action_type: canAutoSend ? 'SEND_EMAIL' : 'DRAFT_EMAIL',
      reason: `Supplier responded but still missing: ${missingFields.join(', ')}`,
      missing_fields_remaining: missingFields,
      risk_level: riskLevel,
    }
  }

  // Rule 5: If NOT_FOUND and last_action_at > 24h ago -> DRAFT_EMAIL new thread
  if (inboxClassification === 'NOT_FOUND' || !inboxClassification) {
    const hoursSinceLastAction = (now - caseData.last_action_at) / (1000 * 60 * 60)
    
    if (hoursSinceLastAction > 24) {
      const riskLevel: 'LOW' | 'MEDIUM' = missingFields.length <= 1 ? 'LOW' : 'MEDIUM'
      
      // Guard: If missing fields > 3, never auto-send (must go through guardrails check)
      const canAutoSend = mode === 'auto_send' && riskLevel === 'LOW' && missingFields.length <= 3
      
      return {
        action_type: canAutoSend ? 'SEND_EMAIL' : 'DRAFT_EMAIL',
        reason: `No supplier response found. Drafting initial confirmation request.`,
        missing_fields_remaining: missingFields,
        risk_level: riskLevel,
      }
    } else {
      return {
        action_type: 'NO_OP',
        reason: 'Last action was less than 24 hours ago, waiting',
        missing_fields_remaining: missingFields,
        risk_level: 'LOW',
      }
    }
  }

  // Default fallback
  const context = buildNeedsHumanContext({
    blockingReason: 'unable to determine action',
    extractedFields,
    inboxClassification,
    missingFields,
    supplierEmail: caseData.supplier_email,
    hasMessages,
    hasPdfs,
  })
  return {
    action_type: 'NEEDS_HUMAN',
    reason: 'Unable to determine appropriate action based on current state',
    missing_fields_remaining: missingFields,
    risk_level: 'HIGH',
    ...context,
  }
}

/**
 * Extract candidate supplier emails from inbound messages
 */
function extractSupplierEmailCandidates(caseId: string): MissingSupplierEmail['candidates'] {
  const messages = listMessages(caseId)
  const inboundMessages = messages.filter(m => m.direction === 'INBOUND')
  const attachments = listAttachmentsForCase(caseId)
  
  // Get sender domain for filtering
  const senderEmail = process.env.GMAIL_SENDER_EMAIL || ''
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1].toLowerCase() : ''
  
  // Collect email candidates with metadata
  const emailMap = new Map<string, {
    email: string
    label: string
    messageId: string
    threadId: string | null
    hasPdf: boolean
    receivedAt: number
  }>()
  
  for (const msg of inboundMessages) {
    // Try Reply-To first, then From
    const replyTo = msg.cc ? msg.cc.split(',').map(e => e.trim()).find(e => e.includes('@')) : null
    const from = msg.from_email?.trim() || ''
    
    const candidateEmail = (replyTo || from).toLowerCase()
    
    // Filter out noreply/no-reply/donotreply
    if (candidateEmail.includes('noreply') || 
        candidateEmail.includes('no-reply') || 
        candidateEmail.includes('donotreply') ||
        candidateEmail.includes('do-not-reply') ||
        candidateEmail.includes('do_not_reply')) {
      continue
    }
    
    // Filter out our own sender domain
    if (senderDomain && candidateEmail.includes(`@${senderDomain}`)) {
      continue
    }
    
    // Skip if not a valid email
    if (!candidateEmail.includes('@') || candidateEmail.length < 3) {
      continue
    }
    
    // Check if message has PDF attachment
    const hasPdf = attachments.some(a => a.message_id === msg.message_id && a.mime_type === 'application/pdf')
    
    // Determine label
    let label = 'from email'
    if (hasPdf) {
      label = 'from ack PDF thread'
    } else if (replyTo && replyTo !== from) {
      label = 'from reply-to header'
    }
    
    const receivedAt = msg.received_at || msg.created_at
    
    // Keep best candidate per email (prefer PDF, then most recent)
    const existing = emailMap.get(candidateEmail)
    if (!existing || 
        (hasPdf && !existing.hasPdf) ||
        (hasPdf === existing.hasPdf && receivedAt > existing.receivedAt)) {
      emailMap.set(candidateEmail, {
        email: candidateEmail,
        label,
        messageId: msg.message_id,
        threadId: msg.thread_id,
        hasPdf,
        receivedAt,
      })
    }
  }
  
  // Convert to array and sort: PDFs first, then by receivedAt (most recent first)
  const candidates = Array.from(emailMap.values())
    .sort((a, b) => {
      if (a.hasPdf !== b.hasPdf) {
        return b.hasPdf ? 1 : -1 // PDFs first
      }
      return b.receivedAt - a.receivedAt // Most recent first
    })
    .map(({ email, label, messageId, threadId }) => ({
      email,
      label,
      messageId,
      threadId,
    }))
  
  return candidates
}

/**
 * Collect evidence for a case
 */
/**
 * Collect evidence regardless of supplier_email status.
 * This runs evidence discovery first, then attempts to fetch/save messages and attachments.
 */
async function collectEvidence(
  caseId: string,
  lookbackDays: number,
  debug: boolean = false,
  onProgress?: (message: string) => void
): Promise<{
  inboxClassification: 'FOUND_CONFIRMED' | 'FOUND_INCOMPLETE' | 'NOT_FOUND' | null
  threadId: string | null
  threadIdSource: 'meta' | 'inbox_search' | 'none'
  lastEmailSentAt: number | null
  messagesFound: number
  pdfsFound: number
  attachmentsSaved: number
  supplierEmailBefore: string | null
  supplierEmailAfter: string | null
}> {
  const caseData = getCase(caseId)
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`)
  }

  const supplierEmailBefore = caseData.supplier_email || null

  // Step 1: Determine threadId (prefer meta.thread_id, else run inbox search)
  let threadId: string | null = null
  let threadIdSource: 'meta' | 'inbox_search' | 'none' = 'none'
  
  const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
  if (meta.thread_id) {
    threadId = meta.thread_id
    threadIdSource = 'meta'
    if (debug) {
      console.log(`[ACK_ORCHESTRATOR] Using threadId from meta: ${threadId}`)
    }
  }

  let inboxClassification: 'FOUND_CONFIRMED' | 'FOUND_INCOMPLETE' | 'NOT_FOUND' | null = null

  // Step 2: If no threadId in meta, run inbox search to discover thread
  if (!threadId) {
    try {
      if (debug) {
        console.log(`[ACK_ORCHESTRATOR] No threadId in meta, running inbox search...`)
      }
      onProgress?.(`Searching Gmail inbox for PO ${caseData.po_number}...`)
      const searchResult = await searchInboxForConfirmation({
        caseId,
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
        supplierEmail: caseData.supplier_email || null, // May be null, that's OK
        supplierDomain: caseData.supplier_domain || null,
        optionalKeywords: [],
        lookbackDays,
      })
      
      inboxClassification = searchResult.classification
      threadId = searchResult.matchedThreadId || null
      
      if (threadId) {
        threadIdSource = 'inbox_search'
        // Persist threadId to meta
        const updatedMeta = { ...meta, thread_id: threadId }
        updateCase(caseId, { meta: updatedMeta })
        if (debug) {
          console.log(`[ACK_ORCHESTRATOR] Persisted threadId to meta: ${threadId}`)
        }
      }
    } catch (error) {
      console.error(`[ACK_ORCHESTRATOR] inbox search failed for ${caseId}:`, error)
      // Continue with null classification and threadId
    }
  }

  // Step 3: If we have threadId, fetch/save messages + attachments
  let messagesFound = 0
  let pdfsFound = 0
  let attachmentsSaved = 0

  if (threadId) {
    try {
      if (debug) {
        console.log(`[ACK_ORCHESTRATOR] Fetching messages and attachments for thread ${threadId}...`)
      }
      onProgress?.(`Downloading attachments from email thread...`)
      // This will fetch messages from thread and save them, plus retrieve PDF attachments
      const attachmentResult = await retrievePdfAttachmentsFromThread({
        caseId,
        threadId,
      })
      
      // Count messages and attachments
      const messages = listMessages(caseId)
      const attachments = listAttachmentsForCase(caseId)
      messagesFound = messages.length
      pdfsFound = attachments.filter(a => a.mime_type === 'application/pdf').length
      attachmentsSaved = attachments.length

      if (debug) {
        console.log(`[ACK_ORCHESTRATOR] Evidence loaded: ${messagesFound} messages, ${pdfsFound} PDFs, ${attachmentsSaved} total attachments`)
      }
    } catch (error) {
      console.error(`[ACK_ORCHESTRATOR] Failed to retrieve attachments from thread ${threadId}:`, error)
      // Continue - we still have message data from inbox search
    }
  }

  // Step 4: Auto-fill supplier_email from most recent inbound message if missing
  let supplierEmailAfter = supplierEmailBefore
  
  if (!caseData.supplier_email || caseData.supplier_email.trim().length === 0) {
    const messages = listMessages(caseId)
    const inboundMessages = messages.filter(m => m.direction === 'INBOUND')
    const latestInbound = inboundMessages
      .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
    
    if (latestInbound?.from_email) {
      const candidateEmail = latestInbound.from_email.trim()
      const buyerEmail = (process.env.GMAIL_SENDER_EMAIL || '').toLowerCase()
      
      // Filter out buyer email and noreply addresses
      const emailLower = candidateEmail.toLowerCase()
      const isBuyerEmail = buyerEmail && emailLower.includes(buyerEmail)
      const isNoReply = /noreply|no-reply|donotreply/i.test(candidateEmail)
      
      if (!isBuyerEmail && !isNoReply && candidateEmail.includes('@')) {
        // Extract email from "Name <email@domain.com>" format if needed
        const emailMatch = candidateEmail.match(/<([^>]+)>/) || [null, candidateEmail]
        const cleanEmail = emailMatch[1] || candidateEmail
        
        if (cleanEmail && cleanEmail.includes('@')) {
          supplierEmailAfter = cleanEmail
          updateCase(caseId, { supplier_email: cleanEmail })
          
          if (debug) {
            console.log(`[ACK_ORCHESTRATOR] Auto-filled supplier_email from inbound message: ${cleanEmail}`)
          }
          
          addEvent(caseId, {
            case_id: caseId,
            timestamp: Date.now(),
            event_type: 'AGENT_DECISION',
            summary: `Auto-filled supplier_email from inbound message: ${cleanEmail}`,
            evidence_refs_json: { message_ids: [latestInbound.message_id] },
            meta_json: { from_email: latestInbound.from_email },
          })
        }
      }
    }
  }

  // Find last email sent
  const events = listEvents(caseId)
  const lastEmailSentEvent = events
    .filter(e => e.event_type === 'EMAIL_SENT')
    .sort((a, b) => b.timestamp - a.timestamp)[0]
  const lastEmailSentAt = lastEmailSentEvent?.timestamp || null

  return {
    inboxClassification,
    threadId,
    threadIdSource,
    lastEmailSentAt,
    messagesFound,
    pdfsFound,
    attachmentsSaved,
    supplierEmailBefore,
    supplierEmailAfter,
  }
}

/**
 * Extract best fields from parsed data
 */
function extractBestFields(caseId: string): ExtractedFieldsBest | null {
  const db = getDb()
  const caseData = getCase(caseId)
  if (!caseData) return null

  // Try to get from case.meta.parsed_best_fields_v1 first (fastest)
  const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
  const parsedV1 = meta.parsed_best_fields_v1

  if (parsedV1?.fields) {
    const fields = parsedV1.fields
    return {
      supplier_order_number: {
        value: fields.supplier_order_number?.value ?? null,
        confidence: fields.supplier_order_number?.confidence ?? 0,
      },
      confirmed_delivery_date: {
        value: fields.confirmed_delivery_date?.value ?? null,
        confidence: fields.confirmed_delivery_date?.confidence ?? 0,
      },
      confirmed_quantity: {
        value: fields.confirmed_quantity?.value ?? null,
        confidence: fields.confirmed_quantity?.confidence ?? 0,
      },
      evidence_source: parsedV1.evidence_source || 'none',
    }
  }

  // Fallback: check confirmation_extractions table
  const extraction = db
    .prepare(`
      SELECT 
        supplier_order_number,
        confirmed_delivery_date,
        confirmed_quantity,
        evidence_source,
        confidence
      FROM confirmation_extractions
      WHERE case_id = ?
      LIMIT 1
    `)
    .get(caseId) as {
      supplier_order_number: string | null
      confirmed_delivery_date: string | null
      confirmed_quantity: string | null
      evidence_source: string
      confidence: number | null
    } | undefined

  if (extraction) {
    return {
      supplier_order_number: {
        value: extraction.supplier_order_number,
        confidence: (extraction.confidence ?? 0) / 100,
      },
      confirmed_delivery_date: {
        value: extraction.confirmed_delivery_date,
        confidence: (extraction.confidence ?? 0) / 100,
      },
      confirmed_quantity: {
        value: extraction.confirmed_quantity ? Number(extraction.confirmed_quantity) : null,
        confidence: (extraction.confidence ?? 0) / 100,
      },
      evidence_source: (extraction.evidence_source as 'pdf' | 'email' | 'none') || 'none',
    }
  }

  return null
}

/**
 * Build evidence summary with supplier exception detection
 */
function buildEvidenceSummary(
  caseId: string,
  threadId: string | null,
  lastEmailSentAt: number | null,
  messages: any[],
  attachments: any[]
): EvidenceSummary {
  const inboundMessages = messages.filter(m => m.direction === 'INBOUND')
  const pdfAttachments = attachments.filter(a => a.mime_type === 'application/pdf')
  const attachmentsWithText = pdfAttachments.filter(a => a.text_extract && a.text_extract.trim().length > 0)

  // Detect supplier exceptions from latest inbound email and PDF text extracts
  let allExceptionFlags: string[] = []
  let maxSeverity: 'NONE' | 'HIGH' = 'NONE'

  // Scan latest inbound email body_text
  const latestInbound = inboundMessages
    .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
  
  if (latestInbound?.body_text) {
    const emailResult = detectSupplierExceptions(latestInbound.body_text)
    allExceptionFlags.push(...emailResult.flags)
    if (emailResult.severity === 'HIGH') {
      maxSeverity = 'HIGH'
    }
  }

  // Scan PDF text extracts (check all PDFs with text)
  for (const attachment of attachmentsWithText) {
    if (attachment.text_extract) {
      const pdfResult = detectSupplierExceptions(attachment.text_extract)
      allExceptionFlags.push(...pdfResult.flags)
      if (pdfResult.severity === 'HIGH') {
        maxSeverity = 'HIGH'
      }
    }
  }

  // Deduplicate flags
  const uniqueFlags = Array.from(new Set(allExceptionFlags))

  return {
    thread_id: threadId,
    inbound_messages_count: inboundMessages.length,
    pdf_attachments_count: pdfAttachments.length,
    attachments_with_text_count: attachmentsWithText.length,
    last_email_sent_at: lastEmailSentAt,
    supplier_exception_flags: uniqueFlags,
    supplier_exception_severity: maxSeverity,
  }
}

/**
 * Check auto-send guardrails
 * Returns null if auto-send is allowed, or the guardrail name that blocks it
 */
function checkAutoSendGuardrails(
  caseData: SupplierChaseCase,
  decision: Decision,
  draftedEmail: DraftedEmail | undefined
): string | null {
  // Guard 1: Supplier email must be present (already checked in policy, but double-check)
  if (!caseData.supplier_email || caseData.supplier_email.trim().length === 0) {
    return 'missing_supplier_email'
  }

  // Guard 2: Missing fields count must be <= 3
  if (decision.missing_fields_remaining.length > 3) {
    return 'too_many_missing_fields'
  }

  // Guard 3: Drafted body length must be <= 1200 chars
  if (draftedEmail && draftedEmail.body && draftedEmail.body.length > 1200) {
    return 'email_body_too_long'
  }

  // Guard 4: Last email sent must be >= 24h ago (already checked in policy)
  // This is enforced via NO_OP decision, so no need to check here

  // All guardrails passed
  return null
}

/**
 * Generate email draft based on decision
 * 
 * The draft keeps the REAL supplier email in the `to` field for UI display.
 * Demo mode handling:
 * - If DEMO_MODE === 'true': TO will be redirected to supplierbart@gmail.com on send
 * - BCC is always set to supplierbart@gmail.com for safety/audit trail
 */
function generateDraftForDecision(
  caseData: SupplierChaseCase,
  decision: Decision,
  threadId: string | null
): DraftedEmail | undefined {
  if (decision.action_type !== 'DRAFT_EMAIL' && decision.action_type !== 'SEND_EMAIL') {
    return undefined
  }

  const emailDraft = generateConfirmationEmail({
    poNumber: caseData.po_number,
    lineId: caseData.line_id,
    supplierName: caseData.supplier_name || null,
    supplierEmail: caseData.supplier_email || '',
    missingFields: decision.missing_fields_remaining,
    context: {},
  })

  // For follow-ups, add Re: prefix
  let subject = emailDraft.subject
  if (threadId) {
    const messages = listMessages(caseData.case_id)
    const latestInbound = messages
      .filter(m => m.direction === 'INBOUND')
      .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
    
    if (latestInbound?.subject) {
      const cleanedSubject = latestInbound.subject.replace(/^Re:\s*/i, '').trim()
      subject = `Re: ${cleanedSubject}`
    } else {
      subject = `Re: ${emailDraft.subject}`
    }
  }

  // Check demo mode - if enabled, TO will be redirected on send
  const isDemoMode = process.env.DEMO_MODE === 'true'

  return {
    subject,
    body: emailDraft.bodyText,
    to: caseData.supplier_email || '', // Keep REAL supplier email for UI display
    threadId: threadId || undefined,
    bcc: DEMO_SUPPLIER_EMAIL, // Always BCC for safety/audit
    demoModeActive: isDemoMode,
    demoModeMessage: isDemoMode ? 'Demo Mode: Email will be sent to test account' : undefined,
  }
}

/**
 * Main orchestrator function
 */
export async function runAckOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const { caseId, mode = 'dry_run', lookbackDays = 90, onProgress } = input

  // Load case
  const caseData = getCase(caseId)
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`)
  }

  const stateBefore = caseData.state
  
  onProgress?.(`Starting analysis for PO ${caseData.po_number}...`)

  // Log start
  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'AGENT_ORCHESTRATE_STARTED',
    summary: `Agent orchestrator started (mode: ${mode}, policy: ${POLICY_VERSION})`,
    evidence_refs_json: null,
    meta_json: { mode, policy_version: POLICY_VERSION, lookbackDays },
  })

  // Step 1: Collect evidence (runs regardless of supplier_email status)
  const debug = input.debug === true
  const evidenceResult = await collectEvidence(caseId, lookbackDays, debug, onProgress)
  const {
    inboxClassification,
    threadId,
    threadIdSource,
    lastEmailSentAt,
    messagesFound,
    pdfsFound,
    attachmentsSaved,
    supplierEmailBefore,
    supplierEmailAfter,
  } = evidenceResult

  const messages = listMessages(caseId)
  const attachments = listAttachmentsForCase(caseId)
  const pdfAttachments = attachments.filter(a => a.mime_type === 'application/pdf')
  // Note: attachmentsWithText will be updated after parse-fields extracts text from binary_data_base64
  let attachmentsWithText = pdfAttachments.filter(a => a.text_extract && a.text_extract.trim().length > 0)
  
  // Report what we found
  const inboundCount = messages.filter(m => m.direction === 'INBOUND').length
  if (inboundCount > 0 || pdfAttachments.length > 0) {
    const parts: string[] = []
    if (inboundCount > 0) parts.push(`${inboundCount} email${inboundCount > 1 ? 's' : ''}`)
    if (pdfAttachments.length > 0) parts.push(`${pdfAttachments.length} PDF${pdfAttachments.length > 1 ? 's' : ''}`)
    onProgress?.(`Found ${parts.join(' and ')}, analyzing...`)
  } else {
    onProgress?.(`No supplier responses found yet`)
  }

  // Step 1.5: Detect supplier exceptions early (runs regardless of parse confidence)
  // This happens before field extraction to ensure exceptions are always detected
  let allExceptionFlags: string[] = []
  let maxSeverity: 'NONE' | 'HIGH' = 'NONE'

  // Scan latest inbound email body_text
  const inboundMessages = messages.filter(m => m.direction === 'INBOUND')
  const latestInbound = inboundMessages
    .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
  
  if (latestInbound?.body_text) {
    const emailResult = detectSupplierExceptions(latestInbound.body_text)
    allExceptionFlags.push(...emailResult.flags)
    if (emailResult.severity === 'HIGH') {
      maxSeverity = 'HIGH'
    }
  }

  // Scan PDF text extracts (check all PDFs with text)
  for (const attachment of attachmentsWithText) {
    if (attachment.text_extract) {
      const pdfResult = detectSupplierExceptions(attachment.text_extract)
      allExceptionFlags.push(...pdfResult.flags)
      if (pdfResult.severity === 'HIGH') {
        maxSeverity = 'HIGH'
      }
    }
  }

  // Deduplicate flags
  const uniqueExceptionFlags = Array.from(new Set(allExceptionFlags))

  // Reload case data to get updated supplier_email if auto-filled
  const caseDataAfter = getCase(caseId)
  if (!caseDataAfter) {
    throw new Error(`Case ${caseId} not found after evidence collection`)
  }

  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'AGENT_EVIDENCE_COLLECTED',
    summary: `Evidence collected: ${messages.length} messages, ${pdfAttachments.length} PDFs, ${attachmentsWithText.length} with text${uniqueExceptionFlags.length > 0 ? `, exceptions detected: ${uniqueExceptionFlags.join(', ')}` : ''}`,
    evidence_refs_json: {
      message_ids: messages.slice(0, 10).map(m => m.message_id),
      attachment_ids: attachments.slice(0, 10).map(a => a.attachment_id),
    },
    meta_json: {
      inbox_classification: inboxClassification,
      thread_id: threadId,
      thread_id_source: threadIdSource,
      inbound_messages_count: messages.filter(m => m.direction === 'INBOUND').length,
      pdf_attachments_count: pdfAttachments.length,
      attachments_with_text_count: attachmentsWithText.length,
      supplier_exception_flags: uniqueExceptionFlags,
      supplier_exception_severity: maxSeverity,
      messages_found: messagesFound,
      pdfs_found: pdfsFound,
      attachments_saved: attachmentsSaved,
      supplier_email_before: supplierEmailBefore,
      supplier_email_after: supplierEmailAfter,
    },
  })

  // Step 2: Extract best fields using full parse-fields logic
  // ALWAYS parse when evidence exists, regardless of cooldown
  // Cooldown only suppresses sending followups, not parsing
  const hasEvidence = pdfAttachments.length > 0 || inboundMessages.length > 0
  const shouldParse = hasEvidence || !extractBestFields(caseId)
  
  let extractedFields = extractBestFields(caseId)
  let evidenceExisted = false
  let parsePerformed = false
  
  // Get expectedQty from case meta (for quantity validation)
  const meta = (caseDataAfter.meta && typeof caseDataAfter.meta === 'object' ? caseDataAfter.meta : {}) as Record<string, any>
  let expectedQty: number | null = null
  if (meta.po_line && typeof meta.po_line === 'object') {
    const poLine = meta.po_line
    const paths = [
      poLine.ordered_quantity,
      poLine.ordered_qty,
      poLine.qty,
    ]
    for (const val of paths) {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        expectedQty = val
        break
      }
    }
  }
  
  // If we have evidence and no parsed fields (or should re-parse), parse using full parse-fields logic
  if (shouldParse && hasEvidence) {
    evidenceExisted = true
    parsePerformed = true
    try {
      const db = getDb()
      
      // Load all PDF attachments with binary_data_base64 (full parse-fields logic)
      const rawAttachments = db
        .prepare(
          `
          SELECT a.attachment_id, a.filename, a.text_extract, a.binary_data_base64, a.content_sha256, a.created_at,
                 m.received_at
          FROM attachments a
          INNER JOIN messages m ON m.message_id = a.message_id
          WHERE m.case_id = ?
            AND a.mime_type = 'application/pdf'
          ORDER BY m.received_at DESC, a.created_at DESC
        `
        )
        .all(caseId) as Array<{ 
          attachment_id: string
          filename: string | null
          text_extract: string | null
          binary_data_base64: string | null
          content_sha256: string | null
          created_at: number
          received_at: number | null
        }>
      
      // PDF-FIRST: Extract text from PDFs that have binary_data but no text_extract
      const pdfTexts: Array<{ attachment_id: string; text: string | null }> = []
      
      for (const att of rawAttachments) {
        let text = att.text_extract
        
        // If no text_extract but we have binary data, extract text on-the-fly
        if ((!text || text.trim().length === 0) && att.binary_data_base64) {
          try {
            console.log('[ACK_ORCHESTRATOR] extracting text from PDF', { attachment_id: att.attachment_id, has_sha256: !!att.content_sha256 })
            onProgress?.(`Extracting text from ${att.filename || 'PDF attachment'}...`)
            text = await extractTextFromPdfBase64(att.binary_data_base64)
            
            // Persist the extracted text back to the attachment for future use
            if (text && text.trim().length > 0) {
              db.prepare(`UPDATE attachments SET text_extract = ? WHERE attachment_id = ?`)
                .run(text, att.attachment_id)
              console.log('[ACK_ORCHESTRATOR] persisted text_extract', { attachment_id: att.attachment_id, textLength: text.length })
            }
          } catch (extractError) {
            console.error('[ACK_ORCHESTRATOR] PDF text extraction failed', { 
              attachment_id: att.attachment_id, 
              error: extractError instanceof Error ? extractError.message : String(extractError) 
            })
            text = null
          }
        }
        
        if (text && text.trim().length > 0) {
          pdfTexts.push({ attachment_id: att.attachment_id, text })
        }
      }
      
      // Get email text from inbound messages (FALLBACK: only if no PDF text available)
      let emailText: string | undefined = undefined
      if (pdfTexts.length === 0) {
        const latestInbound = inboundMessages
          .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
        if (latestInbound) {
          emailText = [latestInbound.subject, latestInbound.body_text].filter(Boolean).join('\n\n').trim()
          if (emailText.length === 0) {
            emailText = undefined
          }
        }
      }
      
      console.log('[ACK_ORCHESTRATOR] parsing fields', {
        caseId,
        pdfCount: rawAttachments.length,
        pdfCountWithText: pdfTexts.length,
        hasEmailText: !!emailText,
        expectedQty,
        evidencePriority: pdfTexts.length > 0 ? 'PDF' : (emailText ? 'EMAIL' : 'NONE'),
      })
      
      // Parse using full parse-fields logic with expectedQty
      const parsed = parseConfirmationFieldsV1({
        poNumber: caseDataAfter.po_number,
        lineId: caseDataAfter.line_id,
        emailText,
        pdfTexts,
        expectedQty,
        debug: debug,
      })
      
      // Convert to ExtractedFieldsBest format
      // Use supplier_confirmed_quantity for evidence-based extraction (from PDF/email)
      // confirmed_quantity is kept for backward compatibility (represents ordered_quantity)
      extractedFields = {
        supplier_order_number: {
          value: parsed.supplier_order_number.value,
          confidence: parsed.supplier_order_number.confidence,
        },
        confirmed_delivery_date: {
          value: parsed.confirmed_delivery_date.value,
          confidence: parsed.confirmed_delivery_date.confidence,
        },
        confirmed_quantity: {
          // Use supplier_confirmed_quantity for evidence-based logic
          // This represents what was extracted from PDF/email
          value: parsed.supplier_confirmed_quantity.value,
          confidence: parsed.supplier_confirmed_quantity.confidence,
        },
        evidence_source: parsed.evidence_source,
      }
      
      // Report parsed fields
      const parsedParts: string[] = []
      if (parsed.supplier_order_number.value) {
        parsedParts.push(`SO# ${parsed.supplier_order_number.value}`)
      }
      if (parsed.confirmed_delivery_date.value) {
        parsedParts.push(`Ship Date: ${parsed.confirmed_delivery_date.value}`)
      }
      if (parsed.supplier_confirmed_quantity.value !== null) {
        parsedParts.push(`Qty: ${parsed.supplier_confirmed_quantity.value}`)
      }
      if (parsedParts.length > 0) {
        onProgress?.(`Parsed fields: ${parsedParts.join(', ')}`)
      }
      
      // Update attachmentsWithText count (may have increased after text extraction)
      attachmentsWithText = pdfAttachments.filter(a => {
        // Include if it already had text, or if it was just processed
        return (a.text_extract && a.text_extract.trim().length > 0) || 
               pdfTexts.some(pt => pt.attachment_id === a.attachment_id)
      })
      
      // Persist to confirmation_extractions table (best-effort)
      try {
        const db = getDb()
        const now = Date.now()
        const lineNumber = Number.isFinite(parseInt(caseDataAfter.line_id, 10)) ? parseInt(caseDataAfter.line_id, 10) : null
        
        const existing = db
          .prepare('SELECT id FROM confirmation_extractions WHERE case_id = ?')
          .get(caseId) as { id: string } | undefined
        
        if (existing) {
          db.prepare(`
            UPDATE confirmation_extractions
            SET
              supplier_order_number = ?,
              confirmed_delivery_date = ?,
              confirmed_quantity = ?,
              evidence_source = ?,
              evidence_attachment_id = ?,
              evidence_message_id = ?,
              confidence = ?,
              raw_excerpt = ?,
              updated_at = ?
            WHERE case_id = ?
          `).run(
            parsed.supplier_order_number.value,
            parsed.confirmed_delivery_date.value,
            parsed.confirmed_quantity.value !== null ? String(parsed.confirmed_quantity.value) : null,
            parsed.evidence_source,
            parsed.supplier_order_number.attachment_id || parsed.confirmed_delivery_date.attachment_id || parsed.confirmed_quantity.attachment_id || null,
            parsed.supplier_order_number.message_id || parsed.confirmed_delivery_date.message_id || parsed.confirmed_quantity.message_id || null,
            Math.round(Math.max(parsed.supplier_order_number.confidence, parsed.confirmed_delivery_date.confidence, parsed.confirmed_quantity.confidence) * 100),
            parsed.raw_excerpt,
            now,
            caseId
          )
        }
      } catch (persistError) {
        console.warn(`[ACK_ORCHESTRATOR] failed to persist parsed fields for ${caseId}:`, persistError)
      }
    } catch (parseError) {
      console.warn(`[ACK_ORCHESTRATOR] parse fields failed for ${caseId}:`, parseError)
    }
  }

  const fieldsSummary = extractedFields
    ? {
        has_supplier_order: !!extractedFields.supplier_order_number.value,
        has_delivery_date: !!extractedFields.confirmed_delivery_date.value,
        has_quantity: extractedFields.confirmed_quantity.value !== null,
        min_confidence: Math.min(
          extractedFields.supplier_order_number.confidence,
          extractedFields.confirmed_delivery_date.confidence,
          extractedFields.confirmed_quantity.confidence
        ),
      }
    : { has_supplier_order: false, has_delivery_date: false, has_quantity: false, min_confidence: 0 }

  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'AGENT_FIELDS_EXTRACTED',
    summary: extractedFields
      ? `Extracted fields: SO#=${!!extractedFields.supplier_order_number.value}, Date=${!!extractedFields.confirmed_delivery_date.value}, Qty=${extractedFields.confirmed_quantity.value !== null} (min conf: ${Math.round(fieldsSummary.min_confidence * 100)}%)`
      : 'No fields extracted',
    evidence_refs_json: null,
    meta_json: fieldsSummary,
  })

  // Step 2.5: Recompute missing_fields using canonical keys after parsing
  const canonicalMissingFieldsBefore = normalizeMissingFields(
    Array.isArray(caseData.missing_fields) ? caseData.missing_fields : []
  )
  
  let canonicalMissingFieldsAfter: string[] = []
  if (extractedFields) {
    // Compute missing fields from extracted data using canonical keys
    canonicalMissingFieldsAfter = computeMissingFields(extractedFields)
    
    console.log('[ACK_ORCHESTRATOR] canonical missing_fields', {
      caseId,
      before: canonicalMissingFieldsBefore,
      after: canonicalMissingFieldsAfter,
      evidenceExisted,
      parsePerformed,
      cooldownBlockedSending: lastEmailSentAt && (Date.now() - lastEmailSentAt) < 24 * 60 * 60 * 1000,
    })
    
    // Persist updated missing_fields using canonical keys
    if (JSON.stringify(canonicalMissingFieldsBefore.sort()) !== JSON.stringify(canonicalMissingFieldsAfter.sort())) {
      const newState = canonicalMissingFieldsAfter.length === 0 
        ? CaseState.RESOLVED 
        : (caseData.state === CaseState.INBOX_LOOKUP || caseData.state === CaseState.OUTREACH_SENT 
           ? CaseState.WAITING 
           : CaseState.PARSED)
      
      updateCase(caseId, {
        missing_fields: canonicalMissingFieldsAfter,
        state: newState,
        ...(canonicalMissingFieldsAfter.length === 0 ? { status: CaseStatus.CONFIRMED } : {}),
      })
      
      console.log('[ACK_ORCHESTRATOR] updated missing_fields and state', {
        caseId,
        canonicalMissingFields: canonicalMissingFieldsAfter,
        newState,
        wasFullyConfirmed: canonicalMissingFieldsAfter.length === 0,
      })
    }
  } else {
    canonicalMissingFieldsAfter = canonicalMissingFieldsBefore
  }

  // Step 3: Apply policy (include exception flags from Step 1.5)
  // Use canonical missing_fields for decision-making
  // Use updated caseData (may have auto-filled supplier_email)
  const missingFields = canonicalMissingFieldsAfter
  
  // Report missing fields
  if (missingFields.length > 0) {
    const friendlyNames: Record<string, string> = {
      'supplier_reference': 'supplier order number',
      'delivery_date': 'delivery date',
      'quantity': 'quantity',
    }
    const friendly = missingFields.map(f => friendlyNames[f] || f).join(', ')
    onProgress?.(`Missing fields: ${friendly}`)
  } else if (extractedFields) {
    onProgress?.(`All confirmation fields found!`)
  }
  
  const decision = applyPolicyV1({
    caseData: caseDataAfter,
    inboxClassification,
    extractedFields,
    missingFields,
    lastEmailSentAt,
    mode,
    supplierExceptionFlags: uniqueExceptionFlags,
    hasMessages: messages.length > 0,
    hasPdfs: pdfAttachments.length > 0,
  })

  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'AGENT_DECISION',
    summary: `Decision: ${decision.action_type} (risk: ${decision.risk_level}) - ${decision.reason}`,
    evidence_refs_json: null,
    meta_json: {
      action_type: decision.action_type,
      reason: decision.reason,
      missing_fields_remaining: decision.missing_fields_remaining,
      risk_level: decision.risk_level,
      policy_version: POLICY_VERSION,
      supplier_exception_flags: uniqueExceptionFlags,
      supplier_exception_severity: maxSeverity,
    },
  })

  // Step 4: Generate draft if needed
  // Use updated caseData (may have auto-filled supplier_email)
  if (decision.action_type === 'DRAFT_EMAIL' || decision.action_type === 'SEND_EMAIL') {
    const friendlyNames: Record<string, string> = {
      'supplier_reference': 'order number',
      'delivery_date': 'delivery date',
      'quantity': 'quantity',
    }
    const requestedFields = decision.missing_fields_remaining.map(f => friendlyNames[f] || f).join(', ')
    onProgress?.(`Drafting email to request ${requestedFields || 'confirmation'}...`)
  }
  const draftedEmail = generateDraftForDecision(caseDataAfter, decision, threadId)

  // Step 5: Check auto-send guardrails (after draft is generated)
  // Supplier email check happens here - if missing, blocks auto-send
  const autoSendBlockedBy = mode === 'auto_send' && draftedEmail 
    ? checkAutoSendGuardrails(caseDataAfter, decision, draftedEmail)
    : null

  // If supplier_email is missing and we need to send, update decision to NEEDS_HUMAN
  if (draftedEmail && (!caseDataAfter.supplier_email || caseDataAfter.supplier_email.trim().length === 0)) {
    if (decision.action_type === 'DRAFT_EMAIL' || decision.action_type === 'SEND_EMAIL') {
      const context = buildNeedsHumanContext({
        blockingReason: 'supplier_email missing',
        extractedFields,
        inboxClassification,
        missingFields: decision.missing_fields_remaining,
        supplierEmail: caseDataAfter.supplier_email,
        hasMessages: messages.length > 0,
        hasPdfs: pdfAttachments.length > 0,
      })
      
      decision.action_type = 'NEEDS_HUMAN'
      decision.reason = 'Supplier email is missing. Cannot send email.'
      decision.risk_level = 'HIGH'
      decision.blocking_reason = context.blocking_reason
      decision.what_agent_knows = context.what_agent_knows
      decision.what_agent_needs = context.what_agent_needs
      
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'AGENT_DECISION',
        summary: 'Supplier email missing - needs human input',
        evidence_refs_json: null,
        meta_json: {
          action_type: 'NEEDS_HUMAN',
          reason: 'Supplier email is missing. Cannot send email.',
          supplier_email_before: supplierEmailBefore,
          supplier_email_after: supplierEmailAfter,
          ...context,
        },
      })
    }
  }

  // Update decision if guardrail blocks auto-send
  if (autoSendBlockedBy && decision.action_type === 'SEND_EMAIL') {
    decision.action_type = 'DRAFT_EMAIL'
    decision.auto_send_blocked_by = autoSendBlockedBy
    decision.reason = `${decision.reason} (auto-send blocked by guardrail: ${autoSendBlockedBy})`
    
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'AGENT_EMAIL_SKIPPED',
      summary: `Auto-send blocked by guardrail: ${autoSendBlockedBy}`,
      evidence_refs_json: null,
      meta_json: {
        guardrail: autoSendBlockedBy,
        original_action: 'SEND_EMAIL',
        final_action: 'DRAFT_EMAIL',
        mode: 'auto_send',
        reason: `Auto-send requested but blocked by guardrail: ${autoSendBlockedBy}`,
      },
    })
  }

  // Handle NEEDS_HUMAN decision based on mode
  if (decision.action_type === 'NEEDS_HUMAN') {
    if (mode === 'auto_send') {
      // In auto_send mode, escalate state to ESCALATED
      transitionCase({
        caseId,
        toState: CaseState.ESCALATED,
        event: TransitionEvent.NEEDS_HUMAN_ESCALATION,
        summary: `Case escalated: ${decision.reason}`,
      })
    } else {
      // In dry_run/queue_only modes, log event but do NOT change state
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'AGENT_DECISION',
        summary: `Case needs human review: ${decision.reason} (mode: ${mode}, state unchanged)`,
        evidence_refs_json: null,
        meta_json: {
          decision_action: 'NEEDS_HUMAN',
          reason: decision.reason,
          risk_level: decision.risk_level,
          mode,
          state_unchanged: true,
          would_escalate_in_auto_send: true,
        },
      })
    }
  }

  // Step 5.5: Queue action if needed
  let queuedAction: QueuedAction | undefined = undefined
  const requiresUserApproval = decision.action_type !== 'NO_OP' && 
                                (mode === 'dry_run' || 
                                 mode === 'queue_only' || 
                                 decision.risk_level === 'HIGH' ||
                                 autoSendBlockedBy !== null ||
                                 (decision.action_type === 'APPLY_UPDATES_READY' && mode !== 'auto_send'))

  if (decision.action_type !== 'NO_OP' && decision.action_type !== 'NEEDS_HUMAN') {
    queuedAction = {
      action_type: decision.action_type,
      payload: {
        subject: draftedEmail?.subject,
        body: draftedEmail?.body,
        threadId: draftedEmail?.threadId,
        missingFields: decision.missing_fields_remaining,
      },
      created_at: Date.now(),
    }

    // Store in case.meta.agent_queue
    const meta = (caseDataAfter.meta && typeof caseDataAfter.meta === 'object' ? caseDataAfter.meta : {}) as Record<string, any>
    if (!meta.agent_queue || !Array.isArray(meta.agent_queue)) {
      meta.agent_queue = []
    }
    meta.agent_queue.push(queuedAction)
    updateCase(caseId, { meta })

    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'AGENT_DECISION',
      summary: `Action queued: ${decision.action_type}`,
      evidence_refs_json: null,
      meta_json: { queued_action: queuedAction },
    })
  }

  // Step 6: Auto-send if mode allows and guardrails pass
  if (decision.action_type === 'SEND_EMAIL' && mode === 'auto_send' && draftedEmail && !autoSendBlockedBy) {
    try {
      // Demo mode handling:
      // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
      // - Always add BCC to supplierbart@gmail.com for safety/audit
      const originalTo = draftedEmail.to
      const isDemoMode = process.env.DEMO_MODE === 'true'
      const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : originalTo
      const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
      
      console.log('[ACK_ORCHESTRATOR] sending email', {
        demoMode: isDemoMode,
        displayTo: originalTo,
        actualTo,
        bcc,
      })
      
      let gmailMessageId: string | undefined
      let finalThreadId: string | undefined
      
      if (draftedEmail.threadId) {
        // Send reply in thread
        const replyResult = await sendReplyInThread({
          threadId: draftedEmail.threadId,
          to: actualTo,
          subject: draftedEmail.subject,
          bodyText: draftedEmail.body,
          bcc,
        })
        gmailMessageId = replyResult.gmailMessageId
        finalThreadId = replyResult.threadId
      } else {
        // Send new email
        const sendResult = await sendNewEmail({
          to: actualTo,
          subject: draftedEmail.subject,
          bodyText: draftedEmail.body,
          bcc,
        })
        gmailMessageId = sendResult.gmailMessageId
        finalThreadId = sendResult.threadId
      }

      if (gmailMessageId) {
        // Persist outbound message (store actual recipient and original for audit)
        addMessage(caseId, {
          message_id: gmailMessageId,
          case_id: caseId,
          direction: 'OUTBOUND',
          thread_id: finalThreadId || null,
          from_email: process.env.GMAIL_SENDER_EMAIL || null,
          to_email: actualTo, // Store actual recipient
          cc: null,
          subject: draftedEmail.subject,
          body_text: draftedEmail.body,
          received_at: Date.now(),
        })

        // Update threadId in meta
        const meta = (caseDataAfter.meta && typeof caseDataAfter.meta === 'object' ? caseDataAfter.meta : {}) as Record<string, any>
        if (finalThreadId) {
          meta.thread_id = finalThreadId
          meta.last_sent_thread_id = finalThreadId
        }
        if (gmailMessageId) {
          meta.last_sent_message_id = gmailMessageId
          meta.last_sent_at = Date.now()
          meta.last_sent_subject = draftedEmail.subject
        }

        // Build summary based on mode
        const summaryText = isDemoMode
          ? `Agent auto-sent email: ${draftedEmail.subject} (demo mode: sent to ${actualTo})`
          : `Agent auto-sent email: ${draftedEmail.subject} (bcc: ${bcc})`

        // Update case state via transitionCase
        transitionCase({
          caseId,
          toState: CaseState.OUTREACH_SENT,
          event: TransitionEvent.OUTREACH_SENT_OK,
          summary: summaryText,
          patch: {
            meta,
            last_action_at: Date.now(),
            touch_count: caseDataAfter.touch_count + 1,
          },
        })

        addEvent(caseId, {
          case_id: caseId,
          timestamp: Date.now(),
          event_type: 'AGENT_EMAIL_SENT',
          summary: summaryText,
          evidence_refs_json: {
            message_ids: [gmailMessageId],
            attachment_ids: [],
          },
          meta_json: {
            subject: draftedEmail.subject,
            threadId: finalThreadId,
            gmailMessageId,
            demo_mode: isDemoMode,
            display_to: originalTo, // What UI showed
            actual_to: actualTo, // Where email was sent
            bcc,
          },
        })
      }
    } catch (error) {
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'AGENT_EMAIL_SKIPPED',
        summary: `Agent email send error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        evidence_refs_json: null,
        meta_json: { error: error instanceof Error ? error.message : 'Unknown error' },
      })
    }
  } else if (decision.action_type === 'NO_OP' && mode === 'auto_send') {
    // Log that auto-send was requested but blocked by NO_OP (e.g., email sent < 24h ago)
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'AGENT_EMAIL_SKIPPED',
      summary: `Auto-send blocked: ${decision.reason}`,
      evidence_refs_json: null,
      meta_json: {
        guardrail: 'no_op_decision',
        reason: decision.reason,
        mode: 'auto_send',
      },
    })
  }

  // Build evidence summary (includes exception flags)
  const evidenceSummary = buildEvidenceSummary(caseId, threadId, lastEmailSentAt, messages, attachments)

  // Extract supplier email candidates if missing (use updated caseDataAfter)
  let missingSupplierEmail: MissingSupplierEmail | undefined = undefined
  if (!caseDataAfter.supplier_email || caseDataAfter.supplier_email.trim().length === 0) {
    const candidates = extractSupplierEmailCandidates(caseId)
    if (candidates.length > 0) {
      missingSupplierEmail = {
        status: 'MISSING',
        candidates,
      }
    }
  }

  return {
    caseId,
    policy_version: POLICY_VERSION,
    state_before: stateBefore,
    evidence_summary: evidenceSummary,
    extracted_fields_best: extractedFields,
    decision,
    drafted_email: draftedEmail,
    queued_action: queuedAction,
    requires_user_approval: requiresUserApproval,
    missing_supplier_email: missingSupplierEmail,
  }
}
