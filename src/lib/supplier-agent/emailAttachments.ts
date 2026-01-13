/**
 * Email Attachment Retrieval for Supplier Confirmations
 * 
 * Retrieves PDF attachments from Gmail threads related to supplier confirmation cases.
 * 
 * SERVER-ONLY: This module uses Gmail API which requires Node.js APIs.
 * Do not import this in client components.
 */

import 'server-only'

import { getGmailClient } from '../gmail/client'
import { getCase, listMessages, addAttachment, addEvent } from './store'
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
  threadId?: string // Optional: if not provided, will search for thread from case messages
}

export interface RetrieveAttachmentsResult {
  caseId: string
  retrievedCount: number
  attachments: PdfAttachmentEvidence[]
}

/**
 * Recursively find all parts in a Gmail message payload that have attachments
 * Robust MIME walk: handles nested parts, various MIME types, and edge cases
 */
function findAttachmentParts(parts: any[]): Array<{ part: any; attachmentId: string; filename: string; mimeType: string }> {
  const attachmentParts: Array<{ part: any; attachmentId: string; filename: string; mimeType: string }> = []
  
  if (!parts || parts.length === 0) {
    return attachmentParts
  }
  
  for (const part of parts) {
    // Check if this part has an attachment
    // Criteria: part has filename AND body.attachmentId exists
    if (part.filename && part.body?.attachmentId) {
      const filename = part.filename || ''
      const mimeType = part.mimeType || 'application/octet-stream'
      const attachmentId = part.body.attachmentId
      
      attachmentParts.push({
        part,
        attachmentId,
        filename,
        mimeType,
      })
    }
    
    // Recursively check nested parts (multipart messages)
    if (part.parts && Array.isArray(part.parts) && part.parts.length > 0) {
      attachmentParts.push(...findAttachmentParts(part.parts))
    }
  }
  
  return attachmentParts
}

/**
 * Retrieve PDF attachments from a Gmail thread
 */
export async function retrievePdfAttachmentsFromThread(
  params: RetrieveAttachmentsParams
): Promise<RetrieveAttachmentsResult> {
  const { caseId, threadId: providedThreadId } = params
  
  // Get case to verify it exists
  const caseData = getCase(caseId)
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`)
  }
  
  // Get Gmail client
  const gmail = await getGmailClient()
  
  // Determine threadId: use provided or find from case messages
  let threadId: string | null = providedThreadId || null
  
  if (!threadId) {
    // Find threadId from case messages
    const messages = listMessages(caseId)
    const messageWithThread = messages.find(msg => msg.thread_id)
    if (messageWithThread?.thread_id) {
      threadId = messageWithThread.thread_id
    } else {
      throw new Error(`No threadId found for case ${caseId}. Provide threadId or ensure case has messages with thread_id.`)
    }
  }
  
  // Log attachment retrieval started
  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'ATTACHMENT_INGESTED',
    summary: `Retrieving PDF attachments from Gmail thread ${threadId}`,
    evidence_refs_json: { message_ids: [] },
    meta_json: { threadId },
  })
  
  try {
    // Get thread details
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    })
    
    const thread = threadResponse.data
    const messages = thread.messages || []
    
    if (messages.length === 0) {
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'ATTACHMENT_INGESTED',
        summary: `No messages found in thread ${threadId}`,
        evidence_refs_json: { message_ids: [] },
        meta_json: { threadId },
      })
      
      return {
        caseId,
        retrievedCount: 0,
        attachments: [],
      }
    }
    
    const pdfAttachments: PdfAttachmentEvidence[] = []
    const attachmentIds: string[] = []
    
    // Process each message in the thread
    for (const message of messages) {
      const messageId = message.id || ''
      const payload = message.payload || {}
      
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
        })
      }
      
      // Download each PDF attachment
      for (const pdfPart of pdfParts) {
        try {
          console.log(`[ATTACHMENT_RETRIEVAL] Downloading attachment:`, {
            messageId: messageId,
            attachmentId: pdfPart.attachmentId,
            filename: pdfPart.filename,
          })
          
          // Get attachment data from Gmail
          const attachmentResponse = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: messageId,
            id: pdfPart.attachmentId,
          })
          
          const attachmentData = attachmentResponse.data.data || ''
          
          if (!attachmentData) {
            console.warn(`[ATTACHMENT_RETRIEVAL] No data returned for attachment ${pdfPart.attachmentId}`)
            continue
          }
          
          // Decode base64url to base64 (Gmail API uses base64url encoding)
          // base64url uses - and _ instead of + and /, and no padding
          const base64Data = attachmentData.replace(/-/g, '+').replace(/_/g, '/')
          const padding = base64Data.length % 4
          const paddedBase64 = base64Data + (padding ? '='.repeat(4 - padding) : '')
          
          console.log(`[ATTACHMENT_RETRIEVAL] Downloaded ${paddedBase64.length} base64 characters for ${pdfPart.filename}`)
          
          // Get message received date
          const headers = message.payload?.headers || []
          const dateHeader = headers.find((h: any) => h.name === 'Date')?.value || null
          const receivedAt = message.internalDate ? parseInt(message.internalDate, 10) : Date.now()
          
          // Create attachment ID (use Gmail attachment ID if available, otherwise generate)
          const attachmentId = pdfPart.attachmentId || `${Date.now()}-${Math.random().toString(36).substring(7)}`
          
          // Store attachment in database
          // Note: message_id is passed as first parameter, not in attachment object
          const storedAttachment = addAttachment(messageId, {
            attachment_id: attachmentId,
            filename: pdfPart.filename,
            mime_type: 'application/pdf',
            gmail_attachment_id: pdfPart.attachmentId,
            binary_data_base64: paddedBase64, // Store base64-encoded PDF (temporary for downstream parsing)
            text_extract: null, // Will be populated during PDF parsing
            parsed_fields_json: null,
            parse_confidence_json: null,
          })
          
          console.log(`[ATTACHMENT_RETRIEVAL] Stored attachment in database:`, {
            attachment_id: storedAttachment.attachment_id,
            filename: pdfPart.filename,
            messageId: messageId,
          })
          
          // Create evidence object
          const evidence: PdfAttachmentEvidence = {
            attachment_id: storedAttachment.attachment_id,
            filename: pdfPart.filename || 'unknown.pdf',
            receivedAt,
            email_threadId: threadId,
            messageId: messageId,
            status: 'PDF_RETRIEVED',
            evidenceType: 'supplier_confirmation_pdf',
            binary_data_base64: paddedBase64,
          }
          
          pdfAttachments.push(evidence)
          attachmentIds.push(storedAttachment.attachment_id)
        } catch (error) {
          console.error(`[ATTACHMENT_RETRIEVAL] Error downloading attachment ${pdfPart.attachmentId} from message ${messageId}:`, error)
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
    
    return {
      caseId,
      retrievedCount: pdfAttachments.length,
      attachments: pdfAttachments,
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
