import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { parseConfirmationFieldsV1 } from '@/src/lib/supplier-agent/parseConfirmationFields'
import { randomUUID } from 'crypto'
import { addEvent } from '@/src/lib/supplier-agent/store'
import { extractTextFromPdfBase64 } from '@/src/lib/supplier-agent/pdfTextExtraction'
import type Database from 'better-sqlite3'

export const runtime = 'nodejs'

// ============================================================================
// HELPER: expectedQty lookup from cases.meta JSON
// ============================================================================

/**
 * Safely extract a number from a nested object path (e.g., "po_line.qty")
 */
function getNestedNumber(obj: Record<string, any>, path: string): number | null {
  const parts = path.split('.')
  let current: any = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return null
    current = current[part]
  }
  if (typeof current === 'number' && current > 0 && Number.isFinite(current)) {
    return current
  }
  if (typeof current === 'string') {
    const parsed = parseFloat(current)
    if (!isNaN(parsed) && parsed > 0 && Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

/**
 * Get expected quantity for a case from cases.meta JSON.
 * 
 * Checks these paths in priority order (first numeric value wins):
 *   meta.po_line.ordered_quantity
 *   meta.po_line.ordered_qty
 *   meta.po_line.qty
 *   meta.poLine.ordered_quantity
 *   meta.poLine.ordered_qty
 *   meta.poLine.qty
 *   meta.line.ordered_quantity
 *   meta.line.ordered_qty
 *   meta.line.qty
 *   meta.expectedQty
 *   meta.ordered_qty
 *   meta.ordered_quantity
 * 
 * Returns first valid positive number found, or null.
 */
function getExpectedQtyForCase(db: Database.Database, caseId: string): number | null {
  try {
    const row = db.prepare(`SELECT meta FROM cases WHERE case_id = ?`).get(caseId) as { meta: string } | undefined
    if (!row?.meta || row.meta === '{}') {
      return null
    }
    
    const meta = JSON.parse(row.meta)
    
    // Try paths in exact priority order as specified
    const paths = [
      'po_line.ordered_quantity',
      'po_line.ordered_qty',
      'po_line.qty',
      'poLine.ordered_quantity',
      'poLine.ordered_qty',
      'poLine.qty',
      'line.ordered_quantity',
      'line.ordered_qty',
      'line.qty',
      'expectedQty',
      'ordered_qty',
      'ordered_quantity',
    ]
    
    for (const path of paths) {
      const val = getNestedNumber(meta, path)
      if (val !== null) {
        return val
      }
    }
    
    return null
  } catch {
    // Ignore parse errors
    return null
  }
}

/**
 * POST /api/confirmations/parse-fields
 * Body: { caseId: string }
 *
 * Loads best available evidence (PDF text_extract + email body) and parses MVP contract fields.
 * Persists/upserts into confirmation_extractions by case_id (idempotent).
 */
export async function POST(request: NextRequest) {
  const db = getDb()

  try {
    const body = await request.json()
    const caseId = body?.caseId as string | undefined
    const debug = body?.debug === true // Enable debug mode if explicitly set to true

    if (!caseId) {
      return NextResponse.json({ error: 'Missing required field: caseId' }, { status: 400 })
    }

    // 1) Load case (including meta for expectedQty)
    const caseRow = db
      .prepare(
        `
        SELECT case_id, po_number, line_id, meta
        FROM cases
        WHERE case_id = ?
      `
      )
      .get(caseId) as { case_id: string; po_number: string; line_id: string; meta: string } | undefined

    if (!caseRow) {
      return NextResponse.json({ error: `Case not found: ${caseId}` }, { status: 404 })
    }
    
    // Get expectedQty from: 1) request body (explicit override), 2) robust DB lookup
    let expectedQty: number | null = null
    if (typeof body?.expectedQty === 'number' && body.expectedQty > 0) {
      // Explicit override from request body
      expectedQty = body.expectedQty
    } else {
      // Use robust DB lookup that probes multiple sources
      expectedQty = getExpectedQtyForCase(db, caseId)
    }
    
    // Log expectedQty for debugging
    console.log('[PARSE_FIELDS] expectedQty lookup', { caseId, expectedQty, source: body?.expectedQty ? 'request_body' : 'db_lookup' })
    
    // WARNING: If expectedQty is null, we cannot validate qty from PDF
    if (expectedQty === null) {
      console.warn('[PARSE_FIELDS] expectedQty is null; cannot validate qty for case', caseId)
    }

    // 3) Load pdf attachments for case (via messages.case_id JOIN) - PREFERRED evidence
    // Include binary_data_base64 so we can extract text on-the-fly if text_extract is null
    const rawAttachments = db
      .prepare(
        `
        SELECT a.attachment_id, a.filename, a.text_extract, a.binary_data_base64, a.content_sha256, a.created_at,
               m.received_at, m.thread_id
        FROM attachments a
        INNER JOIN messages m ON m.message_id = a.message_id
        WHERE m.case_id = ?
          AND a.mime_type = 'application/pdf'
        ORDER BY m.received_at DESC, a.created_at DESC
      `
      )
      .all(caseId) as Array<{ 
        attachment_id: string
        filename: string | null
        text_extract: string | null
        binary_data_base64: string | null
        content_sha256: string | null
        created_at: number
        received_at: number | null
        thread_id: string | null
      }>

    // Debug logging: log attachment discovery
    console.log('[PARSE_FIELDS] Found attachments for case', {
      caseId,
      totalAttachments: rawAttachments.length,
      attachments: rawAttachments.map(a => ({
        attachment_id: a.attachment_id,
        filename: a.filename,
        has_text_extract: !!a.text_extract,
        text_extract_length: a.text_extract?.length || 0,
        has_binary_data: !!a.binary_data_base64,
        binary_data_length: a.binary_data_base64 ? a.binary_data_base64.length : 0,
        thread_id: a.thread_id,
      })),
    })

    // PDF-FIRST: Extract text from PDFs that have binary_data but no text_extract
    const attachments: Array<{ attachment_id: string; text_extract: string | null }> = []
    
    for (const att of rawAttachments) {
      let text = att.text_extract
      
      // If no text_extract but we have binary data, extract text on-the-fly
      if ((!text || text.trim().length === 0) && att.binary_data_base64) {
        try {
          console.log('[B3_PARSE] extracting text from PDF', { attachment_id: att.attachment_id, has_sha256: !!att.content_sha256 })
          text = await extractTextFromPdfBase64(att.binary_data_base64)
          
          // Persist the extracted text back to the attachment for future use
          if (text && text.trim().length > 0) {
            db.prepare(`UPDATE attachments SET text_extract = ? WHERE attachment_id = ?`)
              .run(text, att.attachment_id)
            console.log('[B3_PARSE] persisted text_extract', { attachment_id: att.attachment_id, textLength: text.length })
          }
        } catch (extractError) {
          console.error('[B3_PARSE] PDF text extraction failed', { 
            attachment_id: att.attachment_id, 
            error: extractError instanceof Error ? extractError.message : String(extractError) 
          })
          text = null
        }
      }
      
      attachments.push({ attachment_id: att.attachment_id, text_extract: text })
    }

    const attachmentIdsWithText = attachments.filter(a => a.text_extract && a.text_extract.trim().length > 0).map(a => a.attachment_id)
    
    // 2) Load email text (FALLBACK: most recent INBOUND message with body_text, only if no PDF text available)
    let msgRow: {
      message_id: string
      subject: string | null
      body_text: string | null
      received_at: number | null
      created_at: number
    } | undefined = undefined
    
    // Only use email text if no PDF text is available
    if (attachmentIdsWithText.length === 0) {
      type EmailMsgRow = { message_id: string; subject: string | null; body_text: string | null; received_at: number | null; created_at: number; };
      const row = db
        .prepare(
          `
          SELECT message_id, subject, body_text, received_at, created_at
          FROM messages
          WHERE case_id = ?
            AND direction = 'INBOUND'
          ORDER BY COALESCE(received_at, created_at) DESC
          LIMIT 1
        `
        )
        .get(caseId) as EmailMsgRow | undefined;
      msgRow = row;
    }

    const emailText = msgRow ? [msgRow.subject, msgRow.body_text].filter(Boolean).join('\n\n').trim() : ''
    const hasEmailText = emailText.length > 0

    console.log('[B3_PARSE] start', {
      caseId,
      pdfCount: attachments.length,
      pdfCountWithText: attachmentIdsWithText.length,
      attachmentIds: attachmentIdsWithText,
      hasEmailText,
      evidencePriority: attachmentIdsWithText.length > 0 ? 'PDF' : (hasEmailText ? 'EMAIL' : 'NONE'),
    })

    // 4) Parse v1 (heuristics) - wrapped in try/catch to handle parse errors gracefully
    let parsed
    try {
      parsed = parseConfirmationFieldsV1({
        poNumber: caseRow.po_number,
        lineId: caseRow.line_id,
        emailText: hasEmailText ? emailText : undefined,
        pdfTexts: attachments.map(a => ({ attachment_id: a.attachment_id, text: a.text_extract })),
        debug,
        expectedQty,
      })
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
      console.error('[B3_PARSE] fatal error', { caseId, error: msg, stack: parseErr instanceof Error ? parseErr.stack : undefined })
      return NextResponse.json({ ok: false, error: msg, parsed: null, caseId })
    }

    const evidence_attachment_id =
      parsed.supplier_order_number.attachment_id ||
      parsed.confirmed_delivery_date.attachment_id ||
      parsed.confirmed_quantity.attachment_id ||
      null

    const usedEmail =
      (parsed.supplier_order_number.source === 'email' && parsed.supplier_order_number.value !== null) ||
      (parsed.confirmed_delivery_date.source === 'email' && parsed.confirmed_delivery_date.value !== null) ||
      (parsed.supplier_confirmed_quantity.source === 'email' && parsed.supplier_confirmed_quantity.value !== null)
    const evidence_message_id = usedEmail ? msgRow?.message_id ?? null : null

    // Persist (upsert by case_id)
    const now = Date.now()
    const lineNumber = Number.isFinite(parseInt(caseRow.line_id, 10)) ? parseInt(caseRow.line_id, 10) : null
    const confidencePct = Math.round(
      Math.max(
        parsed.supplier_order_number.confidence,
        parsed.confirmed_delivery_date.confidence,
        parsed.supplier_confirmed_quantity.confidence
      ) * 100
    )

    const supplier_order_number = parsed.supplier_order_number.value
    const confirmed_delivery_date = parsed.confirmed_delivery_date.value
    // Store supplier_confirmed_quantity in confirmed_quantity column (evidence-based)
    // This maintains DB schema compatibility
    const confirmed_quantity = parsed.supplier_confirmed_quantity.value !== null ? String(parsed.supplier_confirmed_quantity.value) : null
    const raw_excerpt = parsed.raw_excerpt

    try {
      const existing = db
        .prepare(`SELECT id FROM confirmation_extractions WHERE case_id = ?`)
        .get(caseId) as { id: string } | undefined

      if (existing?.id) {
        db.prepare(
          `
          UPDATE confirmation_extractions
          SET
            po_number = ?,
            line_number = ?,
            supplier_order_number = ?,
            confirmed_delivery_date = ?,
            confirmed_quantity = ?,
            evidence_source = ?,
            evidence_attachment_id = ?,
            evidence_message_id = ?,
            confidence = ?,
            raw_excerpt = ?,
            updated_at = ?
          WHERE case_id = ?
        `
        ).run(
          caseRow.po_number,
          lineNumber,
          supplier_order_number,
          confirmed_delivery_date,
          confirmed_quantity,
          parsed.evidence_source,
          evidence_attachment_id,
          evidence_message_id,
          confidencePct,
          raw_excerpt,
          now,
          caseId
        )
      } else {
        db.prepare(
          `
          INSERT INTO confirmation_extractions (
            id,
            case_id,
            po_number,
            line_number,
            supplier_order_number,
            confirmed_delivery_date,
            confirmed_quantity,
            evidence_source,
            evidence_attachment_id,
            evidence_message_id,
            confidence,
            raw_excerpt,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          randomUUID(),
          caseId,
          caseRow.po_number,
          lineNumber,
          supplier_order_number,
          confirmed_delivery_date,
          confirmed_quantity,
          parsed.evidence_source,
          // Use supplier_confirmed_quantity attachment/message IDs
          parsed.supplier_order_number.attachment_id || parsed.confirmed_delivery_date.attachment_id || parsed.supplier_confirmed_quantity.attachment_id || null,
          parsed.supplier_order_number.message_id || parsed.confirmed_delivery_date.message_id || parsed.supplier_confirmed_quantity.message_id || null,
          confidencePct,
          raw_excerpt,
          now,
          now
        )
      }
    } catch (err) {
      // Defensive guard: don't abort the request if persistence fails; return parsed fields.
      const msg = err instanceof Error ? err.message : 'Unknown SQL error'
      console.error('[B3_PARSE] persist error', { caseId, error: msg })
      return NextResponse.json({ caseId, parsed, persist_error: msg })
    }

    // Persist parsed JSON to attachment (if PDF evidence)
    try {
      if (evidence_attachment_id) {
        db.prepare(
          `
          UPDATE attachments
          SET parsed_fields_json = ?, parse_confidence_json = ?
          WHERE attachment_id = ?
        `
        ).run(
          JSON.stringify({
            supplier_order_number: parsed.supplier_order_number,
            confirmed_delivery_date: parsed.confirmed_delivery_date,
            confirmed_quantity: parsed.confirmed_quantity, // Backward compatibility
            ordered_quantity: parsed.ordered_quantity,
            supplier_confirmed_quantity: parsed.supplier_confirmed_quantity,
            quantity_mismatch: parsed.quantity_mismatch,
            evidence_source: parsed.evidence_source,
            raw_excerpt: parsed.raw_excerpt,
            parsed_at: now,
            version: 'v1',
          }),
          JSON.stringify({
            supplier_order_number: parsed.supplier_order_number.confidence,
            confirmed_delivery_date: parsed.confirmed_delivery_date.confidence,
            confirmed_quantity: parsed.confirmed_quantity.confidence, // Backward compatibility
            ordered_quantity: parsed.ordered_quantity.confidence,
            supplier_confirmed_quantity: parsed.supplier_confirmed_quantity.confidence,
            version: 'v1',
          }),
          evidence_attachment_id
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown SQL error'
      console.error('[B3_PARSE] attachment persist error', { caseId, error: msg })
    }

    // Persist snapshot to case.meta (so modal can render without re-parsing)
    try {
      const row = db.prepare(`SELECT meta FROM cases WHERE case_id = ?`).get(caseId) as { meta: string } | undefined
      const meta = row?.meta ? (JSON.parse(row.meta) as Record<string, any>) : {}
      meta.parsed_best_fields_v1 = {
        version: 'v1',
        parsed_at: now,
        evidence_source: parsed.evidence_source,
        evidence_attachment_id,
        evidence_message_id,
        fields: {
          supplier_order_number: parsed.supplier_order_number,
          confirmed_delivery_date: parsed.confirmed_delivery_date,
          confirmed_quantity: parsed.confirmed_quantity, // Backward compatibility
          ordered_quantity: parsed.ordered_quantity,
          supplier_confirmed_quantity: parsed.supplier_confirmed_quantity,
        },
        quantity_mismatch: parsed.quantity_mismatch,
        raw_excerpt: parsed.raw_excerpt,
      }
      db.prepare(`UPDATE cases SET meta = ?, updated_at = ? WHERE case_id = ?`).run(JSON.stringify(meta), now, caseId)
      const persistedFields = meta.parsed_best_fields_v1?.fields || {}
      const persistedSupplierQty = persistedFields.supplier_confirmed_quantity
      console.log('[QTY_TRACE] api persisted supplier_confirmed_quantity', {
        shape: {
          typeof_value: typeof persistedSupplierQty?.value,
          value: persistedSupplierQty?.value,
          value_not_null: persistedSupplierQty?.value !== null,
          value_not_undefined: persistedSupplierQty?.value !== undefined,
          has_confidence: 'confidence' in (persistedSupplierQty || {}),
          has_source: 'source' in (persistedSupplierQty || {}),
          has_attachment_id: 'attachment_id' in (persistedSupplierQty || {}),
          has_evidence_snippet: 'evidence_snippet' in (persistedSupplierQty || {}),
        },
        raw_parsed: {
          typeof_value: typeof parsed.supplier_confirmed_quantity.value,
          value: parsed.supplier_confirmed_quantity.value,
          value_not_null: parsed.supplier_confirmed_quantity.value !== null,
        },
        ordered_quantity: parsed.ordered_quantity.value,
        quantity_mismatch: parsed.quantity_mismatch,
      })
      console.log('[B3_PARSE] persisted to case.meta', {
        caseId,
        hasSupplierOrder: !!parsed.supplier_order_number.value,
        hasDeliveryDate: !!parsed.confirmed_delivery_date.value,
        hasSupplierQuantity: parsed.supplier_confirmed_quantity.value !== null,
        orderedQuantity: parsed.ordered_quantity.value,
        quantityMismatch: parsed.quantity_mismatch,
        persistedKeys: Object.keys(persistedFields),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown SQL error'
      console.error('[B3_PARSE] case meta persist error', { caseId, error: msg })
    }

    // Audit event (idempotent via store.addEvent)
    try {
      addEvent(caseId, {
        case_id: caseId,
        timestamp: now,
        event_type: 'PARSE_RESULT',
        summary: 'Parsed confirmation fields (v1)',
        evidence_refs_json: {
          message_ids: evidence_message_id ? [evidence_message_id] : undefined,
          attachment_ids: evidence_attachment_id ? [evidence_attachment_id] : undefined,
        },
        meta_json: {
          version: 'v1',
          parsed,
          evidence_attachment_id,
          evidence_message_id,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[B3_PARSE] event error', { caseId, error: msg })
    }

    // Fix foundFields logic: "found" means value exists (not null, not undefined, not empty string)
    // Guard: normalize values and check for actual non-empty values
    const normalizeValue = (val: any): any => {
      if (val === null || val === undefined) return null
      if (typeof val === 'string') {
        const trimmed = val.trim()
        return trimmed === '' ? null : trimmed
      }
      if (typeof val === 'number') {
        return isNaN(val) || !isFinite(val) ? null : val
      }
      return val
    }
    
    const normalizedSupplierOrder = normalizeValue(parsed.supplier_order_number.value)
    const normalizedDeliveryDate = normalizeValue(parsed.confirmed_delivery_date.value)
    const normalizedSupplierQty = normalizeValue(parsed.supplier_confirmed_quantity.value)
    
    // Guard: do NOT mark found if normalized value is null/empty
    // If value was null, set it to null in the parsed object to prevent false positives
    if (normalizedSupplierQty === null && parsed.supplier_confirmed_quantity.value === null) {
      // Keep null value, but ensure confidence is reasonable (not 100 for null)
      if (parsed.supplier_confirmed_quantity.confidence > 0.8) {
        parsed.supplier_confirmed_quantity.confidence = 0
        parsed.supplier_confirmed_quantity.value = null
        parsed.supplier_confirmed_quantity.evidence_snippet = null
      }
    }
    
    const foundFields = {
      supplier_order_number: normalizedSupplierOrder !== null,
      confirmed_delivery_date: normalizedDeliveryDate !== null,
      confirmed_quantity: normalizedSupplierQty !== null, // Use supplier_confirmed_quantity for "found" check
    }
    
    console.log('[FIELD_VALUE_GUARD] supplier_confirmed_quantity', {
      raw_value: parsed.supplier_confirmed_quantity.value,
      normalized_value: normalizedSupplierQty,
      raw_confidence: parsed.supplier_confirmed_quantity.confidence,
      found: foundFields.confirmed_quantity,
      ordered_quantity: parsed.ordered_quantity.value,
      quantity_mismatch: parsed.quantity_mismatch,
    })
    
    console.log('[QTY_TRACE] foundFields computed', {
      supplier_qty_value: normalizedSupplierQty,
      supplier_qty_value_type: typeof normalizedSupplierQty,
      qty_found_boolean: foundFields.confirmed_quantity,
      ordered_quantity: parsed.ordered_quantity.value,
      quantity_mismatch: parsed.quantity_mismatch,
      supplier_order_value: normalizedSupplierOrder,
      delivery_date_value: normalizedDeliveryDate,
    })
    
    console.log('[B3_PARSE] done', {
      caseId,
      evidence_attachment_id,
      evidence_message_id,
      evidence_source: parsed.evidence_source,
      foundFields,
      confidence: confidencePct,
    })

    // Debug: if PDF evidence but fields are null, include first 200 chars of PDF text for inspection
    let debug_pdf_preview: string | undefined = undefined
    if (parsed.evidence_source === 'pdf' && !normalizedSupplierOrder && !normalizedDeliveryDate && !normalizedSupplierQty) {
      const firstPdfWithText = attachments.find(a => a.text_extract && a.text_extract.trim().length > 0)
      if (firstPdfWithText?.text_extract) {
        debug_pdf_preview = firstPdfWithText.text_extract.slice(0, 200).replace(/\s+/g, ' ').trim()
      }
    }

    return NextResponse.json({
      caseId,
      parsed: {
        ...parsed,
        evidence_attachment_id,
        evidence_message_id,
      },
      // Always include expectedQty for transparency
      expectedQty,
      expectedQtySource: body?.expectedQty ? 'request_body' : 'db_lookup',
      // Include debug info if PDF evidence exists but all fields null
      ...(debug_pdf_preview ? { debug_pdf_preview } : {}),
      // Include debug candidates if debug=true was passed
      ...(debug && parsed.debug_candidates ? { debug_candidates: parsed.debug_candidates } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[B3_PARSE] fatal error', { error: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

