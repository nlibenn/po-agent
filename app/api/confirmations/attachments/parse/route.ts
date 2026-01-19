import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { parseConfirmationFromText } from '@/src/lib/supplier-agent/pdfConfirmationParser'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/attachments/parse
 * Parse confirmation fields from PDF text_extract
 * 
 * Body:
 * {
 *   threadId: string
 *   poNumber?: string
 * }
 * 
 * Returns:
 * {
 *   best: {
 *     supplier_order_number: string | null
 *     confirmed_ship_date: string | null
 *     confirmed_quantity: number | null
 *     confirmed_uom: string | null
 *     source_attachment_id: string
 *     score: number
 *     matched: string[]
 *   } | null
 *   tried: number
 *   skipped_scanned: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.threadId) {
      return NextResponse.json(
        { error: 'Missing required field: threadId' },
        { status: 400 }
      )
    }
    
    const { threadId, poNumber } = body
    
    const db = getDb()
    
    // Load PDF attachments for this thread with non-empty text_extract
    const stmt = db.prepare(`
      SELECT 
        a.attachment_id,
        a.text_extract,
        a.filename,
        m.received_at,
        COALESCE(m.received_at, a.created_at) AS sort_ts,
        COALESCE(m.received_at, a.created_at) AS updated_at
      FROM attachments a
      INNER JOIN messages m ON a.message_id = m.message_id
      WHERE m.thread_id = ?
        AND a.mime_type = 'application/pdf'
        AND a.text_extract IS NOT NULL
        AND LENGTH(TRIM(a.text_extract)) > 0
      ORDER BY sort_ts DESC
    `)
    
    const attachments = stmt.all(threadId) as Array<{
      attachment_id: string
      text_extract: string
      filename: string | null
      received_at: number | null
      sort_ts: number
      updated_at: number
    }>
    
    console.log(`[PDF_PARSE] start ${threadId} count=${attachments.length}`)
    
    let tried = 0
    let skipped_scanned = 0
    const errors: string[] = []
    const results: Array<{
      supplier_order_number: string | null
      confirmed_ship_date: string | null
      confirmed_quantity: number | null
      confirmed_uom: string | null
      source_attachment_id: string
      score: number
      matched: string[]
      received_at: number | null
    }> = []
    
    for (const attachment of attachments) {
      const textExtract = attachment.text_extract.trim()
      
      // Skip scanned-like PDFs (very short text, length < 50)
      if (textExtract.length < 50) {
        skipped_scanned++
        continue
      }
      
      tried++
      
      // Parse text (catch errors per attachment, don't throw)
      try {
        const parsed = parseConfirmationFromText(textExtract, { poNumber })
        
        results.push({
          supplier_order_number: parsed.supplier_order_number,
          confirmed_ship_date: parsed.confirmed_ship_date,
          confirmed_quantity: parsed.confirmed_quantity,
          confirmed_uom: parsed.confirmed_uom,
          source_attachment_id: attachment.attachment_id,
          score: parsed.evidence.score,
          matched: parsed.evidence.matched,
          received_at: attachment.received_at,
        })
      } catch (error) {
        const errorMessage = `Attachment ${attachment.attachment_id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        errors.push(errorMessage)
        console.error(`[PDF_PARSE] error parsing attachment ${attachment.attachment_id}:`, error)
      }
    }
    
    // Choose best result: highest score, tie-breaker: newest received_at
    let best = null
    if (results.length > 0) {
      // Sort by score (desc), then by received_at (desc)
      results.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score
        }
        const aTime = a.received_at || 0
        const bTime = b.received_at || 0
        return bTime - aTime
      })
      
      best = results[0]
      console.log(`[PDF_PARSE] best score=${best.score} attachmentId=${best.source_attachment_id}`)
    }
    
    return NextResponse.json({
      best,
      tried,
      skipped_scanned,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to parse PDF attachments'
    console.error('[PDF_PARSE] error:', errorMessage)
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
