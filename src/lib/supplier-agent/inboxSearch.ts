/**
 * Supplier Chase Agent Inbox Search
 * 
 * Searches Gmail for supplier correspondence related to a PO and classifies results.
 * 
 * SERVER-ONLY: This module uses Gmail API which requires Node.js APIs.
 * Do not import this in client components.
 */

import 'server-only'

import { getGmailClient } from '../gmail/client'
import { getCase, addEvent, addMessage, listAttachmentsForCase } from './store'
import type { SupplierChaseCase, EventType } from './types'
import { retrievePdfAttachmentsFromThread } from './emailAttachments'
import { parseConfirmationFieldsSmart } from './parseConfirmationFields'
import { extractTextFromPdfBase64 } from './pdfTextExtraction'
import { getDb } from './storage/sqlite'

export interface InboxSearchParams {
  caseId: string
  poNumber: string
  lineId: string
  supplierEmail?: string | null
  supplierDomain?: string | null
  optionalKeywords?: string[]
  lookbackDays?: number
}

export interface ExtractedFields {
  acknowledgement?: 'yes' | 'no' | 'unclear'
  shipDate?: string
  deliveryDate?: string
  supplierReferenceNumber?: string
  quantity?: string
  pricingBasis?: string
}

export type SearchClassification = 'FOUND_CONFIRMED' | 'FOUND_INCOMPLETE' | 'NOT_FOUND'

export interface SearchResult {
  classification: SearchClassification
  matchedThreadId?: string
  matchedMessageIds: string[]
  extractedFields: ExtractedFields
  missingFields: string[]
  topCandidates: Array<{
    messageId: string
    threadId: string
    subject: string
    from: string
    to: string
    date: number
    score: number
  }>
  pdfCount: number
  hasPdfs: boolean
  parsedData?: {
    supplier_order_number: string | null
    delivery_date: string | null
    quantity: number | null
    unit_price: number | null
    extended_price?: number | null
    currency?: string | null
    payment_terms?: string | null
    freight_terms?: string | null
    freight_cost?: number | null
    subtotal?: number | null
    tax_amount?: number | null
    order_total?: number | null
    notes?: string | null
    backorder_status?: string | null
  }
  hasParsedData: boolean
}

/**
 * Build Gmail search query from parameters
 * 
 * For testing: Uses permissive subject-based query without from: filters
 */
export function buildGmailQuery(params: InboxSearchParams): string {
  const { poNumber, supplierEmail, supplierDomain, optionalKeywords, lookbackDays = 30 } = params
  
  // For testing: Use permissive subject-based query without from: filters
  // This allows testing with self-sent mail
  const queryParts: string[] = []
  
  // Subject-based search for PO number (more permissive)
  queryParts.push(`subject:(${poNumber}) OR "PO ${poNumber}" OR "PO ${poNumber} Confirmation"`)
  
  // Constrain to last N days (default 30 for testing)
  queryParts.push(`newer_than:${lookbackDays}d`)
  
  // Include optional keywords if provided (OR them together)
  if (optionalKeywords && optionalKeywords.length > 0) {
    const keywordQuery = optionalKeywords.map(k => `"${k}"`).join(' OR ')
    queryParts.push(`(${keywordQuery})`)
  }
  
  // NOTE: Removed from: filters for testing - they break with self-sent mail
  // TODO: Re-enable supplier filtering once testing is complete
  
  return queryParts.join(' ')
}

/**
 * Decode Gmail message body from base64url format
 */
function decodeMessageBody(parts: any[]): string {
  let bodyText = ''
  
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      // Decode base64url
      bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8')
      break
    } else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
      // Fallback to HTML (strip tags best-effort)
      const htmlText = Buffer.from(part.body.data, 'base64').toString('utf-8')
      bodyText = htmlText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    
    // Recursively check nested parts
    if (part.parts && part.parts.length > 0) {
      const nestedText = decodeMessageBody(part.parts)
      if (nestedText && (!bodyText || part.mimeType === 'text/plain')) {
        bodyText = nestedText
      }
    }
  }
  
  return bodyText
}

/**
 * Extract fields from message body using simple heuristics
 */
function extractFields(bodyText: string): ExtractedFields {
  const extracted: ExtractedFields = {}
  const lowerBody = bodyText.toLowerCase()
  
  // Check for acknowledgement
  const confirmPatterns = [
    /confirmed/i,
    /we will ship/i,
    /we will deliver/i,
    /acknowledged/i,
    /ack/i,
    /confirmed your order/i,
  ]
  const denyPatterns = [
    /cannot confirm/i,
    /unable to confirm/i,
    /we cannot/i,
  ]
  
  if (confirmPatterns.some(p => p.test(bodyText))) {
    extracted.acknowledgement = 'yes'
  } else if (denyPatterns.some(p => p.test(bodyText))) {
    extracted.acknowledgement = 'no'
  }
  
  // Extract ship/delivery date (simple date regex)
  const datePatterns = [
    /(?:ship|shipping|deliver|delivery).*?(?:date|by|on)\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(?:date|by|on)\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}).*?(?:ship|shipping|deliver|delivery)/i,
    /(?:ship|deliver|delivery).*?(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4})/i,
  ]
  
  for (const pattern of datePatterns) {
    const match = bodyText.match(pattern)
    if (match && match[1]) {
      if (pattern.source.includes('ship')) {
        extracted.shipDate = match[1].trim()
      } else {
        extracted.deliveryDate = match[1].trim()
      }
      break
    }
  }
  
  // Extract supplier reference number (specific patterns only)
  // Only matches: SO#, Sales Order, Order #, Ack #, Confirmation #
  const refPatterns = [
    /\bSO\s*#?\s*:?\s*([A-Z0-9\-]+)/i,
    /\bSales\s+Order\s*#?\s*:?\s*([A-Z0-9\-]+)/i,
    /\bOrder\s*#\s*:?\s*([A-Z0-9\-]+)/i,
    /\bAck\s*#\s*:?\s*([A-Z0-9\-]+)/i,
    /\bConfirmation\s*#\s*:?\s*([A-Z0-9\-]+)/i,
  ]
  
  for (const pattern of refPatterns) {
    const match = bodyText.match(pattern)
    if (match && match[1]) {
      extracted.supplierReferenceNumber = match[1].trim()
      break
    }
  }
  
  // Extract quantity (if explicitly mentioned)
  const qtyPattern = /(?:qty|quantity|Quantity|QTY)[\s#:]*(\d+(?:\.\d+)?(?:\s*(?:pcs|pieces|units|ea))?)/i
  const qtyMatch = bodyText.match(qtyPattern)
  if (qtyMatch && qtyMatch[1]) {
    extracted.quantity = qtyMatch[1].trim()
  }
  
  // Extract pricing basis (if explicitly mentioned)
  const pricingPatterns = [
    /(?:price|pricing|basis|Price|Pricing|Basis)[\s#:]*([^\n\r]{10,50})/i,
    /(?:per|@)\s*(piece|pc|unit|lb|kg|m|ft|yard|meter)/i,
  ]
  for (const pattern of pricingPatterns) {
    const match = bodyText.match(pattern)
    if (match && match[1]) {
      extracted.pricingBasis = match[1].trim()
      break
    }
  }
  
  return extracted
}

/**
 * Score a message for relevance
 */
function scoreMessage(
  message: any,
  fromEmail: string,
  toEmails: string,
  supplierEmail: string | null | undefined,
  supplierDomain: string | null | undefined
): number {
  let score = 0
  
  // Recency (more recent = higher score)
  const messageDate = parseInt(message.internalDate || '0', 10)
  const daysAgo = (Date.now() - messageDate) / (1000 * 60 * 60 * 24)
  score += Math.max(0, 100 - daysAgo) // 100 points for today, decreasing by 1 per day
  
  // Supplier-sent messages get higher score
  if (supplierEmail && fromEmail.toLowerCase().includes(supplierEmail.toLowerCase())) {
    score += 50
  } else if (supplierDomain && fromEmail.toLowerCase().includes(supplierDomain.toLowerCase())) {
    score += 50
  } else if (supplierEmail && fromEmail.toLowerCase().includes(supplierEmail.toLowerCase())) {
    score += 50
  }
  
  // Keyword hits
  const keywordPatterns = [
    /confirmed/i,
    /confirmation/i,
    /ack/i,
    /acknowledge/i,
    /ship/i,
    /delivery/i,
    /promise/i,
    /\bSO\b/i,
    /sales order/i,
    /order\s*#/i,
  ]
  
  const subject = message.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || ''
  const body = message.snippet || ''
  const text = `${subject} ${body}`.toLowerCase()
  
  keywordPatterns.forEach(pattern => {
    if (pattern.test(text)) {
      score += 10
    }
  })
  
  return score
}

/**
 * Search Gmail inbox for supplier confirmation
 */
export async function searchInboxForConfirmation(params: InboxSearchParams): Promise<SearchResult> {
  const { caseId, poNumber, supplierEmail, supplierDomain } = params
  
  // Get case to check missing_fields
  const caseData = getCase(caseId)
  if (!caseData) {
    throw new Error(`Case ${caseId} not found`)
  }
  
  // Build query
  const query = buildGmailQuery(params)
  
  // Log exact query string
  console.log(`[INBOX_SEARCH] Gmail query for PO ${poNumber}:`, query)
  
  // Get Gmail client
  const gmail = await getGmailClient()
  
  // Log search started event
  addEvent(caseId, {
    case_id: caseId,
    timestamp: Date.now(),
    event_type: 'INBOX_SEARCH_STARTED',
    summary: `Searching Gmail inbox for PO ${poNumber} confirmation`,
    evidence_refs_json: null,
    meta_json: { query, supplierEmail, supplierDomain },
  })
  
  try {
    // Search for messages
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20,
    })
    
    const messages = listResponse.data.messages || []
    
    // Log how many message IDs returned
    console.log(`[INBOX_SEARCH] Found ${messages.length} message ID(s) for PO ${poNumber}`)
    
    if (messages.length === 0) {
      // No messages found
      addEvent(caseId, {
        case_id: caseId,
        timestamp: Date.now(),
        event_type: 'INBOX_SEARCH_NOT_FOUND',
        summary: `No Gmail messages found for PO ${poNumber}`,
        evidence_refs_json: { message_ids: [] },
        meta_json: { query },
      })
      
      // Count PDF attachments even if no messages found
      const attachments = listAttachmentsForCase(caseId)
      const pdfCount = attachments.filter(a => a.mime_type === 'application/pdf').length
      const hasPdfs = pdfCount > 0
      
      return {
        classification: 'NOT_FOUND',
        matchedMessageIds: [],
        extractedFields: {},
        missingFields: caseData.missing_fields,
        topCandidates: [],
        pdfCount,
        hasPdfs,
        parsedData: undefined,
        hasParsedData: false,
      }
    }
    
    // Fetch full message details for top candidates
    const messagePromises = messages.slice(0, 10).map(msg =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      })
    )
    
    const fullMessages = await Promise.all(messagePromises)
    
    // Log details for first 3 messages
    const messagesToLog = fullMessages.slice(0, 3)
    for (let i = 0; i < messagesToLog.length; i++) {
      const msg = messagesToLog[i].data
      const headers = msg.payload?.headers || []
      const subjectHeader = headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)'
      const fromHeader = headers.find((h: any) => h.name === 'From')?.value || '(unknown)'
      const dateHeader = headers.find((h: any) => h.name === 'Date')?.value || '(no date)'
      const threadId = msg.threadId || '(no thread)'
      
      console.log(`[INBOX_SEARCH] Message ${i + 1}/${messagesToLog.length}:`, {
        messageId: msg.id,
        subject: subjectHeader,
        from: fromHeader,
        date: dateHeader,
        threadId: threadId,
      })
    }
    
    // Score and rank messages
    const scoredMessages = fullMessages.map(msg => {
      const messageId = msg.data.id || ''
      const threadId = msg.data.threadId || ''
      const headers = msg.data.payload?.headers || []
      const fromHeader = headers.find((h: any) => h.name === 'From')?.value || ''
      const toHeader = headers.find((h: any) => h.name === 'To')?.value || ''
      const subjectHeader = headers.find((h: any) => h.name === 'Subject')?.value || ''
      
      const score = scoreMessage(msg.data, fromHeader, toHeader, supplierEmail, supplierDomain)
      
      return {
        message: msg.data,
        messageId,
        threadId,
        score,
        from: fromHeader,
        to: toHeader,
        subject: subjectHeader,
      }
    })
    
    // Sort by score (highest first)
    scoredMessages.sort((a, b) => b.score - a.score)
    
    // Get top candidates
    const topCandidates = scoredMessages.slice(0, 5).map(item => ({
      messageId: item.messageId,
      threadId: item.threadId,
      subject: item.subject,
      from: item.from,
      to: item.to,
      date: parseInt(item.message.internalDate || '0', 10),
      score: item.score,
    }))
    
    // Log top messageId + threadId (dev only, server-side)
    if (topCandidates.length > 0 && process.env.NODE_ENV !== 'production') {
      const topCandidate = topCandidates[0]
      console.log('Top Gmail message:', { messageId: topCandidate.messageId, threadId: topCandidate.threadId })
    }
    
    // Extract fields from top message
    const topMessage = scoredMessages[0]?.message
    let extractedFields: ExtractedFields = {}
    
    if (topMessage) {
      let bodyText = decodeMessageBody(topMessage.payload?.parts || [])
      
      // Fallback to single-part message body
      if (!bodyText && topMessage.payload?.body?.data) {
        bodyText = Buffer.from(topMessage.payload.body.data, 'base64').toString('utf-8')
      }
      
      // Fallback to snippet if body extraction failed
      if (!bodyText && topMessage.snippet) {
        bodyText = topMessage.snippet
      }
      
      if (bodyText) {
        extractedFields = extractFields(bodyText)
      }
      
      // Store messages in database
      const threadId = topMessage.threadId || null
      const fromHeader = topMessage.payload?.headers?.find((h: any) => h.name === 'From')?.value || null
      const toHeader = topMessage.payload?.headers?.find((h: any) => h.name === 'To')?.value || null
      const subjectHeader = topMessage.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || null
      const dateHeader = topMessage.payload?.headers?.find((h: any) => h.name === 'Date')?.value || null
      const ccHeader = topMessage.payload?.headers?.find((h: any) => h.name === 'Cc')?.value || null
      
      // Determine direction
      const buyerEmail = process.env.GMAIL_SENDER_EMAIL?.toLowerCase() || ''
      const isFromSupplier = supplierEmail
        ? fromHeader?.toLowerCase().includes(supplierEmail.toLowerCase())
        : supplierDomain
        ? fromHeader?.toLowerCase().includes(supplierDomain.toLowerCase())
        : false
      
      const direction = isFromSupplier ? 'INBOUND' : 'OUTBOUND'
      
      // Store top candidates in database
      for (const candidate of topCandidates) {
        const msg = scoredMessages.find(s => s.messageId === candidate.messageId)?.message
        if (msg) {
          const msgFrom = msg.payload?.headers?.find((h: any) => h.name === 'From')?.value || null
          const msgTo = msg.payload?.headers?.find((h: any) => h.name === 'To')?.value || null
          const msgSubject = msg.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || null
          let msgBody = decodeMessageBody(msg.payload?.parts || [])
          
          // Fallback to snippet if body extraction failed
          if (!msgBody && msg.snippet) {
            msgBody = msg.snippet
          }
          
          const msgDate = parseInt(msg.internalDate || '0', 10)
          const msgIsFromSupplier = supplierEmail
            ? msgFrom?.toLowerCase().includes(supplierEmail.toLowerCase())
            : supplierDomain
            ? msgFrom?.toLowerCase().includes(supplierDomain.toLowerCase())
            : false
          
          // Use Gmail message ID as the message_id and threadId as thread_id
          addMessage(caseId, {
            message_id: candidate.messageId, // Gmail message ID
            case_id: caseId,
            direction: msgIsFromSupplier ? 'INBOUND' : 'OUTBOUND',
            thread_id: candidate.threadId || null, // Gmail thread ID
            from_email: msgFrom,
            to_email: msgTo,
            cc: msg.payload?.headers?.find((h: any) => h.name === 'Cc')?.value || null,
            subject: msgSubject,
            body_text: msgBody ? msgBody.substring(0, 10000) : null, // Limit body text length
            received_at: msgDate,
          })
        }
      }
    }
    
    // AUTOMATIC PDF PARSING: If we found a thread, retrieve and parse PDF attachments
    let parsedData: SearchResult['parsedData'] | undefined = undefined
    let hasParsedData = false
    
    if (topCandidates.length > 0 && topCandidates[0]?.threadId) {
      const threadId = topCandidates[0].threadId
      console.log(`[INBOX_SEARCH] Retrieving PDF attachments from thread ${threadId} for automatic parsing`)
      
      try {
        // Retrieve PDF attachments from the thread
        await retrievePdfAttachmentsFromThread({
          caseId,
          threadId,
        })
        
        // Get PDF attachments with binary data
        const db = getDb()
        const rawAttachments = db
          .prepare(`
            SELECT a.attachment_id, a.filename, a.text_extract, a.binary_data_base64
            FROM attachments a
            INNER JOIN messages m ON m.message_id = a.message_id
            WHERE m.case_id = ?
              AND a.mime_type = 'application/pdf'
            ORDER BY m.received_at DESC
          `)
          .all(caseId) as Array<{
            attachment_id: string
            filename: string | null
            text_extract: string | null
            binary_data_base64: string | null
          }>
        
        if (rawAttachments.length > 0) {
          console.log(`[INBOX_SEARCH] Found ${rawAttachments.length} PDF attachment(s), extracting text and parsing...`)
          
          // Extract text from PDFs
          const pdfTexts: Array<{ attachment_id: string; text: string | null }> = []
          
          for (const att of rawAttachments) {
            let text = att.text_extract
            
            if ((!text || text.trim().length === 0) && att.binary_data_base64) {
              try {
                text = await extractTextFromPdfBase64(att.binary_data_base64)
                if (text && text.trim().length > 0) {
                  db.prepare('UPDATE attachments SET text_extract = ? WHERE attachment_id = ?')
                    .run(text, att.attachment_id)
                }
              } catch (e) {
                console.warn(`[INBOX_SEARCH] PDF extraction failed for ${att.attachment_id}:`, e)
              }
            }
            
            if (text && text.trim().length > 0) {
              pdfTexts.push({ attachment_id: att.attachment_id, text })
            }
          }
          
          if (pdfTexts.length > 0) {
            console.log(`[INBOX_SEARCH] Extracted text from ${pdfTexts.length} PDF(s), parsing confirmation fields...`)
            
            // Extract expected quantity and unit price from case meta if available
            let expectedQty: number | null = null
            let expectedUnitPrice: number | null = null
            if (caseData.meta) {
              try {
                const meta = typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta
                if (meta.po_line?.ordered_quantity) {
                  const qty = typeof meta.po_line.ordered_quantity === 'number' 
                    ? meta.po_line.ordered_quantity 
                    : parseFloat(String(meta.po_line.ordered_quantity))
                  if (Number.isFinite(qty) && qty > 0) {
                    expectedQty = qty
                  }
                }
                if (meta.po_line?.unit_price) {
                  const price = typeof meta.po_line.unit_price === 'number'
                    ? meta.po_line.unit_price
                    : parseFloat(String(meta.po_line.unit_price).replace(/[$,\s]/g, ''))
                  if (Number.isFinite(price) && price > 0) {
                    expectedUnitPrice = price
                  }
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
            
            // Parse confirmation fields using smart parser
            const parsed = await parseConfirmationFieldsSmart({
              poNumber,
              lineId: params.lineId,
              pdfTexts,
              expectedQty: expectedQty ?? undefined,
              expectedUnitPrice: expectedUnitPrice ?? undefined,
              debug: false,
            })
            
            // Extract parsed data
            parsedData = {
              supplier_order_number: parsed.supplier_order_number.value,
              delivery_date: parsed.confirmed_delivery_date.value,
              quantity: parsed.supplier_confirmed_quantity.value,
              unit_price: parsed.unit_price?.value ?? null,
              extended_price: parsed.extended_price?.value ?? null,
              currency: parsed.currency?.value ?? null,
              payment_terms: parsed.payment_terms?.value ?? null,
              freight_terms: parsed.freight_terms?.value ?? null,
              freight_cost: parsed.freight_cost?.value ?? null,
              subtotal: parsed.subtotal?.value ?? null,
              tax_amount: parsed.tax_amount?.value ?? null,
              order_total: parsed.order_total?.value ?? null,
              notes: parsed.notes?.value ?? null,
              backorder_status: parsed.backorder_status?.value ?? null,
            }
            
            hasParsedData = !!(parsedData.supplier_order_number || parsedData.delivery_date || parsedData.quantity !== null)
            
            console.log(`[INBOX_SEARCH] PDF parsing complete:`, {
              hasParsedData,
              supplier_order_number: parsedData.supplier_order_number,
              delivery_date: parsedData.delivery_date,
              quantity: parsedData.quantity,
            })
          }
        }
      } catch (parseError) {
        console.error(`[INBOX_SEARCH] Error parsing PDFs:`, parseError)
        // Continue without parsed data - don't fail the whole search
      }
    }
    
    // Determine missing fields - now consider both email text AND parsed PDF data
    const missingFields: string[] = []
    for (const field of caseData.missing_fields) {
      // Check both email text extraction and PDF parsing results
      const foundInEmail = 
        (field === 'delivery_date' && (extractedFields.deliveryDate || extractedFields.shipDate)) ||
        (field === 'ship_date' && extractedFields.shipDate) ||
        (field === 'pricing_basis' && extractedFields.pricingBasis) ||
        (field === 'supplier_reference' && extractedFields.supplierReferenceNumber) ||
        (field === 'acknowledgement' && extractedFields.acknowledgement) ||
        (field === 'quantity' && extractedFields.quantity)
      
      const foundInPdf = parsedData &&
        ((field === 'delivery_date' && parsedData.delivery_date) ||
         (field === 'supplier_reference' && parsedData.supplier_order_number) ||
         (field === 'quantity' && parsedData.quantity !== null))
      
      if (!foundInEmail && !foundInPdf) {
        missingFields.push(field)
      }
    }
    
    // Classify result
    let classification: SearchClassification
    let eventType: EventType
    
    if (missingFields.length === 0) {
      classification = 'FOUND_CONFIRMED'
      eventType = 'INBOX_SEARCH_FOUND_CONFIRMED'
    } else if (missingFields.length < caseData.missing_fields.length) {
      classification = 'FOUND_INCOMPLETE'
      eventType = 'INBOX_SEARCH_FOUND_INCOMPLETE'
    } else {
      classification = 'NOT_FOUND'
      eventType = 'INBOX_SEARCH_NOT_FOUND'
    }
    
    // Count PDF attachments for this case
    const attachments = listAttachmentsForCase(caseId)
    const pdfCount = attachments.filter(a => a.mime_type === 'application/pdf').length
    const hasPdfs = pdfCount > 0
    
    // Log classification event
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: eventType,
      summary: `Gmail inbox search ${classification.toLowerCase().replace('_', ' ')} for PO ${poNumber}`,
      evidence_refs_json: {
        message_ids: topCandidates.map(c => c.messageId),
        attachment_ids: [],
      },
      meta_json: {
        extractedFields,
        missingFields,
        topThreadId: topCandidates[0]?.threadId,
        pdfCount,
        hasPdfs,
        hasParsedData,
        parsedData,
      },
    })
    
    return {
      classification,
      matchedThreadId: topCandidates[0]?.threadId,
      matchedMessageIds: topCandidates.map(c => c.messageId),
      extractedFields,
      missingFields,
      topCandidates,
      pdfCount,
      hasPdfs,
      parsedData,
      hasParsedData,
    }
  } catch (error) {
    console.error('Error searching Gmail inbox:', error)
    
    // Log error event
    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'INBOX_SEARCH_NOT_FOUND',
      summary: `Gmail inbox search failed for PO ${poNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      evidence_refs_json: null,
      meta_json: { error: error instanceof Error ? error.message : 'Unknown error' },
    })
    
    throw error
  }
}
