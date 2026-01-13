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
}

export interface SendReplyParams {
  threadId: string
  to: string
  subject: string
  bodyText: string
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
}: {
  to: string
  subject: string
  bodyText: string
  inReplyTo?: string
  references?: string
  from?: string
}): string {
  const fromEmail = from || process.env.GMAIL_SENDER_EMAIL || 'buyer@example.com'
  const date = new Date().toUTCString()
  
  // Normalize subject and body text before sending
  const normalizedSubject = normalizeEmailText(subject)
  const normalizedBodyText = normalizeEmailText(bodyText)
  
  let headers = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: ${normalizedSubject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
  ]
  
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`)
  }
  
  if (references) {
    headers.push(`References: ${references}`)
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
  
  // Try to get the original message to extract In-Reply-To and References headers
  let inReplyTo: string | undefined
  let references: string | undefined
  
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
    console.warn('Could not fetch thread details for reply headers:', error)
  }
  
  const rawEmail = buildRawEmail({
    to: params.to,
    subject: params.subject,
    bodyText: params.bodyText,
    from: fromEmail,
    inReplyTo,
    references,
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
