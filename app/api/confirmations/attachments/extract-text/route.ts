import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { extractTextFromPdfBase64 } from '@/src/lib/supplier-agent/pdfTextExtraction'

export const runtime = "nodejs"

/**
 * POST /api/confirmations/attachments/extract-text
 * Extract text from stored PDF attachments
 * 
 * Body:
 * {
 *   attachmentIds: string[]  // Array of attachment IDs to extract text from
 * }
 * 
 * Returns:
 * {
 *   results: Array<{
 *     attachmentId: string
 *     ok: boolean
 *     extracted_length: number
 *     scanned_like: boolean  // true if extracted_length < 50
 *     skipped: boolean
 *     error?: string
 *   }>
 * }
 */
export async function POST(request: NextRequest) {
  const results: Array<{
    attachmentId: string
    ok: boolean
    extracted_length: number
    scanned_like: boolean
    skipped: boolean
    error?: string
  }> = []

  try {
    const body = await request.json()

    // Validate required fields
    if (!body.attachmentIds || !Array.isArray(body.attachmentIds)) {
      return NextResponse.json(
        { error: 'Missing required field: attachmentIds (must be an array)' },
        { status: 400 }
      )
    }

    const { attachmentIds } = body as { attachmentIds: string[] }

    if (attachmentIds.length === 0) {
      return NextResponse.json({ results })
    }

    console.log(`[PDF_TEXT] start ${attachmentIds.length}`)
    console.log('[PDF_TEXT] attachment sort uses COALESCE(received_at, created_at)')

    const db = getDb()

    let successCount = 0
    let scannedCount = 0
    let errorCount = 0

    // Process each attachment (never abort the whole request for per-attachment SQL errors)
    for (const attachmentId of attachmentIds) {
      try {
        // NOTE: attachments table does NOT have updated_at (schema.sql). Do not reference it.
        const getStmt = db.prepare(`
          SELECT attachment_id, binary_data_base64, text_extract
          FROM attachments
          WHERE attachment_id = ?
        `)
        const attachment = getStmt.get(attachmentId) as {
          attachment_id: string
          binary_data_base64: string | null
          text_extract: string | null
        } | undefined

        if (!attachment) {
          results.push({
            attachmentId,
            ok: false,
            extracted_length: 0,
            skipped: true,
            scanned_like: false,
            error: 'Attachment not found',
          })
          errorCount++
          continue
        }

        // Skip if text_extract already exists and is non-empty (idempotent)
        if (attachment.text_extract && attachment.text_extract.trim().length > 0) {
          const existingLength = attachment.text_extract.length
          results.push({
            attachmentId,
            ok: true,
            extracted_length: existingLength,
            skipped: true,
            scanned_like: existingLength < 50,
          })
          continue
        }

        // Check if binary data exists
        if (!attachment.binary_data_base64 || attachment.binary_data_base64.trim().length === 0) {
          results.push({
            attachmentId,
            ok: false,
            extracted_length: 0,
            skipped: true,
            scanned_like: false,
            error: 'No binary data available',
          })
          errorCount++
          continue
        }

        // Extract text from PDF
        const extractedText = await extractTextFromPdfBase64(attachment.binary_data_base64)
        const extractedLength = extractedText.length
        const scannedLike = extractedLength < 50

        // Update attachments.text_extract (no updated_at column on attachments)
        const updateStmt = db.prepare(`
          UPDATE attachments
          SET text_extract = ?
          WHERE attachment_id = ?
        `)
        updateStmt.run(extractedText, attachmentId)

        results.push({
          attachmentId,
          ok: true,
          extracted_length: extractedLength,
          skipped: false,
          scanned_like: scannedLike,
        })

        if (scannedLike) {
          scannedCount++
        } else {
          successCount++
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error(`[PDF_TEXT] error extracting from attachment ${attachmentId}:`, errorMessage)
        results.push({
          attachmentId,
          ok: false,
          extracted_length: 0,
          skipped: false,
          scanned_like: false,
          error: errorMessage,
        })
        errorCount++
      }
    }

    console.log(`[PDF_TEXT] done ${successCount} success, ${scannedCount} scanned, ${errorCount} errors`)

    return NextResponse.json({ results })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to extract text from PDFs'
    console.error('[PDF_TEXT] fatal error:', errorMessage)
    // Defensive guard: do not throw/abort; return an error payload with whatever results we have.
    return NextResponse.json({ results, fatal_error: errorMessage })
  }
}
