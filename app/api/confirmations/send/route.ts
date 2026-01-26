import { NextRequest, NextResponse } from 'next/server'
import { searchInboxForConfirmation, type SearchResult } from '@/src/lib/supplier-agent/inboxSearch'
import { sendNewEmail, sendReplyInThread } from '@/src/lib/supplier-agent/outreach'
import { generateConfirmationEmail } from '@/src/lib/supplier-agent/emailDraft'
import { getCase, updateCase, addEvent, addMessage } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'
import { transitionCase, TransitionEvent } from '@/src/lib/supplier-agent/stateMachine'

export const runtime = 'nodejs'

// DEMO OVERRIDE — do not use in production
// All outgoing supplier emails are redirected to this address for demo safety
const DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'

/**
 * POST /api/confirmations/send
 * 
 * Sends supplier confirmation email (new or reply in thread).
 * Optionally runs inbox search first to determine if reply is needed.
 * 
 * Manual test instructions:
 * 1) Ensure Gmail auth connected as lisa.acmebuyer@gmail.com
 *    GET /api/gmail/status
 * 
 * 2) Create a case (use POST /api/confirmations/cases or seed directly in SQLite)
 * 
 * 3) Call:
 * POST /api/confirmations/send
 * {
 *   "caseId": "<yourCaseId>",
 *   "poNumber": "907255",
 *   "lineId": "1",
 *   "supplierEmail": "noura.liben@gmail.com",
 *   "missingFields": ["delivery_date"],
 *   "runInboxSearch": true
 * }
 * 
 * Expected:
 * - If inbox search finds an existing thread incomplete:
 *   action == "REPLY_IN_THREAD"
 *   threadId returned
 * - Otherwise:
 *   action == "SEND_NEW"
 * 
 * 4) Confirm in Gmail UI (Lisa inbox) that email was sent and appears in correct thread.
 */
export async function POST(request: NextRequest) {
  console.log('[SEND_ROUTE] hit')
  
  let caseId: string | undefined = undefined
  
  try {
    const body = await request.json()
    caseId = body.caseId
    
    // [SEND] start - minimal debug log
    console.log('[SEND] start', { caseId })
    
    console.log('[SEND_ROUTE] parsed body', {
      caseId: body.caseId || null,
      hasSubject: !!body.subject,
      hasBody: !!body.body,
      missingFieldsCount: Array.isArray(body.missingFields) ? body.missingFields.length : 0,
      runInboxSearch: body.runInboxSearch !== false,
      poNumber: body.poNumber || null,
      lineId: body.lineId || null,
      supplierEmail: body.supplierEmail || null,
      intent: body.intent || null,
      forceSend: body.forceSend === true,
    })
    
    // Support two payload shapes:
    // 1. Full payload: { caseId, poNumber, lineId, supplierEmail, missingFields, ... }
    // 2. Minimal with caseId: { caseId, subject, body, ... } - will look up case
    // Note: caseId already declared above, just reassign here
    caseId = body.caseId
    let poNumber = body.poNumber
    let lineId = body.lineId
    let supplierEmail = body.supplierEmail
    let missingFields = body.missingFields
    
    // If minimal payload, look up case
    if (caseId && (!poNumber || !lineId || !supplierEmail || !missingFields)) {
      const { getCase } = await import('@/src/lib/supplier-agent/store')
      const caseData = getCase(caseId)
      if (!caseData) {
        console.log('[SEND_ROUTE] case not found', { caseId })
        return NextResponse.json(
          { ok: false, error: `Case ${caseId} not found` },
          { status: 404 }
        )
      }
      // Fill in missing fields from case
      if (!poNumber) poNumber = caseData.po_number
      if (!lineId) lineId = caseData.line_id
      if (!supplierEmail) supplierEmail = caseData.supplier_email || ''
      if (!missingFields) missingFields = Array.isArray(caseData.missing_fields) ? caseData.missing_fields : []
    }
    
    // Validate required fields
    if (!caseId || !poNumber || !lineId || !supplierEmail || !missingFields) {
      const missing: string[] = []
      if (!caseId) missing.push('caseId')
      if (!poNumber) missing.push('poNumber')
      if (!lineId) missing.push('lineId')
      if (!supplierEmail) missing.push('supplierEmail')
      if (!missingFields) missing.push('missingFields')
      console.log('[SEND_ROUTE] validation failed', { missing })
      return NextResponse.json(
        { ok: false, error: `Missing required fields: ${missing.join(', ')}` },
        { status: 400 }
      )
    }
    
    const {
      supplierName,
      optionalKeywords,
      runInboxSearch = true,
      subject,
      body: bodyText,
      intent,
      forceSend = false,
      threadId: requestThreadId,
    } = body
    
    // Load case (already validated above, but ensure it exists)
    const caseData = getCase(caseId)
    if (!caseData) {
      console.log('[SEND_ROUTE] case not found after validation', { caseId })
      return NextResponse.json(
        { ok: false, error: `Case ${caseId} not found` },
        { status: 404 }
      )
    }

    // [SEND] Log A: Start of handler with case details
    console.info('[SEND] handler start', {
      caseId,
      currentState: caseData.state,
      forceSend: forceSend || false,
      poNumber,
      lineId,
      supplierEmail,
    })
    
    console.log('[SEND_ROUTE] resolved case details', {
      poNumber,
      lineId,
      supplierEmail,
      threadId: (caseData.meta as any)?.thread_id || (caseData.meta as any)?.gmail_threadId || null,
    })
    
    // Use provided subject/body if available (from follow-up draft), otherwise generate
    let emailDraft: { subject: string; bodyText: string }
    if (subject && bodyText) {
      emailDraft = { subject, bodyText }
    } else {
      emailDraft = generateConfirmationEmail({
        poNumber,
        lineId,
        supplierName: supplierName || caseData.supplier_name,
        supplierEmail,
        missingFields,
        context: caseData.meta as any,
      })
    }
    
    // Log EMAIL_DRAFTED event
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'EMAIL_DRAFTED',
      summary: `Drafted confirmation email for PO ${poNumber} Line ${lineId}`,
      evidence_refs_json: null,
      meta_json: {
        missingFields,
        subject: emailDraft.subject,
      },
    })
    
    let action: 'REPLY_IN_THREAD' | 'SEND_NEW' | 'NO_OP' | 'sent' = 'SEND_NEW'
    let gmailMessageId: string | undefined
    let threadId: string | undefined = requestThreadId || (caseData.meta as any)?.thread_id || (caseData.meta as any)?.gmail_threadId || undefined
    let missingFieldsAsked: string[] = missingFields
    let searchResult: any = null
    let usedReply = false
    // Use provided subject/body if available, otherwise use draft
    let sentSubject = subject || emailDraft.subject
    let sentBodyText = bodyText || emailDraft.bodyText
    
    // If forceSend is true, bypass NO_OP logic and always send
    // Also check request missingFields: if provided and non-empty, NOT confirmed
    const isForced = forceSend === true
    const requestHasMissingFields = Array.isArray(missingFields) && missingFields.length > 0
    const isConfirmed = !requestHasMissingFields // If request says missingFields.length > 0, it's NOT confirmed
    
    // For follow-up intents with forceSend, always send as reply if threadId exists or can be found
    if (intent === 'followup' && isForced) {
      console.log('[SEND_ROUTE] bypass NO_OP due to forceSend')
      
      // For follow-ups, need to find the reply anchor (most recent inbound supplier message)
      let replyToMessageId: string | undefined
      let originalSubject: string | undefined
      
      // If threadId not provided but runInboxSearch is true, try to find it and reply anchor
      if (runInboxSearch) {
        try {
          searchResult = await searchInboxForConfirmation({
            caseId,
            poNumber,
            lineId,
            supplierEmail: caseData.supplier_email || supplierEmail,
            supplierDomain: caseData.supplier_domain || null,
            optionalKeywords: optionalKeywords || [],
            lookbackDays: 90,
          })
          
          if (searchResult?.matchedThreadId) {
            threadId = searchResult.matchedThreadId
            console.log('[SEND_ROUTE] found threadId from inbox search', { threadId })
          }
          
          // Find the most recent inbound supplier message from topCandidates
          if (searchResult?.topCandidates && Array.isArray(searchResult.topCandidates)) {
            const buyerEmail = (process.env.GMAIL_SENDER_EMAIL || '').toLowerCase()
            
            // Filter to inbound supplier messages (from != buyer)
            const inboundSupplierMessages = searchResult.topCandidates
              .filter((candidate: SearchResult['topCandidates'][0]) => {
                const fromEmail = (candidate.from || '').toLowerCase()
                // Message is from supplier if from doesn't include buyer email
                return !buyerEmail || !fromEmail.includes(buyerEmail)
              })
              .sort((a: SearchResult['topCandidates'][0], b: SearchResult['topCandidates'][0]) => (b.date || 0) - (a.date || 0)) // Most recent first
            
            if (inboundSupplierMessages.length > 0) {
              const anchor = inboundSupplierMessages[0]
              replyToMessageId = anchor.messageId
              originalSubject = anchor.subject || undefined
              threadId = anchor.threadId || threadId
              
              console.log('[SEND_ROUTE] chosen reply anchor', {
                replyToMessageId: anchor.messageId,
                threadId: anchor.threadId,
                from: anchor.from,
                date: anchor.date ? new Date(anchor.date).toISOString() : null,
              })
            }
          }
        } catch (searchError) {
          console.warn('[SEND_ROUTE] inbox search failed for follow-up, continuing with send', searchError)
        }
      }
      
      // Send as reply in thread if threadId exists, otherwise send new
      if (threadId) {
        action = 'REPLY_IN_THREAD'
        usedReply = true
        
        console.log('[SEND_ROUTE] followup reply headers', {
          threadId,
          replyToMessageId,
          subject: sentSubject,
        })
        
        // Demo mode handling:
        // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
        // - Always add BCC to supplierbart@gmail.com for safety
        const isDemoMode = process.env.DEMO_MODE === 'true'
        const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : supplierEmail
        const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
        
        console.log('[SEND_ROUTE] sending followup reply', {
          threadId,
          replyToMessageId,
          displayTo: supplierEmail,
          actualTo,
          bcc,
          demoMode: isDemoMode,
          subject: sentSubject,
        })
        
        const replyResult = await sendReplyInThread({
          threadId: threadId!,
          to: actualTo,
          subject: sentSubject,
          bodyText: sentBodyText,
          replyToMessageId,
          originalSubject,
          bcc,
        })
        
        console.log('[SEND_ROUTE] gmail response', {
          id: replyResult.gmailMessageId,
          threadId: replyResult.threadId,
        })
        
        // [SEND] Log B: After Gmail send returns (followup reply)
        console.info('[SEND] gmail send returned', {
          caseId,
          gmailMessageId: replyResult.gmailMessageId,
          threadId: replyResult.threadId,
          action: 'REPLY_IN_THREAD',
        })
        
        gmailMessageId = replyResult.gmailMessageId
        threadId = replyResult.threadId
        
        // [SEND] gmail result - minimal debug log
        console.log('[SEND] gmail result', { gmailMessageId, threadId })
      } else {
        // No threadId found, send as new email
        action = 'SEND_NEW'
        
        // Demo mode handling:
        // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
        // - Always add BCC to supplierbart@gmail.com for safety
        const isDemoMode = process.env.DEMO_MODE === 'true'
        const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : supplierEmail
        const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
        
        console.log('[SEND_ROUTE] sending followup as new email (no threadId)', {
          displayTo: supplierEmail,
          actualTo,
          bcc,
          demoMode: isDemoMode,
          subject: sentSubject,
        })
        
        const sendResult = await sendNewEmail({
          to: actualTo,
          subject: sentSubject,
          bodyText: sentBodyText,
          bcc,
        })
        
        console.log('[SEND_ROUTE] gmail response', {
          id: sendResult.gmailMessageId,
          threadId: sendResult.threadId,
        })
        
        // [SEND] Log B: After Gmail send returns (followup new)
        console.info('[SEND] gmail send returned', {
          caseId,
          gmailMessageId: sendResult.gmailMessageId,
          threadId: sendResult.threadId,
          action: 'SEND_NEW',
        })
        
        gmailMessageId = sendResult.gmailMessageId
        threadId = sendResult.threadId
        
        // [SEND] gmail result - minimal debug log
        console.log('[SEND] gmail result', { gmailMessageId, threadId })
      }
    } else if (runInboxSearch && !isForced) {
      // Run inbox search if requested and not forced
      try {
        searchResult = await searchInboxForConfirmation({
          caseId,
          poNumber,
          lineId,
          supplierEmail: caseData.supplier_email || supplierEmail,
          supplierDomain: caseData.supplier_domain || null,
          optionalKeywords: optionalKeywords || [],
          lookbackDays: 90,
        })
        
        // Check if confirmed - use request missingFields if provided, otherwise use search result
        const shouldSkip = searchResult.classification === 'FOUND_CONFIRMED' && !requestHasMissingFields
        
        if (shouldSkip) {
          // Found prior confirmation, no outreach needed (only if request doesn't have missingFields)
          addEvent(caseId, {
            case_id: caseId,
            timestamp: Date.now(),
            event_type: 'CASE_RESOLVED',
            summary: 'Found prior confirmation; no outreach sent',
            evidence_refs_json: {
              message_ids: searchResult.matchedMessageIds,
              attachment_ids: [],
            },
            meta_json: {
              searchResult: {
                classification: searchResult.classification,
                matchedThreadId: searchResult.matchedThreadId,
              },
            },
          })
          
          console.log('[SEND_ROUTE] NO_OP - found confirmed')
          return NextResponse.json({
            ok: true,
            action: 'NO_OP',
            reason: 'FOUND_CONFIRMED',
            searchResult,
          })
        } else if (searchResult.classification === 'FOUND_INCOMPLETE') {
          // Reply in existing thread with only remaining missing fields
          action = 'REPLY_IN_THREAD'
          threadId = searchResult.matchedThreadId
          missingFieldsAsked = searchResult.missingFields
          usedReply = true
          
          // Use provided subject/body if available (from follow-up draft), otherwise regenerate
          if (subject && bodyText) {
            sentSubject = subject
            sentBodyText = bodyText
          } else {
            // Regenerate email for only remaining missing fields
            const replyEmail = generateConfirmationEmail({
              poNumber,
              lineId,
              supplierName: supplierName || caseData.supplier_name,
              supplierEmail,
              missingFields: searchResult.missingFields,
              context: caseData.meta as any,
            })
            
            sentSubject = replyEmail.subject
            sentBodyText = replyEmail.bodyText
          }
          
          // Demo mode handling:
          // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
          // - Always add BCC to supplierbart@gmail.com for safety
          const isDemoMode = process.env.DEMO_MODE === 'true'
          const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : supplierEmail
          const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
          
          console.log('[SEND_ROUTE] about to call gmail (reply in thread)', {
            displayTo: supplierEmail,
            actualTo,
            bcc,
            demoMode: isDemoMode,
          })
          const replyResult = await sendReplyInThread({
            threadId: threadId!,
            to: actualTo,
            subject: sentSubject,
            bodyText: sentBodyText,
            bcc,
          })
          
          console.log('[SEND_ROUTE] gmail response (reply)', {
            id: replyResult.gmailMessageId,
            threadId: replyResult.threadId,
          })
          
          // [SEND] Log B: After Gmail send returns (inbox search reply)
          console.info('[SEND] gmail send returned', {
            caseId,
            gmailMessageId: replyResult.gmailMessageId,
            threadId: replyResult.threadId,
            action: 'REPLY_IN_THREAD',
          })
          
          gmailMessageId = replyResult.gmailMessageId
          threadId = replyResult.threadId
          
          // [SEND] gmail result - minimal debug log
          console.log('[SEND] gmail result', { gmailMessageId, threadId })
        } else {
          // NOT_FOUND - send new email
          action = 'SEND_NEW'
          
          // Demo mode handling:
          // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
          // - Always add BCC to supplierbart@gmail.com for safety
          const isDemoMode = process.env.DEMO_MODE === 'true'
          const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : supplierEmail
          const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
          
          console.log('[SEND_ROUTE] about to call gmail (new email)', {
            displayTo: supplierEmail,
            actualTo,
            bcc,
            demoMode: isDemoMode,
          })
          const sendResult = await sendNewEmail({
            to: actualTo,
            subject: emailDraft.subject,
            bodyText: emailDraft.bodyText,
            bcc,
          })
          
          console.log('[SEND_ROUTE] gmail response (new)', {
            id: sendResult.gmailMessageId,
            threadId: sendResult.threadId,
          })
          
          // [SEND] Log B: After Gmail send returns (inbox search new)
          console.info('[SEND] gmail send returned', {
            caseId,
            gmailMessageId: sendResult.gmailMessageId,
            threadId: sendResult.threadId,
            action: 'SEND_NEW',
          })
          
          gmailMessageId = sendResult.gmailMessageId
          threadId = sendResult.threadId
          
          // [SEND] gmail result - minimal debug log
          console.log('[SEND] gmail result', { gmailMessageId, threadId })
        }
      } catch (searchError) {
        console.error('[SEND_ROUTE] error during inbox search, falling back to new email:', searchError)
        // Fall through to send new email
        
        // Demo mode handling:
        // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
        // - Always add BCC to supplierbart@gmail.com for safety
        const isDemoMode = process.env.DEMO_MODE === 'true'
        const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : supplierEmail
        const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
        
        console.log('[SEND_ROUTE] about to call gmail (fallback after search error)', {
          displayTo: supplierEmail,
          actualTo,
          bcc,
          demoMode: isDemoMode,
        })
        const sendResult = await sendNewEmail({
          to: actualTo,
          subject: emailDraft.subject,
          bodyText: emailDraft.bodyText,
          bcc,
        })
        
        console.log('[SEND_ROUTE] gmail response (fallback)', {
          id: sendResult.gmailMessageId,
          threadId: sendResult.threadId,
        })
        
        // [SEND] Log B: After Gmail send returns (fallback)
        console.info('[SEND] gmail send returned', {
          caseId,
          gmailMessageId: sendResult.gmailMessageId,
          threadId: sendResult.threadId,
          action: 'SEND_NEW',
        })
        
        gmailMessageId = sendResult.gmailMessageId
        threadId = sendResult.threadId
        
        // [SEND] gmail result - minimal debug log
        console.log('[SEND] gmail result', { gmailMessageId, threadId })
      }
    } else {
      // This covers:
      // 1. forceSend=true with intent='initial' (not 'followup') - send new email directly
      // 2. !isForced and !runInboxSearch - send new email without search
      
      console.log('[SEND_ROUTE] sending new email (forceSend/initial or no search)', {
        intent,
        isForced,
        runInboxSearch,
      })
      
      // Demo mode handling:
      // - If DEMO_MODE === 'true': redirect TO to supplierbart@gmail.com
      // - Always add BCC to supplierbart@gmail.com for safety
      const isDemoMode = process.env.DEMO_MODE === 'true'
      const actualTo = isDemoMode ? DEMO_SUPPLIER_EMAIL : supplierEmail
      const bcc = DEMO_SUPPLIER_EMAIL // Always BCC for safety
      
      console.log('[SEND_ROUTE] about to call gmail (forceSend/initial or no search)', {
        displayTo: supplierEmail,
        actualTo,
        bcc,
        demoMode: isDemoMode,
      })
      const sendResult = await sendNewEmail({
        to: actualTo,
        subject: emailDraft.subject,
        bodyText: emailDraft.bodyText,
        bcc,
      })
      
      console.log('[SEND_ROUTE] gmail response (forceSend/initial or no search)', {
        id: sendResult.gmailMessageId,
        threadId: sendResult.threadId,
      })
      
      // [SEND] Log B: After Gmail send returns
      console.info('[SEND] gmail send returned', {
        caseId,
        gmailMessageId: sendResult.gmailMessageId,
        threadId: sendResult.threadId,
        action: 'SEND_NEW',
      })
      
      gmailMessageId = sendResult.gmailMessageId
      threadId = sendResult.threadId
      
      // [SEND] gmail result - minimal debug log
      console.log('[SEND] gmail result', { gmailMessageId, threadId })
    }
    
    // Persist outbound message
    if (gmailMessageId) {
      addMessage(caseId, {
        message_id: gmailMessageId,
        case_id: caseId,
        direction: 'OUTBOUND',
        thread_id: threadId || null,
        from_email: process.env.GMAIL_SENDER_EMAIL || null,
        to_email: supplierEmail,
        cc: null,
        subject: sentSubject,
        body_text: sentBodyText,
        received_at: Date.now(),
      })
      
      // Build meta updates for threadId and last sent message info
      const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
      if (threadId) {
        if (meta.thread_id !== threadId) {
          meta.thread_id = threadId
        }
        meta.last_sent_thread_id = threadId
      }
      if (gmailMessageId) {
        meta.last_sent_message_id = gmailMessageId
        meta.last_sent_at = Date.now()
        meta.last_sent_subject = sentSubject
      }
      console.log('[THREAD_PERSIST] send', { caseId, threadId, gmailMessageId })
      
      // Update case state via transitionCase (only if email was actually sent)
      // Get current state before transition for logging
      const fromState = caseData.state
      
      // [SEND] transitioning case - log before transition
      console.log('[SEND] transitioning case', {
        caseId,
        fromState,
        toState: CaseState.OUTREACH_SENT,
      })
      
      try {
        transitionCase({
          caseId,
          toState: CaseState.OUTREACH_SENT,
          event: TransitionEvent.OUTREACH_SENT_OK,
          summary: `Sent confirmation email for PO ${poNumber} Line ${lineId}${usedReply ? ' (reply in thread)' : ' (new email)'}`,
          patch: {
            status: CaseStatus.STILL_AMBIGUOUS,
            meta,
            last_action_at: Date.now(),
            touch_count: caseData.touch_count + 1,
          },
        })
        
        // [SEND] Log: Success - add event
        addEvent(caseId, {
          case_id: caseId,
          timestamp: Date.now(),
          event_type: 'EMAIL_SENT',
          summary: `Sent outreach email for PO ${poNumber} Line ${lineId}${usedReply ? ' (reply in thread)' : ' (new email)'}`,
          evidence_refs_json: {
            message_ids: gmailMessageId ? [gmailMessageId] : [],
            attachment_ids: [],
          },
          meta_json: {
            threadId,
            to: supplierEmail,
            usedReply,
            missingFieldsAsked,
            gmailMessageId,
          },
        })
        
        // Fetch case again after transition to get updated state
        const updatedCase = getCase(caseId)
        if (!updatedCase) {
          console.error('[SEND] case not found after transition', { caseId })
        } else {
          // [SEND] transitioned - log after successful transition
          console.log('[SEND] transitioned', {
            caseId,
            newState: updatedCase.state,
            next_check_at: updatedCase.next_check_at,
          })
        }
        
        console.info('[SEND] transitionCase succeeded', { caseId, toState: CaseState.OUTREACH_SENT })
      } catch (transitionError: any) {
        // [SEND] transition failed - log error
        console.error('[SEND] transition failed', { caseId, error: transitionError.message })
        
        // Add failure event
        addEvent(caseId, {
          case_id: caseId,
          timestamp: Date.now(),
          event_type: 'OUTREACH_SEND_FAILED',
          summary: `Failed to transition case to OUTREACH_SENT after sending email: ${transitionError.message}`,
          evidence_refs_json: {
            message_ids: gmailMessageId ? [gmailMessageId] : [],
            attachment_ids: [],
          },
          meta_json: {
            threadId,
            to: supplierEmail,
            gmailMessageId,
            error: transitionError.message,
            errorStack: transitionError.stack,
          },
        })
        
        // Return error response instead of swallowing
        return NextResponse.json(
          {
            ok: false,
            error: 'transition_failed',
            details: transitionError.message,
            gmailMessageId,
            threadId,
          },
          { status: 500 }
        )
      }
    }
    
    // Validate that email was actually sent if we attempted to send
    if (action === 'SEND_NEW' && !gmailMessageId) {
      console.error('[SEND_ROUTE] Email send attempted but no gmailMessageId returned', {
        caseId,
        action,
        supplierEmail,
        gmailMessageId,
        threadId,
      })
      // Check server logs for [SEND_NEW_EMAIL] entries to see what Gmail actually returned
      return NextResponse.json(
        {
          ok: false,
          error: 'Email send failed: Gmail API did not return a message ID. The email may not have been sent. Check server console logs for [SEND_NEW_EMAIL] entries to see Gmail API response.',
          action,
          details: 'Check server console for detailed Gmail API response logs',
        },
        { status: 500 }
      )
    }
    
    // Normalize action: if we actually sent, use 'sent'
    const finalAction = gmailMessageId ? 'sent' : action
    
    // Fetch case state after transition (if email was sent and transition occurred)
    let returnedCaseState: string | undefined
    let returnedNextCheckAt: number | null | undefined
    let returnedUpdatedAt: number | undefined
    
    if (gmailMessageId) {
      // Re-fetch case to get updated state after transition
      const finalCase = getCase(caseId)
      if (finalCase) {
        returnedCaseState = finalCase.state
        returnedNextCheckAt = finalCase.next_check_at
        returnedUpdatedAt = finalCase.updated_at
      }
    }
    
    const response: any = {
      ok: true,
      action: finalAction,
      gmailMessageId,
      messageId: gmailMessageId, // alias for compatibility
      threadId,
      missingFieldsAsked,
      searchResult,
    }
    
    // Include case state info if available
    if (returnedCaseState !== undefined) {
      response.returnedCaseState = returnedCaseState
      response.returnedNextCheckAt = returnedNextCheckAt
      response.returnedUpdatedAt = returnedUpdatedAt
    }
    
    console.log('[SEND_ROUTE] success', {
      action: finalAction,
      gmailMessageId,
      threadId,
      returnedCaseState,
      returnedNextCheckAt,
    })
    
    return NextResponse.json(response)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Failed to send confirmation email'
    console.error('[SEND_ROUTE] fatal error', error)
    
    // [SEND] Log: Fatal error - try to add failure event if we have caseId
    if (caseId) {
      try {
        addEvent(caseId, {
          case_id: caseId,
          timestamp: Date.now(),
          event_type: 'OUTREACH_SEND_FAILED',
          summary: `Failed to send outreach email: ${errorMsg}`,
          evidence_refs_json: null,
          meta_json: {
            error: errorMsg,
            errorStack: error instanceof Error ? error.stack : undefined,
          },
        })
      } catch (eventError) {
        // Ignore errors when adding failure event
        console.warn('[SEND] failed to add failure event', eventError)
      }
    }
    
    return NextResponse.json(
      { ok: false, error: errorMsg },
      { status: 500 }
    )
  }
}
