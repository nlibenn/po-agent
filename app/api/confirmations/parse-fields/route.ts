import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { parseConfirmationFieldsV1 } from '@/src/lib/supplier-agent/parseConfirmationFields'
import { randomUUID } from 'crypto'
import { addEvent } from '@/src/lib/supplier-agent/store'

export const runtime = 'nodejs'

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

    if (!caseId) {
      return NextResponse.json({ error: 'Missing required field: caseId' }, { status: 400 })
    }

    // 1) Load case
    const caseRow = db
      .prepare(
        `
        SELECT case_id, po_number, line_id
        FROM cases
        WHERE case_id = ?
      `
      )
      .get(caseId) as { case_id: string; po_number: string; line_id: string } | undefined

    if (!caseRow) {
      return NextResponse.json({ error: `Case not found: ${caseId}` }, { status: 404 })
    }

    // 3) Load pdf attachments for case (via messages.case_id) - PREFERRED evidence
    const attachments = db
      .prepare(
        `
        SELECT a.attachment_id, a.text_extract
        FROM attachments a
        INNER JOIN messages m ON m.message_id = a.message_id
        WHERE m.case_id = ?
          AND a.mime_type = 'application/pdf'
        ORDER BY m.received_at DESC, a.created_at DESC
      `
      )
      .all(caseId) as Array<{ attachment_id: string; text_extract: string | null }>

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
      msgRow = db
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
        .get(caseId) as typeof msgRow
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
      (parsed.confirmed_quantity.source === 'email' && parsed.confirmed_quantity.value !== null)
    const evidence_message_id = usedEmail ? msgRow?.message_id ?? null : null

    // Persist (upsert by case_id)
    const now = Date.now()
    const lineNumber = Number.isFinite(parseInt(caseRow.line_id, 10)) ? parseInt(caseRow.line_id, 10) : null
    const confidencePct = Math.round(
      Math.max(
        parsed.supplier_order_number.confidence,
        parsed.confirmed_delivery_date.confidence,
        parsed.confirmed_quantity.confidence
      ) * 100
    )

    const supplier_order_number = parsed.supplier_order_number.value
    const confirmed_delivery_date = parsed.confirmed_delivery_date.value
    const confirmed_quantity = parsed.confirmed_quantity.value !== null ? String(parsed.confirmed_quantity.value) : null
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
          evidence_attachment_id,
          evidence_message_id,
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
            confirmed_quantity: parsed.confirmed_quantity,
            evidence_source: parsed.evidence_source,
            raw_excerpt: parsed.raw_excerpt,
            parsed_at: now,
            version: 'v1',
          }),
          JSON.stringify({
            supplier_order_number: parsed.supplier_order_number.confidence,
            confirmed_delivery_date: parsed.confirmed_delivery_date.confidence,
            confirmed_quantity: parsed.confirmed_quantity.confidence,
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
          confirmed_quantity: parsed.confirmed_quantity,
        },
        raw_excerpt: parsed.raw_excerpt,
      }
      db.prepare(`UPDATE cases SET meta = ?, updated_at = ? WHERE case_id = ?`).run(JSON.stringify(meta), now, caseId)
      const persistedFields = meta.parsed_best_fields_v1?.fields || {}
      const persistedQuantity = persistedFields.confirmed_quantity
      console.log('[QTY_TRACE] api persisted confirmed_quantity', {
        shape: {
          typeof_value: typeof persistedQuantity?.value,
          value: persistedQuantity?.value,
          value_not_null: persistedQuantity?.value !== null,
          value_not_undefined: persistedQuantity?.value !== undefined,
          has_confidence: 'confidence' in (persistedQuantity || {}),
          has_source: 'source' in (persistedQuantity || {}),
          has_attachment_id: 'attachment_id' in (persistedQuantity || {}),
          has_evidence_snippet: 'evidence_snippet' in (persistedQuantity || {}),
        },
        raw_parsed: {
          typeof_value: typeof parsed.confirmed_quantity.value,
          value: parsed.confirmed_quantity.value,
          value_not_null: parsed.confirmed_quantity.value !== null,
        },
      })
      console.log('[B3_PARSE] persisted to case.meta', {
        caseId,
        hasSupplierOrder: !!parsed.supplier_order_number.value,
        hasDeliveryDate: !!parsed.confirmed_delivery_date.value,
        hasQuantity: parsed.confirmed_quantity.value !== null,
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
    const normalizedQty = normalizeValue(parsed.confirmed_quantity.value)
    
    // Guard: do NOT mark found if normalized value is null/empty
    // If value was null, set it to null in the parsed object to prevent false positives
    if (normalizedQty === null && parsed.confirmed_quantity.value === null) {
      // Keep null value, but ensure confidence is reasonable (not 100 for null)
      if (parsed.confirmed_quantity.confidence > 0.8) {
        parsed.confirmed_quantity.confidence = 0
        parsed.confirmed_quantity.value = null
        parsed.confirmed_quantity.evidence_snippet = null
      }
    }
    
    const foundFields = {
      supplier_order_number: normalizedSupplierOrder !== null,
      confirmed_delivery_date: normalizedDeliveryDate !== null,
      confirmed_quantity: normalizedQty !== null,
    }
    
    console.log('[FIELD_VALUE_GUARD] confirmed_quantity', {
      raw_value: parsed.confirmed_quantity.value,
      normalized_value: normalizedQty,
      raw_confidence: parsed.confirmed_quantity.confidence,
      found: foundFields.confirmed_quantity,
    })
    
    console.log('[QTY_TRACE] foundFields computed', {
      qty_value: normalizedQty,
      qty_value_type: typeof normalizedQty,
      qty_found_boolean: foundFields.confirmed_quantity,
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

    return NextResponse.json({
      caseId,
      parsed: {
        ...parsed,
        evidence_attachment_id,
        evidence_message_id,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[B3_PARSE] fatal error', { error: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

