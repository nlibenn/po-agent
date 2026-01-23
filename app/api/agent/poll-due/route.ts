/**
 * Hourly Polling Endpoint - Polls cases for new evidence
 * 
 * This endpoint:
 * 1. Queries cases with next_check_at <= now
 * 2. Runs inbox search + attachment retrieval
 * 3. Transitions states based on evidence found
 * 4. NEVER sends emails (read-only evidence gathering)
 * 
 * Auth: Requires X-CRON-SECRET header matching process.env.CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { getCase, updateCase, listAttachmentsForCase, addEvent } from '@/src/lib/supplier-agent/store'
import { getDb, getDbPath } from '@/src/lib/supplier-agent/storage/sqlite'
import { searchInboxForConfirmation } from '@/src/lib/supplier-agent/inboxSearch'
import { retrievePdfAttachmentsFromThread } from '@/src/lib/supplier-agent/emailAttachments'
import { transitionCase, TransitionEvent } from '@/src/lib/supplier-agent/stateMachine'
import { CaseState } from '@/src/lib/supplier-agent/types'
import type { EvidenceRef } from '@/src/lib/supplier-agent/contract'
import { getGmailClient } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * Detect PDF evidence in Gmail thread by inspecting message payloads
 * Returns the best evidence message (most recent inbound with PDF) or null
 */
async function detectPdfEvidenceInThread(threadId: string): Promise<{
  found: boolean
  evidenceMessageId?: string
  evidenceFilenames?: string[]
  allPdfMessages?: Array<{ messageId: string; from: string; filenames: string[]; date: number }>
} | null> {
  try {
    const gmail = await getGmailClient()
    const buyerEmail = (process.env.GMAIL_SENDER_EMAIL || '').toLowerCase()
    
    // Get thread details
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    })
    
    const thread = threadResponse.data
    const messages = thread.messages || []
    
    // Process all messages to find PDF attachments
    const pdfMessages: Array<{ messageId: string; from: string; filenames: string[]; date: number; isInbound: boolean }> = []
    
    for (const msg of messages) {
      try {
        const headers = msg.payload?.headers || []
        const getHeader = (name: string) => {
          const header = headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())
          return header?.value || ''
        }
        
        const fromEmail = getHeader('From').toLowerCase()
        const isInbound = !buyerEmail || !fromEmail.includes(buyerEmail)
        const dateHeader = getHeader('Date')
        const date = dateHeader ? new Date(dateHeader).getTime() : (msg.internalDate ? parseInt(msg.internalDate) : 0)
        
        // Find PDF attachments in this message
        const attachmentParts: Array<{ filename: string; mimeType: string }> = []
        
        const findParts = (parts: any[]) => {
          if (!parts) return
          for (const part of parts) {
            if (part.filename && part.body?.attachmentId) {
              attachmentParts.push({
                filename: part.filename,
                mimeType: part.mimeType || 'application/octet-stream',
              })
            }
            if (part.parts) {
              findParts(part.parts)
            }
          }
        }
        
        findParts(msg.payload?.parts || [])
        
        const pdfAttachments = attachmentParts.filter(att => 
          att.mimeType === 'application/pdf' || att.filename.toLowerCase().endsWith('.pdf')
        )
        
        if (pdfAttachments.length > 0) {
          pdfMessages.push({
            messageId: msg.id!,
            from: getHeader('From'),
            filenames: pdfAttachments.map(att => att.filename),
            date,
            isInbound,
          })
        }
      } catch (error) {
        // Skip messages that fail to process
        continue
      }
    }
    
    if (pdfMessages.length === 0) {
      return { found: false }
    }
    
    // Sort by date descending (most recent first)
    pdfMessages.sort((a, b) => b.date - a.date)
    
    // Prefer inbound messages (from supplier)
    const inboundPdfMessages = pdfMessages.filter(msg => msg.isInbound)
    const bestMessage = inboundPdfMessages.length > 0 ? inboundPdfMessages[0] : pdfMessages[0]
    
    return {
      found: true,
      evidenceMessageId: bestMessage.messageId,
      evidenceFilenames: bestMessage.filenames,
      allPdfMessages: pdfMessages.map(msg => ({
        messageId: msg.messageId,
        from: msg.from,
        filenames: msg.filenames,
        date: msg.date,
      })),
    }
  } catch (error: any) {
    console.error(`[POLL_DUE] Failed to detect PDF evidence in thread ${threadId}:`, error.message)
    return null
  }
}

/**
 * Fetch thread debug information for dryRun mode
 */
async function fetchThreadDebug(threadId: string, lookbackDays: number): Promise<any> {
  try {
    const gmail = await getGmailClient()
    const buyerEmail = (process.env.GMAIL_SENDER_EMAIL || '').toLowerCase()
    
    // Get thread details
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    })
    
    const thread = threadResponse.data
    const messages = thread.messages || []
    
    // Sort messages by date (most recent first)
    const sortedMessages = messages
      .map((msg: any) => {
        const headers = msg.payload?.headers || []
        const getHeader = (name: string) => {
          const header = headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())
          return header?.value || ''
        }
        
        const dateHeader = getHeader('Date')
        const date = dateHeader ? new Date(dateHeader).getTime() : (msg.internalDate ? parseInt(msg.internalDate) : 0)
        
        return {
          messageId: msg.id,
          date,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
        }
      })
      .sort((a: any, b: any) => b.date - a.date)
      .slice(0, 10) // Top 10 most recent
    
    // Extract attachment info for each message
    const messagesWithAttachments = await Promise.all(
      sortedMessages.map(async (msgInfo: any) => {
        try {
          const messageResponse = await gmail.users.messages.get({
            userId: 'me',
            id: msgInfo.messageId,
            format: 'full',
          })
          
          const payload = messageResponse.data.payload
          const attachmentParts: Array<{ filename: string; mimeType: string }> = []
          
          // Recursively find attachment parts
          const findParts = (parts: any[]) => {
            if (!parts) return
            for (const part of parts) {
              if (part.filename && part.body?.attachmentId) {
                attachmentParts.push({
                  filename: part.filename,
                  mimeType: part.mimeType || 'application/octet-stream',
                })
              }
              if (part.parts) {
                findParts(part.parts)
              }
            }
          }
          
          findParts(payload?.parts || [])
          
          const pdfAttachments = attachmentParts.filter(att => 
            att.mimeType === 'application/pdf' || att.filename.toLowerCase().endsWith('.pdf')
          )
          
          return {
            ...msgInfo,
            hasPdfAttachment: pdfAttachments.length > 0,
            attachmentFilenames: pdfAttachments.map(att => att.filename),
          }
        } catch (error) {
          return {
            ...msgInfo,
            hasPdfAttachment: false,
            attachmentFilenames: [],
          }
        }
      })
    )
    
    // Count PDF attachments across all messages
    const pdfAttachmentCount = messagesWithAttachments.reduce(
      (count, msg) => count + (msg.hasPdfAttachment ? msg.attachmentFilenames.length : 0),
      0
    )
    
    // Count inbound messages (from != buyer)
    const inboundMessageCount = messagesWithAttachments.filter(msg => {
      const fromEmail = (msg.from || '').toLowerCase()
      return !buyerEmail || !fromEmail.includes(buyerEmail)
    }).length
    
    return {
      threadId,
      lookbackDays,
      lastMessages: messagesWithAttachments.map(msg => ({
        messageId: msg.messageId,
        date: msg.date,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        hasPdfAttachment: msg.hasPdfAttachment,
        attachmentFilenames: msg.attachmentFilenames.length > 0 ? msg.attachmentFilenames : undefined,
      })),
      pdfAttachmentCount,
      inboundMessageCount,
    }
  } catch (error: any) {
    return {
      threadId,
      lookbackDays,
      error: error.message,
      lastMessages: [],
      pdfAttachmentCount: 0,
      inboundMessageCount: 0,
    }
  }
}

/**
 * POST /api/agent/poll-due
 * Polls cases due for inbox check
 * 
 * Auth: X-CRON-SECRET header must match process.env.CRON_SECRET
 * 
 * Returns:
 * {
 *   polled: number,
 *   foundEvidence: number,
 *   noEvidence: number,
 *   errors: number,
 *   cases: Array<{ caseId, state, foundEvidence, error? }>
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Get DB path and compute debug stats (same DB as stats endpoint uses)
    const dbPath = getDbPath()
    const db = getDb()
    
    // Log DB path once for debugging
    console.log('[POLL_DUE] dbPath=', dbPath)
    
    // Get total case count
    const totalCasesResult = db
      .prepare('SELECT COUNT(*) as count FROM cases')
      .get() as { count: number }
    const totalCases = totalCasesResult.count
    
    // Get counts by state for all cases (not just included states)
    const countsByStateAll: Record<string, number> = {}
    const stateCounts = db
      .prepare(`
        SELECT state, COUNT(*) as count
        FROM cases
        GROUP BY state
        ORDER BY state
      `)
      .all() as Array<{ state: string; count: number }>
    
    for (const row of stateCounts) {
      countsByStateAll[row.state] = row.count
    }
    
    // Ensure all states are represented (even if count is 0)
    const allStates = Object.values(CaseState)
    for (const state of allStates) {
      if (!(state in countsByStateAll)) {
        countsByStateAll[state] = 0
      }
    }
    
    // Auth check: require X-CRON-SECRET header
    const cronSecret = request.headers.get('X-CRON-SECRET')
    const expectedSecret = process.env.CRON_SECRET

    if (!expectedSecret) {
      console.error('[POLL_DUE] CRON_SECRET not configured')
      return NextResponse.json(
        { error: 'Polling not configured' },
        { status: 500 }
      )
    }

    if (cronSecret !== expectedSecret) {
      console.warn('[POLL_DUE] Invalid CRON_SECRET')
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Parse request body for dryRun flag (supports both query param and JSON body)
    let dryRun = false
    try {
      const body = await request.json().catch(() => ({}))
      dryRun = body.dryRun === true
    } catch {
      // If JSON parse fails, check query param
      const url = new URL(request.url)
      dryRun = url.searchParams.get('dryRun') === 'true'
    }

    // Reuse db from above (already defined at line 281)
    const now = Date.now()
    const limit = 25
    const statesIncluded = [CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT]

    // Collect diagnostic data when dryRun is enabled
    let debug: any = null
    if (dryRun) {
      // Count cases by state
      const countsByState: Record<string, number> = {}
      for (const state of statesIncluded) {
        const count = db
          .prepare(`SELECT COUNT(*) as count FROM cases WHERE state = ?`)
          .get(state) as { count: number }
        countsByState[state] = count.count
      }

      // Count cases with NULL next_check_at
      const countNextCheckNull = db
        .prepare(`
          SELECT COUNT(*) as count
          FROM cases
          WHERE state IN (?, ?, ?) AND next_check_at IS NULL
        `)
        .get(CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT) as { count: number }

      // Count cases with future next_check_at
      const countNextCheckFuture = db
        .prepare(`
          SELECT COUNT(*) as count
          FROM cases
          WHERE state IN (?, ?, ?) AND next_check_at IS NOT NULL AND next_check_at > ?
        `)
        .get(CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT, now) as { count: number }

      // Count cases that are due (next_check_at <= now)
      const countNextCheckDue = db
        .prepare(`
          SELECT COUNT(*) as count
          FROM cases
          WHERE state IN (?, ?, ?) AND next_check_at IS NOT NULL AND next_check_at <= ?
        `)
        .get(CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT, now) as { count: number }

      // Get min and max next_check_at values
      const minMaxResult = db
        .prepare(`
          SELECT 
            MIN(next_check_at) as min_next_check_at,
            MAX(next_check_at) as max_next_check_at
          FROM cases
          WHERE state IN (?, ?, ?) AND next_check_at IS NOT NULL
        `)
        .get(CaseState.OUTREACH_SENT, CaseState.WAITING, CaseState.FOLLOWUP_SENT) as { min_next_check_at: number | null; max_next_check_at: number | null }

      debug = {
        now,
        statesIncluded,
        countsByState,
        countNextCheckNull: countNextCheckNull.count,
        countNextCheckFuture: countNextCheckFuture.count,
        countNextCheckDue: countNextCheckDue.count,
        minNextCheckAt: minMaxResult.min_next_check_at ?? null,
        maxNextCheckAt: minMaxResult.max_next_check_at ?? null,
      }
    }

    // Query due cases: state IN (OUTREACH_SENT, WAITING, FOLLOWUP_SENT) AND next_check_at <= now
    const dueCases = db
      .prepare(`
        SELECT case_id, state, next_check_at
        FROM cases
        WHERE state IN (?, ?, ?)
          AND next_check_at IS NOT NULL
          AND next_check_at <= ?
        ORDER BY next_check_at ASC
        LIMIT ?
      `)
      .all(
        CaseState.OUTREACH_SENT,
        CaseState.WAITING,
        CaseState.FOLLOWUP_SENT,
        now,
        limit
      ) as Array<{ case_id: string; state: string; next_check_at: number }>

    const results: Array<{
      caseId: string
      state: string
      foundEvidence: boolean
      error?: string
      next_check_at?: number | null
      // dryRun fields
      dueAt?: number | null
      threadId?: string | null
      messageIds?: string[]
      attachmentHashes?: string[]
    }> = []
    let foundEvidenceCount = 0
    let noEvidenceCount = 0
    let errorCount = 0

    // Process each case (transitionCase will handle locking internally)
    for (const row of dueCases) {
      const caseId = row.case_id
      const state = row.state as CaseState

      // Lightweight eligibility check before processing (non-blocking)
      // transitionCase will re-validate inside its lock
      const currentCase = getCase(caseId)
      if (!currentCase) {
        results.push({ 
          caseId, 
          state, 
          foundEvidence: false, 
          error: 'Case not found',
          next_check_at: null,
        })
        errorCount++
        continue
      }

      if (currentCase.state !== state) {
        results.push({ 
          caseId, 
          state: currentCase.state, 
          foundEvidence: false, 
          error: `State changed from ${state} to ${currentCase.state}`,
          next_check_at: currentCase.next_check_at,
        })
        continue
      }

      if (!currentCase.next_check_at || currentCase.next_check_at > now) {
        results.push({ 
          caseId, 
          state, 
          foundEvidence: false, 
          error: 'Case no longer due for check',
          next_check_at: currentCase.next_check_at,
        })
        continue
      }

      // Process case (transitionCase will lock internally)
      try {
        // Get thread_id from meta if available
        const meta = (currentCase.meta && typeof currentCase.meta === 'object' ? currentCase.meta : {}) as Record<string, any>
        let threadId = meta.thread_id || null
        let searchResult: any = null
        let foundEvidence = false
        let evidenceRef: EvidenceRef | null = null
        let messageIds: string[] = []
        let attachmentHashes: string[] = []
        let evidenceMessageId: string | undefined = undefined
        let evidenceFilenames: string[] | undefined = undefined

        // Evidence detection result (consistent for both dryRun and live)
        let hasPdfEvidence = false
        let pdfEvidenceError: string | null = null
        // Initialize retrievalDebug with defaults - will be populated when retrieval is called
        let retrievalDebug: any = null
        
        try {
          // Step 1: Resolve threadId (prefer case.meta.thread_id, else search)
          if (!threadId) {
            // No threadId, run full inbox search
            searchResult = await searchInboxForConfirmation({
              caseId: currentCase.case_id,
              poNumber: currentCase.po_number,
              lineId: currentCase.line_id,
              supplierEmail: currentCase.supplier_email || null,
              supplierDomain: currentCase.supplier_domain || null,
              optionalKeywords: [],
              lookbackDays: 90,
            })

            threadId = searchResult?.matchedThreadId || null
            messageIds = searchResult?.matchedMessageIds || []

            // Update meta with threadId if found (only in non-dryRun mode)
            if (!dryRun && threadId) {
              const updatedMeta = { ...meta, thread_id: threadId }
              updateCase(caseId, { meta: updatedMeta })
            }
          } else {
            // We have threadId, get message IDs from stored messages
            const storedMessages = listAttachmentsForCase(caseId)
            const uniqueMessageIds = new Set<string>()
            storedMessages.forEach(msg => {
              if (msg.message_id) uniqueMessageIds.add(msg.message_id)
            })
            messageIds = Array.from(uniqueMessageIds)
          }
          
          // Initialize retrievalDebug with actual values now that we have threadId and messageIds
          retrievalDebug = {
            threadId: threadId || null,
            messageIdsInput: messageIds.length > 0 ? messageIds : [],
            messagesFetched: 0,
            messagesSaved: 0,
            attachmentsFound: 0,
            attachmentsSaved: 0,
            attachmentsWithSha: 0,
            filenames: [],
            attachmentIds: [],
            errors: [],
          }

          // Step 2: Inspect Gmail thread for PDF attachments (if threadId exists)
          if (threadId) {
            const pdfDetection = await detectPdfEvidenceInThread(threadId)
            
            if (pdfDetection?.found) {
              // PDF found in Gmail thread - this is evidence regardless of retrieval status
              hasPdfEvidence = true
              evidenceMessageId = pdfDetection.evidenceMessageId
              evidenceFilenames = pdfDetection.evidenceFilenames
              foundEvidence = true // Set foundEvidence immediately when PDF detected
              
              // In live mode, ALWAYS call retrieval BEFORE checking hashes when foundEvidence=true
              if (!dryRun) {
                try {
                  // Prefer messageIds if available, otherwise use threadId
                  const retrievalResult = await retrievePdfAttachmentsFromThread({
                    caseId,
                    threadId: messageIds.length > 0 ? undefined : threadId, // Only pass threadId if no messageIds
                    messageIds: messageIds.length > 0 ? messageIds : undefined, // Prefer messageIds
                  })
                  
                  // Capture debug info from retrieval (merge with defaults if needed)
                  if (retrievalResult.debug) {
                    retrievalDebug = {
                      ...retrievalDebug,
                      ...retrievalResult.debug,
                      // Ensure arrays are properly set
                      messageIdsInput: retrievalResult.debug.messageIdsInput || retrievalDebug.messageIdsInput,
                      filenames: retrievalResult.debug.filenames || retrievalDebug.filenames,
                      attachmentIds: retrievalResult.debug.attachmentIds || retrievalDebug.attachmentIds,
                      errors: retrievalResult.debug.errors || retrievalDebug.errors,
                    }
                  }

                  // Re-check stored attachments after retrieval
                  const attachments = listAttachmentsForCase(caseId)
                  const pdfAttachments = attachments.filter(att => 
                    att.mime_type === 'application/pdf' && (att as any).content_sha256
                  )

                  if (pdfAttachments.length > 0) {
                    // Find attachment matching the evidence message
                    const matchingAttachment = pdfAttachments.find(att => 
                      att.message_id === evidenceMessageId
                    ) || pdfAttachments[0] // Fallback to first PDF if message doesn't match
                    
                    const hash = (matchingAttachment as any).content_sha256
                    
                    if (hash) {
                      evidenceRef = {
                        message_id: matchingAttachment.message_id,
                        thread_id: threadId,
                        attachment_id: matchingAttachment.attachment_id,
                        content_sha256: hash,
                        source_type: 'pdf' as const,
                      }
                      attachmentHashes = pdfAttachments.map(att => (att as any).content_sha256).filter(Boolean)
                    } else {
                      // PDF detected but no hash after retrieval
                      pdfEvidenceError = 'PDF seen in Gmail but content_sha256 missing after retrieval'
                    }
                  } else {
                    // PDF detected but retrieval produced no hashed attachments
                    pdfEvidenceError = 'PDF seen in Gmail but retrieval produced no hashed attachments'
                  }
                } catch (retrieveError: any) {
                  console.error(`[POLL_DUE] Failed to retrieve attachments for case ${caseId}:`, retrieveError.message)
                  pdfEvidenceError = `PDF seen in Gmail but retrieval failed: ${retrieveError.message}`
                  // Update retrievalDebug with error info
                  if (!retrievalDebug) {
                    retrievalDebug = {
                      threadId: threadId || null,
                      messageIdsInput: messageIds.length > 0 ? messageIds : [],
                      messagesFetched: 0,
                      messagesSaved: 0,
                      attachmentsFound: 0,
                      attachmentsSaved: 0,
                      attachmentsWithSha: 0,
                      filenames: [],
                      attachmentIds: [],
                      errors: [],
                    }
                  }
                  retrievalDebug.errors.push(`Retrieval failed: ${retrieveError.message}`)
                  if (retrieveError.debug) {
                    retrievalDebug = {
                      ...retrievalDebug,
                      ...retrieveError.debug,
                      errors: [...(retrievalDebug.errors || []), ...(retrieveError.debug.errors || [])],
                    }
                  }
                }
              } else {
                // dryRun: PDF found, set foundEvidence=true (no DB writes)
                // No retrieval in dryRun mode
              }
            } else {
              // No PDF found in Gmail thread, check stored attachments as fallback
              const attachments = listAttachmentsForCase(caseId)
              const pdfAttachments = attachments.filter(att => 
                att.mime_type === 'application/pdf' && (att as any).content_sha256
              )

              if (pdfAttachments.length > 0) {
                const bestAttachment = pdfAttachments[0]
                const hash = (bestAttachment as any).content_sha256
                
                if (hash) {
                  foundEvidence = true
                  hasPdfEvidence = true
                  evidenceRef = {
                    message_id: bestAttachment.message_id,
                    thread_id: threadId,
                    attachment_id: bestAttachment.attachment_id,
                    content_sha256: hash,
                    source_type: 'pdf' as const,
                  }
                  attachmentHashes = pdfAttachments.map(att => (att as any).content_sha256).filter(Boolean)
                  
                  // In live mode, if we found stored attachments but haven't called retrieval yet, call it now
                  if (!dryRun && threadId) {
                    try {
            const retrievalResult = await retrievePdfAttachmentsFromThread({
              caseId,
              threadId: messageIds.length > 0 ? undefined : threadId,
              messageIds: messageIds.length > 0 ? messageIds : undefined,
            })
            // Merge retrieval debug info
            if (retrievalResult.debug) {
              retrievalDebug = {
                ...retrievalDebug,
                ...retrievalResult.debug,
                messageIdsInput: retrievalResult.debug.messageIdsInput || retrievalDebug.messageIdsInput,
                filenames: retrievalResult.debug.filenames || retrievalDebug.filenames,
                attachmentIds: retrievalResult.debug.attachmentIds || retrievalDebug.attachmentIds,
                errors: retrievalResult.debug.errors || retrievalDebug.errors,
              }
            }
                    } catch (retrieveError: any) {
                      console.error(`[POLL_DUE] Failed to retrieve attachments for case ${caseId} (fallback path):`, retrieveError.message)
                      if (!retrievalDebug) {
                        retrievalDebug = {
                          threadId: threadId || null,
                          messageIdsInput: messageIds.length > 0 ? messageIds : [],
                          messagesFetched: 0,
                          messagesSaved: 0,
                          attachmentsFound: 0,
                          attachmentsSaved: 0,
                          attachmentsWithSha: 0,
                          filenames: [],
                          attachmentIds: [],
                          errors: [],
                        }
                      }
                      retrievalDebug.errors.push(`Retrieval failed (fallback): ${retrieveError.message}`)
                      if (retrieveError.debug) {
                        retrievalDebug = {
                          ...retrievalDebug,
                          ...retrieveError.debug,
                          errors: [...(retrievalDebug.errors || []), ...(retrieveError.debug.errors || [])],
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (searchError: any) {
          // If inbox search or detection fails, log and continue without evidence
          console.error(`[POLL_DUE] Evidence detection failed for case ${caseId}:`, searchError.message)
          // Continue with foundEvidence = false, hasPdfEvidence = false
        }
        
        // Step 2.5: Handle PDF evidence errors in live mode
        if (!dryRun && hasPdfEvidence && pdfEvidenceError) {
          // PDF was detected but retrieval/hash failed - count as evidence but with error
          foundEvidence = true
          // Will be handled in results reporting below
        }

        // Step 2: Check idempotency - if evidence hash matches last parsed hash, skip transition
        let shouldTransition = true
        let idempotentReason: string | null = null
        
        // In dryRun mode, if we found PDFs in Gmail but don't have content_sha256 yet, still report foundEvidence=true
        // The idempotency check only applies when we have a stored hash
        if (dryRun && foundEvidence && !evidenceRef?.content_sha256 && evidenceMessageId) {
          // PDF found in Gmail but not yet retrieved - this is valid evidence for dryRun
          shouldTransition = true // Will be handled in dryRun reporting
        } else if (foundEvidence && evidenceRef?.content_sha256) {
          // Check if this hash was already parsed (check last event or case.meta)
          const lastEvent = db
            .prepare(`
              SELECT meta_json FROM events
              WHERE case_id = ?
                AND event_type IN ('PDF_PARSED', 'INBOX_SEARCH_FOUND_INCOMPLETE')
              ORDER BY timestamp DESC
              LIMIT 1
            `)
            .get(caseId) as { meta_json: string } | undefined

          let lastHash: string | null = null
          
          // Check last event meta
          if (lastEvent?.meta_json) {
            const lastEventMeta = JSON.parse(lastEvent.meta_json)
            lastHash = lastEventMeta?.content_sha256 || lastEventMeta?.evidence_hash || null
          }
          
          // Also check case.meta.parsed_best_fields_v1.evidence_attachment_id and get its hash
          if (!lastHash && meta.parsed_best_fields_v1?.evidence_attachment_id) {
            const lastAttachmentId = meta.parsed_best_fields_v1.evidence_attachment_id
            const lastAttachment = db
              .prepare(`SELECT content_sha256 FROM attachments WHERE attachment_id = ?`)
              .get(lastAttachmentId) as { content_sha256: string | null } | undefined
            
            if (lastAttachment?.content_sha256) {
              lastHash = lastAttachment.content_sha256
            }
          }
          
          if (lastHash === evidenceRef.content_sha256) {
            shouldTransition = false
            idempotentReason = `Evidence hash ${evidenceRef.content_sha256.substring(0, 16)}... already parsed`
            
            // In dryRun, just report; in normal mode, bump next_check_at without state change
            if (!dryRun) {
              // Bump next_check_at by 60 minutes without changing state
              updateCase(caseId, { 
                next_check_at: now + 60 * 60 * 1000,
                last_inbox_check_at: now,
              })
            }
          }
        }

        // Step 2.5: In live mode, if foundEvidence=true but we haven't called retrieval yet, call it now
        // This ensures retrieval is ALWAYS called when foundEvidence=true in live mode
        if (!dryRun && foundEvidence && (!retrievalDebug || retrievalDebug.messagesFetched === 0) && threadId) {
          try {
            const retrievalResult = await retrievePdfAttachmentsFromThread({
              caseId,
              threadId: messageIds.length > 0 ? undefined : threadId,
              messageIds: messageIds.length > 0 ? messageIds : undefined,
            })
            // Merge retrieval debug info
            if (retrievalResult.debug) {
              retrievalDebug = {
                ...retrievalDebug,
                ...retrievalResult.debug,
                messageIdsInput: retrievalResult.debug.messageIdsInput || retrievalDebug.messageIdsInput,
                filenames: retrievalResult.debug.filenames || retrievalDebug.filenames,
                attachmentIds: retrievalResult.debug.attachmentIds || retrievalDebug.attachmentIds,
                errors: retrievalResult.debug.errors || retrievalDebug.errors,
              }
            }
            
            // Re-check attachments after retrieval
            const attachments = listAttachmentsForCase(caseId)
            const pdfAttachments = attachments.filter(att => 
              att.mime_type === 'application/pdf' && (att as any).content_sha256
            )
            
            if (pdfAttachments.length > 0 && !evidenceRef?.content_sha256) {
              // Update evidenceRef with hash from retrieved attachments
              const bestAttachment = pdfAttachments[0]
              const hash = (bestAttachment as any).content_sha256
              if (hash) {
                evidenceRef = {
                  message_id: bestAttachment.message_id,
                  thread_id: threadId,
                  attachment_id: bestAttachment.attachment_id,
                  content_sha256: hash,
                  source_type: 'pdf' as const,
                }
                attachmentHashes = pdfAttachments.map(att => (att as any).content_sha256).filter(Boolean)
              }
            }
          } catch (retrieveError: any) {
            console.error(`[POLL_DUE] Failed to retrieve attachments for case ${caseId} (late retrieval):`, retrieveError.message)
            if (!retrievalDebug) {
              retrievalDebug = {
                threadId: threadId || null,
                messageIdsInput: messageIds.length > 0 ? messageIds : [],
                messagesFetched: 0,
                messagesSaved: 0,
                attachmentsFound: 0,
                attachmentsSaved: 0,
                attachmentsWithSha: 0,
                filenames: [],
                attachmentIds: [],
                errors: [],
              }
            }
            retrievalDebug.errors.push(`Late retrieval failed: ${retrieveError.message}`)
            if (retrieveError.debug) {
              retrievalDebug = {
                ...retrievalDebug,
                ...retrieveError.debug,
                errors: [...(retrievalDebug.errors || []), ...(retrieveError.debug.errors || [])],
              }
            }
          }
        }

        // Refresh attachment hashes from DB (authoritative) when evidence was found in live mode
        let attachmentHashRows: Array<{ sha: string | null; attachment_id: string | null; message_id: string | null }> =
          []
        if (!dryRun && foundEvidence) {
          attachmentHashRows = db
            .prepare(
              `
              SELECT DISTINCT a.content_sha256 AS sha, a.attachment_id AS attachment_id, a.message_id AS message_id
              FROM attachments a
              JOIN messages m ON m.message_id = a.message_id
              WHERE m.case_id = ?
                AND a.content_sha256 IS NOT NULL
            `
            )
            .all(caseId) as Array<{ sha: string | null; attachment_id: string | null; message_id: string | null }>
          attachmentHashes = attachmentHashRows.map(r => r.sha).filter(Boolean) as string[]
          // If we have hashes but no evidenceRef yet, derive one from the first hashed attachment
          if (!evidenceRef && attachmentHashRows.length > 0) {
            const first = attachmentHashRows.find(r => r.sha) || attachmentHashRows[0]
            if (first?.sha) {
              evidenceRef = {
                message_id: first.message_id || evidenceRef?.message_id || messageIds[0],
                thread_id: threadId || evidenceRef?.thread_id || null,
                attachment_id: first.attachment_id || undefined,
                content_sha256: first.sha,
                source_type: 'pdf' as const,
              }
            }
          }
        }
        
        // IMPORTANT: Compute hasHashedAttachments AFTER DB refresh - this is the authoritative check
        const hasHashedAttachments = Array.isArray(attachmentHashes) && attachmentHashes.length > 0
        
        // Clear pdfEvidenceError if we actually have hashes - the error was premature
        if (hasHashedAttachments && pdfEvidenceError) {
          console.log(`[POLL_DUE] Clearing pdfEvidenceError for case ${caseId} - hashes found after DB refresh: ${attachmentHashes.length}`)
          pdfEvidenceError = null
        }

        // Step 3: Validate evidenceRef has content_sha256 before transitioning (only in live mode)
        // In dryRun mode, we allow foundEvidence=true even without content_sha256 (PDFs found in Gmail)
        // ONLY use hasHashedAttachments to determine if we should error
        if (!dryRun && foundEvidence && !hasHashedAttachments) {
          // GUARDRAIL: Safety assertion - should never enter here if we have hashes
          if (hasHashedAttachments) {
            throw new Error(`BUG: attempted ERROR transition despite hashed attachments present (case ${caseId})`)
          }
          
          const errorMsg = 'Evidence found but content_sha256 is missing'
          console.error(`[POLL_DUE] ${errorMsg} for case ${caseId}`)
          
          // Add event and transition to ERROR
          addEvent(caseId, {
            case_id: caseId,
            timestamp: now,
            event_type: 'CASE_MARKED_UNRESPONSIVE',
            summary: errorMsg,
            evidence_refs_json: {
              message_ids: messageIds.length > 0 ? messageIds : undefined,
              attachment_ids: evidenceRef?.attachment_id ? [evidenceRef.attachment_id] : undefined,
            },
            meta_json: {
              error: errorMsg,
              threadId: threadId || null,
            },
          })
          
          transitionCase({
            caseId,
            toState: CaseState.ERROR,
            event: TransitionEvent.FAILURE,
            summary: errorMsg,
          })
          
          // Re-fetch case to get updated state after transition
          const updatedCase = getCase(caseId)
          const newState = updatedCase?.state || CaseState.ERROR
          const newNextCheckAt = updatedCase?.next_check_at ?? null
          
          // HARD REQUIREMENT: Throw error if foundEvidence=true but retrievalDebug is missing
          if (!retrievalDebug || retrievalDebug.messagesFetched === undefined) {
            throw new Error(`BUG: retrievalDebug not attached for case ${caseId} with foundEvidence=true`)
          }
          
          // SAFETY: If we somehow enter this branch with hashes present, throw
          if (attachmentHashes.length > 0) {
            throw new Error('BUG: entered sha-missing branch despite hashes present')
          }
          
          results.push({
            caseId,
            state: newState,
            foundEvidence: true,
            error: errorMsg,
            next_check_at: newNextCheckAt,
            dueAt: currentCase.next_check_at,
            threadId: threadId || null,
            messageIds,
            attachmentHashes,
          })
          errorCount++
          continue
        }

        // Step 4: Transition state based on evidence (or report in dryRun)
        if (dryRun) {
          // Dry run: just report findings without state changes
          const resolvedThreadId = threadId || searchResult?.matchedThreadId || null
          const lookbackDaysUsed = 90 // Same as used in searchInboxForConfirmation call
          
          // Fetch thread debug info if we have a threadId
          let threadDebug: any = undefined
          if (resolvedThreadId) {
            try {
              threadDebug = await fetchThreadDebug(resolvedThreadId, lookbackDaysUsed)
            } catch (debugError: any) {
              console.error(`[POLL_DUE] Failed to fetch thread debug for ${resolvedThreadId}:`, debugError.message)
              threadDebug = {
                threadId: resolvedThreadId,
                lookbackDays: lookbackDaysUsed,
                error: debugError.message,
                lastMessages: [],
                pdfAttachmentCount: 0,
                inboundMessageCount: 0,
              }
            }
          }
          
          const dryRunResult: any = {
            caseId,
            state,
            // In dryRun, foundEvidence=true if PDFs exist in Gmail (hasPdfEvidence) OR if we have stored evidence with hash
            foundEvidence: hasPdfEvidence || foundEvidence,
            next_check_at: currentCase.next_check_at,
            dueAt: currentCase.next_check_at,
            threadId: resolvedThreadId,
            messageIds: messageIds.length > 0 ? messageIds : undefined,
            attachmentHashes: attachmentHashes.length > 0 ? attachmentHashes : undefined,
            error: idempotentReason || undefined,
          }
          
          // Add evidence metadata if PDFs found in Gmail but not yet retrieved
          if (hasPdfEvidence && !evidenceRef?.content_sha256 && evidenceMessageId) {
            dryRunResult.evidenceMessageId = evidenceMessageId
            dryRunResult.evidenceFilenames = evidenceFilenames
            dryRunResult.evidenceNote = 'PDF found in Gmail thread (not yet retrieved/stored)'
          }
          
          // Add error if PDF detected but retrieval would fail (for visibility)
          if (hasPdfEvidence && pdfEvidenceError) {
            dryRunResult.error = pdfEvidenceError
            dryRunResult.evidenceNote = 'PDF found in Gmail but retrieval/hash would fail'
          }
          
          // Add threadDebug only in dryRun mode
          if (threadDebug) {
            dryRunResult.threadDebug = threadDebug
          }
          
          results.push(dryRunResult)
          
          // Count evidence: either stored with hash OR found in Gmail (hasPdfEvidence)
          if (hasPdfEvidence || foundEvidence) {
            if (evidenceRef?.content_sha256) {
              // Stored evidence with hash
              if (shouldTransition) {
                foundEvidenceCount++
              } else {
                // Would be idempotent - count as no evidence for stats
                noEvidenceCount++
              }
            } else {
              // PDF found in Gmail but not yet stored - count as found evidence
              foundEvidenceCount++
            }
          } else {
            noEvidenceCount++
          }
        } else {
          // Normal mode: make state changes
          // Record last_inbox_check_at
          updateCase(caseId, { last_inbox_check_at: now })

          // Handle PDF evidence errors (PDF detected but retrieval/hash failed)
          // ONLY transition to ERROR if we have NO hashed attachments
          if (hasPdfEvidence && pdfEvidenceError && !hasHashedAttachments) {
            // GUARDRAIL: Safety assertion - should never enter here if we have hashes
            if (hasHashedAttachments) {
              throw new Error(`BUG: attempted ERROR transition despite hashed attachments present (case ${caseId}, pdfEvidenceError path)`)
            }
            
            // PDF was detected but retrieval/hash failed - count as evidence with error
            foundEvidence = true
            
            // Transition to ERROR state
            transitionCase({
              caseId,
              toState: CaseState.ERROR,
              event: TransitionEvent.FAILURE,
              summary: pdfEvidenceError,
            })
            
            // Re-fetch case to get updated state after transition
            const updatedCase = getCase(caseId)
            const newState = updatedCase?.state || CaseState.ERROR
            const newNextCheckAt = updatedCase?.next_check_at ?? null
            
            foundEvidenceCount++
            errorCount++
            
            // HARD REQUIREMENT: Throw error if foundEvidence=true but retrievalDebug is missing
            if (!retrievalDebug || retrievalDebug.messagesFetched === undefined) {
              throw new Error(`BUG: retrievalDebug not attached for case ${caseId} with foundEvidence=true (pdfEvidenceError path)`)
            }
            
            const errorResult: any = { 
              caseId, 
              state: newState, 
              foundEvidence: true,
              error: pdfEvidenceError,
              next_check_at: newNextCheckAt,
              threadId: threadId || null,
              messageIds: messageIds.length > 0 ? messageIds : undefined,
              attachmentHashes: attachmentHashes.length > 0 ? attachmentHashes : undefined,
              retrievalDebug, // ALWAYS include retrievalDebug when foundEvidence=true
            }
            
            results.push(errorResult)
          } else if (foundEvidence && hasHashedAttachments && shouldTransition) {
            // Found evidence with content hash - transition to PARSED
            // Use hasHashedAttachments as the authoritative check (evidenceRef should be set from DB refresh)
            // transitionCase() will clear next_check_at for PARSED state and lock atomically
            transitionCase({
              caseId,
              toState: CaseState.PARSED,
              event: TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE,
              summary: `Stored ${attachmentHashes.length} hashed PDF attachment(s)`,
              evidenceRef: evidenceRef || undefined,
            })
            
            // Re-fetch case to get updated state after transition
            const updatedCase = getCase(caseId)
            const newState = updatedCase?.state || CaseState.PARSED
            const newNextCheckAt = updatedCase?.next_check_at ?? null
            
            foundEvidenceCount++
            
            // HARD REQUIREMENT: Throw error if foundEvidence=true but retrievalDebug is missing
            if (!dryRun && (!retrievalDebug || retrievalDebug.messagesFetched === undefined)) {
              throw new Error(`BUG: retrievalDebug not attached for case ${caseId} with foundEvidence=true (success path)`)
            }
            
            const successResult: any = { 
              caseId, 
              state: newState, 
              foundEvidence: true,
              next_check_at: newNextCheckAt,
              threadId: threadId || null,
              messageIds: messageIds.length > 0 ? messageIds : undefined,
              attachmentHashes: attachmentHashes.length > 0 ? attachmentHashes : undefined,
            }
            
            // ALWAYS include retrieval debug info when foundEvidence=true in live mode
            if (!dryRun) {
              successResult.retrievalDebug = retrievalDebug
            }
            
            results.push(successResult)
          } else if (shouldTransition) {
            // No evidence or idempotent - transition to WAITING (or stay in WAITING)
            // transitionCase() will set next_check_at = now + 60min for WAITING state and lock atomically
            transitionCase({
              caseId,
              toState: CaseState.WAITING,
              event: TransitionEvent.INBOX_CHECK_NO_EVIDENCE,
              summary: idempotentReason || 'No new evidence found in inbox',
            })
            
            // Re-fetch case to get updated state after transition
            const updatedCase = getCase(caseId)
            const newState = updatedCase?.state || CaseState.WAITING
            const newNextCheckAt = updatedCase?.next_check_at ?? null
            
            noEvidenceCount++
            results.push({ 
              caseId, 
              state: newState, 
              foundEvidence: false,
              next_check_at: newNextCheckAt,
            })
          } else {
            // Idempotent case - but we still need to call transitionCase to bump next_check_at
            // This handles WAITING -> WAITING with INBOX_CHECK_NO_EVIDENCE to reschedule
            transitionCase({
              caseId,
              toState: CaseState.WAITING,
              event: TransitionEvent.INBOX_CHECK_NO_EVIDENCE,
              summary: idempotentReason || 'No new evidence found in inbox (idempotent reschedule)',
            })
            
            // Re-fetch case to get updated state and next_check_at after transition
            const updatedCase = getCase(caseId)
            const currentState = updatedCase?.state || CaseState.WAITING
            const currentNextCheckAt = updatedCase?.next_check_at ?? null
            
            noEvidenceCount++
            results.push({ 
              caseId, 
              state: currentState, 
              foundEvidence: false,
              next_check_at: currentNextCheckAt,
              error: idempotentReason || undefined,
            })
          }
        }
      } catch (error: any) {
        console.error(`[POLL_DUE] Error processing case ${caseId}:`, error.message)
        
        // Transition to ERROR state on failure (transitionCase will lock internally)
        let errorState = state
        let errorNextCheckAt: number | null = null
        try {
          transitionCase({
            caseId,
            toState: CaseState.ERROR,
            event: TransitionEvent.FAILURE,
            summary: `Polling failed: ${error.message}`,
          })
          
          // Re-fetch case to get updated state after transition
          const updatedCase = getCase(caseId)
          errorState = updatedCase?.state || CaseState.ERROR
          errorNextCheckAt = updatedCase?.next_check_at ?? null
        } catch (transitionError: any) {
          // If transition fails, log but don't throw
          console.error(`[POLL_DUE] Failed to transition case ${caseId} to ERROR:`, transitionError.message)
        }

        results.push({ 
          caseId, 
          state: errorState, 
          foundEvidence: false, 
          error: error.message,
          next_check_at: errorNextCheckAt,
        })
        errorCount++
      }
    }

    const response: any = {
      dryRun,
      polled: dueCases.length,
      foundEvidence: foundEvidenceCount,
      noEvidence: noEvidenceCount,
      errors: errorCount,
      cases: results,
      // Debug fields: DB path and case counts (always included)
      dbPath,
      totalCases,
      countsByStateAll,
    }

    // Add debug diagnostics when dryRun is enabled
    if (dryRun && debug) {
      response.debug = debug
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[POLL_DUE] Fatal error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to poll cases' },
      { status: 500 }
    )
  }
}
