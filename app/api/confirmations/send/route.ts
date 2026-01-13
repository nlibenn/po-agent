import { NextRequest, NextResponse } from 'next/server'
import { searchInboxForConfirmation } from '@/src/lib/supplier-agent/inboxSearch'
import { sendNewEmail, sendReplyInThread } from '@/src/lib/supplier-agent/outreach'
import { generateConfirmationEmail } from '@/src/lib/supplier-agent/emailDraft'
import { getCase, updateCase, addEvent, addMessage } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

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
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.caseId || !body.poNumber || !body.lineId || !body.supplierEmail || !body.missingFields) {
      return NextResponse.json(
        { error: 'Missing required fields: caseId, poNumber, lineId, supplierEmail, missingFields' },
        { status: 400 }
      )
    }
    
    const {
      caseId,
      poNumber,
      lineId,
      supplierEmail,
      supplierName,
      missingFields,
      optionalKeywords,
      runInboxSearch = true,
    } = body
    
    // Load case
    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json(
        { error: `Case ${caseId} not found` },
        { status: 404 }
      )
    }
    
    // Generate email draft
    const emailDraft = generateConfirmationEmail({
      poNumber,
      lineId,
      supplierName: supplierName || caseData.supplier_name,
      supplierEmail,
      missingFields,
      context: caseData.meta as any,
    })
    
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
    
    let action: 'REPLY_IN_THREAD' | 'SEND_NEW' | 'NO_OP' = 'SEND_NEW'
    let gmailMessageId: string | undefined
    let threadId: string | undefined
    let missingFieldsAsked: string[] = missingFields
    let searchResult: any = null
    let usedReply = false
    let sentSubject = emailDraft.subject
    let sentBodyText = emailDraft.bodyText
    
    // Run inbox search if requested
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
        
        if (searchResult.classification === 'FOUND_CONFIRMED') {
          // Found prior confirmation, no outreach needed
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
          
          return NextResponse.json({
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
          
          const replyResult = await sendReplyInThread({
            threadId: threadId!,
            to: supplierEmail,
            subject: replyEmail.subject,
            bodyText: replyEmail.bodyText,
          })
          
          gmailMessageId = replyResult.gmailMessageId
          threadId = replyResult.threadId
        } else {
          // NOT_FOUND - send new email
          action = 'SEND_NEW'
          const sendResult = await sendNewEmail({
            to: supplierEmail,
            subject: emailDraft.subject,
            bodyText: emailDraft.bodyText,
          })
          
          gmailMessageId = sendResult.gmailMessageId
          threadId = sendResult.threadId
        }
      } catch (searchError) {
        console.error('Error during inbox search, falling back to new email:', searchError)
        // Fall through to send new email
        const sendResult = await sendNewEmail({
          to: supplierEmail,
          subject: emailDraft.subject,
          bodyText: emailDraft.bodyText,
        })
        
        gmailMessageId = sendResult.gmailMessageId
        threadId = sendResult.threadId
      }
    } else {
      // No inbox search, send new email
      const sendResult = await sendNewEmail({
        to: supplierEmail,
        subject: emailDraft.subject,
        bodyText: emailDraft.bodyText,
      })
      
      gmailMessageId = sendResult.gmailMessageId
      threadId = sendResult.threadId
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
    }
    
    // Log EMAIL_SENT event
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'EMAIL_SENT',
      summary: `Sent confirmation email for PO ${poNumber} Line ${lineId}${usedReply ? ' (reply in thread)' : ' (new email)'}`,
      evidence_refs_json: {
        message_ids: gmailMessageId ? [gmailMessageId] : [],
        attachment_ids: [],
      },
      meta_json: {
        threadId,
        to: supplierEmail,
        usedReply,
        missingFieldsAsked,
      },
    })
    
    // Update case state
    updateCase(caseId, {
      state: CaseState.OUTREACH_SENT,
      status: CaseStatus.STILL_AMBIGUOUS,
      last_action_at: Date.now(),
      touch_count: caseData.touch_count + 1,
    })
    
    return NextResponse.json({
      action,
      gmailMessageId,
      threadId,
      missingFieldsAsked,
      searchResult,
    })
  } catch (error) {
    console.error('Error in send confirmation API:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to send confirmation email' },
      { status: 500 }
    )
  }
}
