/**
 * Email Attachment Retrieval for Supplier Confirmations
 * 
 * Retrieves PDF attachments from Gmail threads related to supplier confirmation cases.
 * 
 * SERVER-ONLY: This module uses Gmail API which requires Node.js APIs.
 * Do not import this in client components.
 */

import 'server-only'
import { createHash } from 'crypto'

import { getGmailClient } from '../gmail/client'
import { getDb, hasColumn } from './storage/sqlite'
import { getCase, listMessages, addAttachment, addEvent, addMessage } from './store'
import type { SupplierChaseCase } from './types'

export interface PdfAttachmentEvidence {
  attachment_id: string
  filename: string
  receivedAt: number // epoch ms
  email_threadId: string
  messageId: string
  status: 'PDF_RETRIEVED'
  evidenceType: 'supplier_confirmation_pdf'
  binary_data_base64: string // Base64-encoded PDF
}

export interface RetrieveAttachmentsParams {
  caseId: string
  threadId?: string // Optional: if provided, will fetch thread and process all messages
  messageIds?: string[] // Optional: if provided, will fetch these specific messages (preferred over threadId)
}

export interface RetrieveAttachmentsResult {
  caseId: string
  retrievedCount: number
  attachments: PdfAttachmentEvidence[]
  inserted: number
  reused: number
  skipped: number
  debug?: {
    threadId: string | null
    messageIdsInput: string[]
    messagesFetched: number
    messagesSaved: number
    attachmentsFound: number
    attachmentsSaved: number
    attachmentsWithSha: number
    filenames: string[]
    attachmentIds: string[]
    errors: string[]
  }
}

/**
 * Recursively find all parts in a Gmail message payload that have attachments
 * Robust MIME walk: handles nested parts, various MIME types, and edge cases
 * 
 * Treats a part as an attachment if:
 * - part.filename is non-empty OR
 * - part.body.attachmentId exists OR
 * - part.body.data exists (inline attachment)
 */
function findAttachmentParts(parts: any[]): Array<{ part: any; attachmentId: string | null; filename: string; mimeType: string; hasInlineData: boolean }> {
  const attachmentParts: Array<{ part: any; attachmentId: string | null; filename: string; mimeType: string; hasInlineData: boolean }> = []
  
  if (!parts || parts.length === 0) {
    return attachmentParts
  }
  
  for (const part of parts) {
    // Check if this part has an attachment
    // Criteria: part has filename OR body.attachmentId exists OR body.data exists (inline)
    const hasFilename = part.filename && part.filename.trim().length > 0
    const hasAttachmentId = part.body?.attachmentId
    const hasInlineData = !!part.body?.data
    
    if (hasFilename || hasAttachmentId || hasInlineData) {
      const filename = part.filename || ''
      const mimeType = part.mimeType || 'application/octet-stream'
      const attachmentId = part.body?.attachmentId || null
      const hasInlineDataFlag = hasInlineData && !hasAttachmentId
      
      // Include if we have at least an attachmentId, filename, or inline data
      if (attachmentId || filename || hasInlineDataFlag) {
        attachmentParts.push({
          part,
          attachmentId,
          filename,
          mimeType,
          hasInlineData: hasInlineDataFlag,
        })
      }
    }
    
    // Recursively check nested parts (multipart messages)
    if (part.parts && Array.isArray(part.parts) && part.parts.length > 0) {
      attachmentParts.push(...findAttachmentParts(part.parts))
    }
  }
  
  return attachmentParts
}

/**
 * Retrieve PDF attachments from Gmail messages or thread
 * 
 * Prefers messageIds if provided (fetches those messages directly).
 * Falls back to threadId if provided (fetches thread and processes all messages).
 */
export async function retrievePdfAttachmentsFromThread(
  params: RetrieveAttachmentsParams
): Promise<RetrieveAttachmentsResult> {
  const { caseId, threadId: providedThreadId, messageIds: providedMessageIds } = params
  
  // Get case to verify it exists
  const caseData = getCase(caseId)
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`)
  }
  
  // Get Gmail client
  const gmail = await getGmailClient()
  
  // Determine which messages to process
  let messageIdsInput: string[] = []
  let threadId: string | null = null
  
  if (providedMessageIds && providedMessageIds.length > 0) {
    // Prefer messageIds if provided
    messageIdsInput = providedMessageIds
    // Try to get threadId from first message
    try {
      const firstMsg = await gmail.users.messages.get({
        userId: 'me',
        id: messageIdsInput[0],
        format: 'metadata',
        metadataHeaders: ['Thread-Id'],
      })
      threadId = firstMsg.data.threadId || null
    } catch (err) {
      // If we can't get threadId, continue without it
      console.warn(`[ATTACHMENT_RETRIEVAL] Could not get threadId from message ${messageIdsInput[0]}`)
    }
  } else if (providedThreadId) {
    // Use threadId if provided
    threadId = providedThreadId
  } else {
    // Find threadId from case messages
    const messages = listMessages(caseId)
    const messageWithThread = messages.find(msg => msg.thread_id)
    if (messageWithThread?.thread_id) {
      threadId = messageWithThread.thread_id
    } else {
      throw new Error(`No threadId or messageIds found for case ${caseId}. Provide threadId/messageIds or ensure case has messages with thread_id.`)
    }
  }
  
  // Log attachment retrieval started
  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'ATTACHMENT_INGESTED',
    summary: `Retrieving PDF attachments${messageIdsInput.length > 0 ? ` from ${messageIdsInput.length} message(s)` : ` from thread ${threadId}`}`,
    evidence_refs_json: { message_ids: messageIdsInput },
    meta_json: { threadId, messageIds: messageIdsInput },
  })
  
  try {
    // Fetch messages: either specific messageIds or all messages from thread
    let messagesToProcess: any[] = []
    
    if (messageIdsInput.length > 0) {
      // Fetch specific messages
      const messagePromises = messageIdsInput.map(msgId =>
        gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'full',
        }).catch((err: any) => {
          console.error(`[ATTACHMENT_RETRIEVAL] Failed to fetch message ${msgId}:`, err.message)
          return null
        })
      )
      const messageResponses = await Promise.all(messagePromises)
      messagesToProcess = messageResponses
        .filter((resp): resp is any => resp !== null)
        .map(resp => resp.data)
    } else if (threadId) {
      // Fetch thread and get all messages
      const threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      })
      const thread = threadResponse.data
      messagesToProcess = thread.messages || []
      
      // Populate messageIdsInput from thread messages
      messageIdsInput = messagesToProcess.map(msg => msg.id || '').filter(Boolean)
    }
    
    if (messagesToProcess.length === 0) {
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'ATTACHMENT_INGESTED',
        summary: `No messages found${messageIdsInput.length > 0 ? ` for provided messageIds` : ` in thread ${threadId}`}`,
        evidence_refs_json: { message_ids: messageIdsInput },
        meta_json: { threadId, messageIds: messageIdsInput },
      })
      
      return {
        caseId,
        retrievedCount: 0,
        attachments: [],
        inserted: 0,
        reused: 0,
        skipped: 0,
        debug: {
          threadId,
          messageIdsInput,
          messagesFetched: 0,
          messagesSaved: 0,
          attachmentsFound: 0,
          attachmentsSaved: 0,
          attachmentsWithSha: 0,
          filenames: [],
          attachmentIds: [],
          errors: ['No messages found'],
        },
      }
    }
    
    const pdfAttachments: PdfAttachmentEvidence[] = []
    const attachmentIds: string[] = []
    const filenames: string[] = []
    const errors: string[] = []
    let inserted = 0
    let reused = 0
    let skipped = 0
    let attachmentsFound = 0
    let attachmentsSaved = 0
    let attachmentsWithSha = 0
    let messagesFetched = 0
    let messagesSaved = 0
    
    // Retrieval guard: Check existing attachments for this thread to avoid duplicates
    const db = getDb()
    const hasContentSha256 = hasColumn('attachments', 'content_sha256')
    
    // Get buyer email for message direction detection
    const buyerEmail = (process.env.GMAIL_SENDER_EMAIL || '').toLowerCase()
    
    // Process each message
    for (const message of messagesToProcess) {
      const messageId = message.id || ''
      if (!messageId) {
        errors.push('Message missing id')
        continue
      }
      
      messagesFetched++
      const payload = message.payload || {}
      
      // Extract message headers for saving
      const headers = payload.headers || []
      const getHeader = (name: string) => {
        const header = headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())
        return header?.value || ''
      }
      
      const fromEmail = getHeader('From').toLowerCase()
      const toEmail = getHeader('To')
      const subject = getHeader('Subject')
      const dateHeader = getHeader('Date')
      const receivedAt = message.internalDate ? parseInt(message.internalDate, 10) : Date.now()
      
      // Determine message direction
      const isInbound = !buyerEmail || !fromEmail.includes(buyerEmail)
      const direction = isInbound ? 'INBOUND' : 'OUTBOUND'
      
      // Save message to database (idempotent)
      try {
        addMessage(caseId, {
          message_id: messageId,
          case_id: caseId,
          direction,
          thread_id: threadId,
          from_email: getHeader('From'),
          to_email: toEmail,
          cc: getHeader('Cc') || null,
          subject: subject || null,
          body_text: null, // Will be populated if needed
          received_at: receivedAt,
        })
        messagesSaved++
      } catch (msgError: any) {
        const errorMsg = `Failed to save message ${messageId}: ${msgError.message}`
        console.warn(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
        errors.push(errorMsg)
        // Continue processing attachments even if message save fails
      }
      
      // Handle both single-part and multipart messages
      let parts: any[] = []
      if (payload.parts && Array.isArray(payload.parts) && payload.parts.length > 0) {
        // Multipart message
        parts = payload.parts
      } else if (payload.body?.attachmentId && payload.filename) {
        // Single-part message with attachment (treat payload itself as a part)
        parts = [payload]
      } else {
        // No parts or attachments found
        parts = []
      }
      
      // Find all attachment parts (recursive MIME walk)
      const attachmentParts = findAttachmentParts(parts)
      attachmentsFound += attachmentParts.length
      
      console.log(`[ATTACHMENT_RETRIEVAL] Message ${messageId}: Found ${attachmentParts.length} attachment part(s)`)
      
      // Filter for PDF attachments only
      // Criteria:
      // 1. mimeType === "application/pdf", OR
      // 2. filename ends with .pdf (case-insensitive), OR
      // 3. mimeType === "application/octet-stream" AND filename ends with .pdf
      const pdfParts = attachmentParts.filter(ap => {
        const filenameLower = (ap.filename || '').toLowerCase()
        const mimeTypeLower = (ap.mimeType || '').toLowerCase()
        
        return (
          mimeTypeLower === 'application/pdf' ||
          filenameLower.endsWith('.pdf') ||
          (mimeTypeLower === 'application/octet-stream' && filenameLower.endsWith('.pdf'))
        )
      })
      
      console.log(`[ATTACHMENT_RETRIEVAL] Message ${messageId}: Found ${pdfParts.length} PDF attachment(s)`)
      
      // Log each detected PDF attachment
      for (const pdfPart of pdfParts) {
        console.log(`[ATTACHMENT_RETRIEVAL] PDF detected:`, {
          filename: pdfPart.filename,
          mimeType: pdfPart.mimeType,
          attachmentId: pdfPart.attachmentId,
          hasInlineData: pdfPart.hasInlineData,
        })
      }
      
      // Download each PDF attachment
      for (const pdfPart of pdfParts) {
        try {
          console.log(`[ATTACHMENT_RETRIEVAL] Downloading attachment:`, {
            messageId: messageId,
            attachmentId: pdfPart.attachmentId,
            filename: pdfPart.filename,
            hasInlineData: pdfPart.hasInlineData,
          })
          
          let attachmentData = ''
          
          // Handle inline attachments (part.body.data exists but no attachmentId)
          if (pdfPart.hasInlineData && pdfPart.part.body?.data) {
            // Use inline data directly
            attachmentData = pdfPart.part.body.data
            console.log(`[ATTACHMENT_RETRIEVAL] Using inline data for attachment (no attachmentId)`)
          } else if (pdfPart.attachmentId) {
            // Get attachment data from Gmail API
            const attachmentResponse = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: messageId,
              id: pdfPart.attachmentId,
            })
            attachmentData = attachmentResponse.data.data || ''
          } else {
            const errorMsg = `No attachmentId and no inline data for attachment ${pdfPart.filename || 'unknown'}`
            console.warn(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
            errors.push(errorMsg)
            skipped++
            continue
          }
          
          if (!attachmentData) {
            const errorMsg = `No data returned for attachment ${pdfPart.attachmentId || 'inline'} (filename: ${pdfPart.filename || 'unknown'})`
            console.warn(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
            errors.push(errorMsg)
            skipped++
            continue
          }
          
          // ALWAYS compute content_sha256 + size_bytes immediately from decoded bytes
          // Use decodeBase64UrlToBuffer helper to match rehash logic
          const { decodeBase64UrlToBuffer } = require('./store')
          let binaryData: Buffer
          let sizeBytes: number
          let contentHash: string
          
          try {
            binaryData = decodeBase64UrlToBuffer(attachmentData)
            sizeBytes = binaryData.length
            
          if (sizeBytes === 0) {
            const errorMsg = `Empty bytes for attachment ${pdfPart.attachmentId || 'inline'} (filename: ${pdfPart.filename || 'unknown'})`
            console.warn(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
            errors.push(errorMsg)
            skipped++
            continue
          }
            
            contentHash = createHash('sha256').update(binaryData).digest('hex')
          } catch (decodeError: any) {
            const errorMsg = `Failed to decode attachment ${pdfPart.attachmentId || 'inline'} (filename: ${pdfPart.filename || 'unknown'}): ${decodeError.message}`
            console.error(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
            errors.push(errorMsg)
            skipped++
            continue
          }
          
          // Store base64-encoded data (normalized from base64url for storage)
          const base64Data = attachmentData.replace(/-/g, '+').replace(/_/g, '/')
          const padding = base64Data.length % 4
          const paddedBase64 = base64Data + (padding ? '='.repeat(4 - padding) : '')
          
          // Check for legacy rows: if binary_data_base64 exists but content_sha256 is null, compute and update
          if (hasContentSha256) {
            const legacyRows = db.prepare(`
              SELECT attachment_id, binary_data_base64
              FROM attachments
              WHERE message_id = ? AND filename = ? AND mime_type = 'application/pdf'
                AND binary_data_base64 IS NOT NULL
                AND content_sha256 IS NULL
            `).all(messageId, pdfPart.filename) as Array<{
              attachment_id: string
              binary_data_base64: string
            }>
            
            for (const legacyRow of legacyRows) {
              try {
                const legacyBinary = decodeBase64UrlToBuffer(legacyRow.binary_data_base64)
                const legacyHash = createHash('sha256').update(legacyBinary).digest('hex')
                const legacySize = legacyBinary.length
                db.prepare(`
                  UPDATE attachments
                  SET content_sha256 = ?, size_bytes = ?
                  WHERE attachment_id = ?
                `).run(legacyHash, legacySize, legacyRow.attachment_id)
                console.log(`[ATTACHMENT_RETRIEVAL] updated legacy row ${legacyRow.attachment_id} with hash`)
              } catch (err) {
                console.warn(`[ATTACHMENT_RETRIEVAL] failed to update legacy row ${legacyRow.attachment_id}:`, err)
              }
            }
          }
          
          // Get message received date (already extracted above)
          const receivedAt = message.internalDate ? parseInt(message.internalDate, 10) : Date.now()
          
          // Check if attachment with this content_sha256 already exists (before calling addAttachment)
          let wasReused = false
          if (hasContentSha256) {
            const existingByHash = db.prepare(`
              SELECT attachment_id FROM attachments WHERE content_sha256 = ? LIMIT 1
            `).get(contentHash) as { attachment_id: string } | undefined
            
            if (existingByHash) {
              wasReused = true
              reused++
              console.log(`[ATTACHMENT_RETRIEVAL] reuse by hash {sha_prefix: ${contentHash.substring(0, 16)}..., attachment_id: ${existingByHash.attachment_id}}`)
              // Still call addAttachment to update any missing fields, but we know it's a reuse
            }
          }
          
          // Create attachment ID (use Gmail attachment ID if available, otherwise generate)
          const attachmentId = pdfPart.attachmentId || `${Date.now()}-${Math.random().toString(36).substring(7)}`
          
          // Store attachment in database (idempotent upsert with content hash as primary identity)
          // Note: message_id is passed as first parameter, not in attachment object
          // addAttachment() will check by content_sha256 first and reuse existing row if found
          // CRITICAL: content_sha256 MUST be provided - it's required for evidence detection
          const storedAttachment = addAttachment(messageId, {
            attachment_id: attachmentId,
            filename: pdfPart.filename,
            mime_type: 'application/pdf',
            gmail_attachment_id: pdfPart.attachmentId,
            binary_data_base64: paddedBase64, // Store base64-encoded PDF (temporary for downstream parsing)
            content_sha256: contentHash, // SHA256 hash for content-based deduplication (PRIMARY IDENTITY) - REQUIRED
            size_bytes: sizeBytes, // Size in bytes
            text_extract: null, // Will be populated during PDF parsing
            parsed_fields_json: null,
            parse_confidence_json: null,
          })
          
          // Verify content_sha256 was persisted
          const verifyStmt = db.prepare('SELECT content_sha256 FROM attachments WHERE attachment_id = ?')
          const verifyRow = verifyStmt.get(storedAttachment.attachment_id) as { content_sha256: string | null } | undefined
          
          if (verifyRow?.content_sha256) {
            attachmentsWithSha++
          } else {
            const errorMsg = `CRITICAL: content_sha256 not persisted for attachment ${storedAttachment.attachment_id} (filename: ${pdfPart.filename || 'unknown'})`
            console.error(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
            errors.push(errorMsg)
          }
          
          // Track if this was actually inserted (new row) or reused (existing row)
          if (!wasReused) {
            // Check if the returned attachment_id matches what we tried to insert
            // If it doesn't match, it means addAttachment found an existing row by hash
            if (storedAttachment.attachment_id === attachmentId) {
              inserted++
            } else {
              reused++
              wasReused = true
            }
          }
          
          attachmentsSaved++
          filenames.push(pdfPart.filename || 'unknown.pdf')
          attachmentIds.push(storedAttachment.attachment_id)
          
          console.log(`[ATTACHMENT_RETRIEVAL] ${wasReused ? 'reused' : 'inserted'} attachment:`, {
            attachment_id: storedAttachment.attachment_id,
            filename: pdfPart.filename,
            messageId: messageId,
            sha256: contentHash.substring(0, 16) + '...',
            size_bytes: sizeBytes,
            content_sha256_persisted: !!verifyRow?.content_sha256,
          })
          
          // Create evidence object
          const evidence: PdfAttachmentEvidence = {
            attachment_id: storedAttachment.attachment_id,
            filename: pdfPart.filename || 'unknown.pdf',
            receivedAt,
            email_threadId: threadId ?? '',
            messageId: messageId,
            status: 'PDF_RETRIEVED',
            evidenceType: 'supplier_confirmation_pdf',
            binary_data_base64: paddedBase64,
          }
          
          pdfAttachments.push(evidence)
          attachmentIds.push(storedAttachment.attachment_id)
        } catch (error: any) {
          const errorMsg = `Error downloading attachment ${pdfPart.attachmentId || 'inline'} from message ${messageId} (filename: ${pdfPart.filename || 'unknown'}): ${error.message}`
          console.error(`[ATTACHMENT_RETRIEVAL] ${errorMsg}`)
          errors.push(errorMsg)
          skipped++
          // Continue with other attachments even if one fails
        }
      }
    }
    
    // Log successful retrieval
    if (pdfAttachments.length > 0) {
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'ATTACHMENT_INGESTED',
        summary: `Retrieved ${pdfAttachments.length} PDF attachment(s) from thread ${threadId}`,
        evidence_refs_json: {
          message_ids: Array.from(new Set(pdfAttachments.map(a => a.messageId))),
          attachment_ids: attachmentIds,
        },
        meta_json: {
          threadId,
          count: pdfAttachments.length,
          filenames: pdfAttachments.map(a => a.filename),
        },
      })
    } else {
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'ATTACHMENT_INGESTED',
        summary: `No PDF attachments found in thread ${threadId}`,
        evidence_refs_json: { message_ids: [] },
        meta_json: { threadId },
      })
    }
    
    // Counts are already tracked during the loop above (inserted, reused, skipped)
    // Return the counts from the retrieval process
    
    console.log(`[ATTACHMENT_RETRIEVAL] summary {inserted: ${inserted}, reused: ${reused}, skipped: ${skipped}, threadId: ${threadId}, caseId: ${caseId}}`)
    
    return {
      caseId,
      retrievedCount: pdfAttachments.length,
      attachments: pdfAttachments,
      inserted,
      reused,
      skipped,
      debug: {
        threadId,
        messageIdsInput,
        messagesFetched,
        messagesSaved,
        attachmentsFound,
        attachmentsSaved,
        attachmentsWithSha,
        filenames,
        attachmentIds,
        errors: errors.length > 0 ? errors : [],
      },
    }
  } catch (error) {
    console.error(`Error retrieving attachments from thread ${threadId}:`, error)
    
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'ATTACHMENT_INGESTED',
      summary: `Failed to retrieve attachments from thread ${threadId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      evidence_refs_json: { message_ids: [] },
      meta_json: { threadId, error: error instanceof Error ? error.message : 'Unknown error' },
    })
    
    throw error
  }
}
