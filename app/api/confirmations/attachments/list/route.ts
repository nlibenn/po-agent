import { NextRequest, NextResponse } from 'next/server'
import { listAttachmentsForCase, listMessages } from '@/src/lib/supplier-agent/store'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * GET /api/confirmations/attachments/list?caseId=...&threadId=...
 * List PDF attachments from database for a case or thread
 * 
 * Query params:
 * - caseId: string (optional) - Case ID to filter by
 * - threadId: string (optional) - Thread ID to filter by
 * 
 * Returns:
 * {
 *   attachments: Array<{
 *     attachment_id: string
 *     message_id: string
 *     thread_id: string | null
 *     filename: string | null
 *     mime_type: string | null
 *     size_bytes: number | null
 *     received_at: number | null
 *     created_at: number
 *     text_extract: string | null
 *     extracted_length: number
 *     scanned_like: boolean
 *   }>
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const caseId = searchParams.get('caseId')
    let threadId = searchParams.get('threadId')

    // If caseId provided but no threadId, try to get from case.meta
    if (caseId && !threadId) {
      const { getCase } = await import('@/src/lib/supplier-agent/store')
      const caseData = getCase(caseId)
      if (caseData) {
        const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
        threadId = meta.thread_id || (caseData as any).thread_id || null
      }
    }

    if (!caseId && !threadId) {
      return NextResponse.json(
        { error: 'Missing required parameter: caseId or threadId' },
        { status: 400 }
      )
    }

    const db = getDb()
    let attachments: Array<{
      attachment_id: string
      message_id: string
      gmail_attachment_id: string | null
      filename: string | null
      mime_type: string | null
      text_extract: string | null
      created_at: number
      thread_id: string | null
      received_at: number | null
    }> = []

    if (caseId) {
      // Get attachments via case (using existing function)
      const caseAttachments = listAttachmentsForCase(caseId)
      attachments = caseAttachments.map(att => ({
        attachment_id: att.attachment_id,
        message_id: att.message_id,
        gmail_attachment_id: att.gmail_attachment_id,
        filename: att.filename,
        mime_type: att.mime_type,
        text_extract: att.text_extract,
        created_at: att.created_at,
        thread_id: null, // Will be populated from messages
        received_at: null, // Will be populated from messages
      }))

      // Get thread_id and received_at from messages
      const messages = listMessages(caseId)
      const messageMap = new Map(messages.map(m => [m.message_id, m]))
      attachments = attachments.map(att => {
        const msg = messageMap.get(att.message_id)
        return {
          ...att,
          thread_id: msg?.thread_id || null,
          received_at: msg?.received_at || null,
        }
      })
    } else if (threadId) {
      // Get attachments via thread_id
      const stmt = db.prepare(`
        SELECT 
          a.attachment_id,
          a.message_id,
          a.gmail_attachment_id,
          a.filename,
          a.mime_type,
          a.text_extract,
          a.created_at,
          m.thread_id,
          m.received_at
        FROM attachments a
        INNER JOIN messages m ON a.message_id = m.message_id
        WHERE m.thread_id = ?
          AND a.mime_type = 'application/pdf'
        ORDER BY COALESCE(m.received_at, a.created_at) DESC
      `)
      attachments = stmt.all(threadId) as typeof attachments
    }

    // Filter to PDFs only and calculate metadata
    const pdfAttachments = attachments
      .filter(att => att.mime_type === 'application/pdf')
      .map(att => {
        // Calculate size from base64 if available
        const sizeStmt = db.prepare('SELECT LENGTH(binary_data_base64) as size FROM attachments WHERE attachment_id = ?')
        const sizeRow = sizeStmt.get(att.attachment_id) as { size: number } | undefined
        const sizeBytes = sizeRow?.size ? Math.floor(sizeRow.size * 3 / 4) : null

        // Calculate extracted_length from text_extract
        const extractedLength = att.text_extract ? att.text_extract.length : 0
        const scannedLike = extractedLength > 0 && extractedLength < 50

        return {
          attachment_id: att.attachment_id,
          message_id: att.message_id,
          gmail_attachment_id: att.gmail_attachment_id,
          thread_id: att.thread_id || threadId || null,
          filename: att.filename || 'unknown.pdf',
          mime_type: att.mime_type || 'application/pdf',
          size_bytes: sizeBytes,
          received_at: att.received_at,
          created_at: att.created_at,
          updated_at: att.received_at || att.created_at,
          text_extract: att.text_extract,
          extracted_length: extractedLength,
          scanned_like: scannedLike,
        }
      })

    const dbCount = pdfAttachments.length
    console.log('[ATTACH_LIST]', { caseId: caseId || 'N/A', threadId: threadId || 'N/A', returnedCount: dbCount })

    return NextResponse.json({
      attachments: pdfAttachments,
    })
  } catch (error) {
    console.error('[EVIDENCE] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list attachments' },
      { status: 500 }
    )
  }
}
