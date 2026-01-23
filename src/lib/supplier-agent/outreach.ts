/**
 * Supplier Chase Agent Outreach Module
 * 
 * Handles drafting and sending confirmation emails to suppliers.
 * 
 * SERVER-ONLY: This module uses Gmail API which requires Node.js APIs.
 * Do not import this in client components.
 */

import 'server-only'

import { getGmailClient } from '../gmail/client'
import { normalizeEmailText } from '../utils/emailNormalization'

export interface SendEmailParams {
  to: string
  subject: string
  bodyText: string
  bcc?: string
}

export interface SendReplyParams {
  threadId: string
  to: string
  subject: string
  bodyText: string
  replyToMessageId?: string // Gmail message ID to reply to (for In-Reply-To header)
  originalSubject?: string // Original subject (without Re:) for subject normalization
  bcc?: string
}

export interface SendEmailResult {
  gmailMessageId: string
  threadId: string
}

/**
 * Build raw RFC 2822 email message
 */
function buildRawEmail({
  to,
  subject,
  bodyText,
  inReplyTo,
  references,
  from,
  bcc,
}: {
  to: string
  subject: string
  bodyText: string
  inReplyTo?: string
  references?: string
  from?: string
  bcc?: string
}): string {
  const fromEmail = from || process.env.GMAIL_SENDER_EMAIL || 'buyer@example.com'
  const date = new Date().toUTCString()
  
  // Normalize subject: ensure "Re:" prefix if replying
  let normalizedSubject = normalizeEmailText(subject)
  if (inReplyTo && !normalizedSubject.toLowerCase().startsWith('re:')) {
    normalizedSubject = `Re: ${normalizedSubject}`
  }
  
  // Normalize body text before sending
  const normalizedBodyText = normalizeEmailText(bodyText)
  
  let headers = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: ${normalizedSubject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
  ]
  
  // Add BCC header if provided
  if (bcc) {
    headers.push(`Bcc: ${bcc}`)
  }
  
  if (inReplyTo) {
    // Format In-Reply-To with angle brackets (RFC 2822)
    const inReplyToFormatted = inReplyTo.startsWith('<') ? inReplyTo : `<${inReplyTo}>`
    headers.push(`In-Reply-To: ${inReplyToFormatted}`)
  }
  
  if (references) {
    // Format References (may contain multiple message IDs, ensure angle brackets)
    const refFormatted = references.split(/\s+/).map(ref => {
      return ref.startsWith('<') ? ref : `<${ref}>`
    }).join(' ')
    headers.push(`References: ${refFormatted}`)
  }
  
  return `${headers.join('\r\n')}\r\n\r\n${normalizedBodyText}`
}

/**
 * Base64url encode a string
 */
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Generate confirmation email text
 * 
 * Re-exported from emailDraft.ts for backward compatibility.
 * Use emailDraft.ts in client components.
 */
export { generateConfirmationEmail } from './emailDraft'
export type { ConfirmationEmail } from './emailDraft'

/**
 * Send a new email via Gmail API
 */
export async function sendNewEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const gmail = await getGmailClient()
  const fromEmail = process.env.GMAIL_SENDER_EMAIL || 'buyer@example.com'
  
  const rawEmail = buildRawEmail({
    to: params.to,
    subject: params.subject,
    bodyText: params.bodyText,
    from: fromEmail,
    bcc: params.bcc,
  })
  
  const encoded = base64UrlEncode(rawEmail)
  
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
    },
  })
  
  return {
    gmailMessageId: response.data.id || '',
    threadId: response.data.threadId || '',
  }
}

/**
 * Send a reply in an existing Gmail thread
 */
export async function sendReplyInThread(params: SendReplyParams): Promise<SendEmailResult> {
  const gmail = await getGmailClient()
  const fromEmail = process.env.GMAIL_SENDER_EMAIL || 'buyer@example.com'
  
  // Use provided replyToMessageId if available, otherwise try to fetch from thread
  let inReplyTo: string | undefined
  let references: string | undefined
  
  if (params.replyToMessageId) {
    // Use provided messageId (should already be a Gmail message ID)
    inReplyTo = params.replyToMessageId
    
    // Try to fetch the message to get its Message-ID header and References chain
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: params.replyToMessageId,
        format: 'full',
      })
      
      const headers = msg.data.payload?.headers || []
      const messageIdHeader = headers.find((h: any) => h.name === 'Message-ID')?.value
      const referencesHeader = headers.find((h: any) => h.name === 'References')?.value
      
      if (messageIdHeader) {
        // Use the actual Message-ID header value (may be different format)
        inReplyTo = messageIdHeader
        references = referencesHeader 
          ? `${referencesHeader} ${messageIdHeader}`
          : messageIdHeader
      }
    } catch (error) {
      // If we can't fetch the message, use the Gmail message ID as-is
      console.warn('[AGENT_SEND] could not fetch message for reply headers, using messageId as-is:', error)
      references = params.replyToMessageId
    }
    
    console.log('[AGENT_SEND] using reply headers', {
      replyToMessageId: params.replyToMessageId,
      inReplyTo,
      threadId: params.threadId,
    })
  } else {
    // Fallback: try to get from thread (existing behavior)
    try {
      // Get thread messages to find the most recent one
      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: params.threadId,
        format: 'full',
      })
      
      const messages = thread.data.messages || []
      if (messages.length > 0) {
        // Get the most recent message in the thread
        const latestMessage = messages[messages.length - 1]
        const headers = latestMessage.payload?.headers || []
        
        const messageIdHeader = headers.find((h: any) => h.name === 'Message-ID')?.value
        const referencesHeader = headers.find((h: any) => h.name === 'References')?.value
        
        if (messageIdHeader) {
          inReplyTo = messageIdHeader
          references = referencesHeader 
            ? `${referencesHeader} ${messageIdHeader}`
            : messageIdHeader
        }
      }
    } catch (error) {
      // If we can't get thread details, continue without In-Reply-To/References
      console.warn('[AGENT_SEND] could not fetch thread details for reply headers:', error)
    }
  }
  
  // Use originalSubject if provided for subject normalization, otherwise use params.subject
  let subject = params.subject
  if (params.originalSubject && params.originalSubject && !subject.toLowerCase().startsWith('re:')) {
    // If we have original subject and current subject doesn't have Re:, add it
    subject = `Re: ${params.originalSubject}`
  }
  
  const rawEmail = buildRawEmail({
    to: params.to,
    subject: subject,
    bodyText: params.bodyText,
    from: fromEmail,
    inReplyTo,
    references,
    bcc: params.bcc,
  })
  
  const encoded = base64UrlEncode(rawEmail)
  
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
      threadId: params.threadId,
    },
  })
  
  return {
    gmailMessageId: response.data.id || '',
    threadId: response.data.threadId || params.threadId,
  }
}
