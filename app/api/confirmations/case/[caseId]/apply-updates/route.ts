import { NextRequest, NextResponse } from 'next/server'
import { getCase, updateCase, addEvent } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { transitionCase, TransitionEvent } from '@/src/lib/supplier-agent/stateMachine'
import { CANONICAL_FIELD_KEYS, normalizeMissingFields } from '@/src/lib/supplier-agent/fieldMapping'

export const runtime = 'nodejs'

type ApplySource = 'pdf' | 'email'

type FieldPayload<T> = {
  value: T
  confidence?: number
  attachment_id?: string
  evidence_snippet?: string
}

type ApplyUpdatesBody = {
  source: ApplySource
  fields: {
    // Accept both old parser names and canonical keys for backward compatibility
    supplier_order_number?: FieldPayload<string>
    supplier_reference?: FieldPayload<string>
    confirmed_ship_or_delivery_date?: FieldPayload<string>
    delivery_date?: FieldPayload<string>
    confirmed_quantity?: FieldPayload<number>
    quantity?: FieldPayload<number>
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function stableStringify(value: unknown): string {
  // Stable enough for our small payload: sort object keys recursively.
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',')}}`
}

export async function POST(
  request: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const caseId = params?.caseId
    if (!caseId) {
      return NextResponse.json({ error: 'Missing caseId parameter' }, { status: 400 })
    }

    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json({ error: `Case ${caseId} not found` }, { status: 404 })
    }

    const body = (await request.json()) as ApplyUpdatesBody
    const source: ApplySource = body?.source
    const fields = body?.fields || {}

    if (source !== 'pdf' && source !== 'email') {
      return NextResponse.json({ error: 'Invalid source' }, { status: 400 })
    }

    const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
    const manualOverrides = (meta.manual_overrides && typeof meta.manual_overrides === 'object'
      ? meta.manual_overrides
      : {}) as Record<string, boolean>

    const beforeMissing = normalizeMissingFields(
      Array.isArray(caseData.missing_fields) ? caseData.missing_fields : []
    )

    const nextApplied: Record<string, any> = {}

    // Apply supplier_reference (accept supplier_order_number for backward compatibility)
    const supplierRefField = fields.supplier_reference || fields.supplier_order_number
    const supplierRefKey = CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE
    if (!manualOverrides[supplierRefKey] && supplierRefField && isNonEmptyString(supplierRefField.value)) {
      nextApplied[supplierRefKey] = {
        ...supplierRefField,
        source,
        value: supplierRefField.value.trim(),
      }
    }

    // Apply delivery_date (accept confirmed_ship_or_delivery_date for backward compatibility)
    const deliveryDateField = fields.delivery_date || fields.confirmed_ship_or_delivery_date
    const deliveryDateKey = CANONICAL_FIELD_KEYS.DELIVERY_DATE
    if (
      !manualOverrides[deliveryDateKey] &&
      deliveryDateField &&
      isNonEmptyString(deliveryDateField.value)
    ) {
      nextApplied[deliveryDateKey] = {
        ...deliveryDateField,
        source,
        value: deliveryDateField.value.trim(),
      }
    }

    // Apply quantity (accept confirmed_quantity for backward compatibility)
    const quantityField = fields.quantity || fields.confirmed_quantity
    const quantityKey = CANONICAL_FIELD_KEYS.QUANTITY
    if (
      !manualOverrides[quantityKey] &&
      quantityField &&
      isFiniteNumber(quantityField.value)
    ) {
      nextApplied[quantityKey] = {
        ...quantityField,
        source,
        value: quantityField.value,
      }
    }

    if (Object.keys(nextApplied).length === 0) {
      return NextResponse.json({ ok: true, case: caseData, skipped: true })
    }

    const existingApplied = meta.confirmation_fields_applied
    const existingAppliedFields =
      existingApplied?.fields && typeof existingApplied.fields === 'object' ? (existingApplied.fields as Record<string, any>) : {}

    const mergedAppliedFields = { ...existingAppliedFields, ...nextApplied }

    // Idempotency: if exact same resulting applied state already present, skip update + event
    const signature = stableStringify({ fields: mergedAppliedFields })
    if (existingApplied?.signature && existingApplied.signature === signature) {
      return NextResponse.json({ ok: true, case: caseData, deduped: true })
    }

    const now = Date.now()

    // Update missing_fields using canonical keys
    const nextMissing = new Set(beforeMissing)
    if (mergedAppliedFields[CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE]) {
      nextMissing.delete(CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE)
    }
    if (mergedAppliedFields[CANONICAL_FIELD_KEYS.DELIVERY_DATE]) {
      nextMissing.delete(CANONICAL_FIELD_KEYS.DELIVERY_DATE)
    }
    if (mergedAppliedFields[CANONICAL_FIELD_KEYS.QUANTITY]) {
      nextMissing.delete(CANONICAL_FIELD_KEYS.QUANTITY)
    }

    // Derive resolution status: supplier_reference + delivery_date are required
    const hasSupplierRef = !!mergedAppliedFields[CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE]
    const hasDeliveryDate = !!mergedAppliedFields[CANONICAL_FIELD_KEYS.DELIVERY_DATE]
    const isFullyConfirmed = hasSupplierRef && hasDeliveryDate
    
    console.log('[APPLY_UPDATES] canonical missing_fields', {
      caseId,
      before: Array.from(beforeMissing),
      after: Array.from(nextMissing),
      hasSupplierRef,
      hasDeliveryDate,
      isFullyConfirmed,
    })

    const nextMeta = {
      ...meta,
      manual_overrides: manualOverrides,
      confirmation_fields_applied: {
        applied_at: now,
        actor: 'ui',
        fields: mergedAppliedFields,
        signature,
      },
    }

    if (isFullyConfirmed) {
      // Transition to RESOLVED state via state machine
      transitionCase({
        caseId,
        toState: CaseState.RESOLVED,
        event: TransitionEvent.RESOLVE_OK,
        summary: 'Fields applied; fully confirmed',
        patch: {
          missing_fields: Array.from(nextMissing),
          meta: nextMeta,
          status: CaseStatus.CONFIRMED,
          last_action_at: now,
        },
      })
    } else {
      // Just update fields without state change
      updateCase(caseId, {
        missing_fields: Array.from(nextMissing),
        meta: nextMeta,
        last_action_at: now,
      })
    }

    // Update canonical confirmation record (confirmation_records) for PO/line
    try {
      const db = getDb()
      const po_id = caseData.po_number
      const line_id = caseData.line_id

      // Lookup confirmation_record by po_id + line_id
      const lookupKey = `po_id=${po_id},line_id=${line_id}`
      console.log('[APPLY_UPDATES] confirmation_record lookup', { caseId, lookupKey })
      
      const existing = db
        .prepare(
          `
          SELECT
            supplier_order_number,
            confirmed_ship_date,
            confirmed_quantity,
            confirmed_uom
          FROM confirmation_records
          WHERE po_id = ? AND line_id = ?
        `
        )
        .get(po_id, line_id) as
        | {
            supplier_order_number: string | null
            confirmed_ship_date: string | null
            confirmed_quantity: number | null
            confirmed_uom: string | null
          }
        | undefined

      console.log('[APPLY_UPDATES] confirmation_record found', { 
        caseId, 
        found: !!existing,
        lookupKey,
      })

      // Map canonical fields to confirmation_records columns
      const nextSupplierOrder = mergedAppliedFields[CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE]?.value ?? existing?.supplier_order_number ?? null
      const nextShipDate = mergedAppliedFields[CANONICAL_FIELD_KEYS.DELIVERY_DATE]?.value ?? existing?.confirmed_ship_date ?? null
      const nextQty = mergedAppliedFields[CANONICAL_FIELD_KEYS.QUANTITY]?.value ?? existing?.confirmed_quantity ?? null

      const source_type = source === 'pdf' ? 'sales_order_confirmation' : 'email_body'
      const source_attachment_id =
        mergedAppliedFields[CANONICAL_FIELD_KEYS.DELIVERY_DATE]?.attachment_id ??
        mergedAppliedFields[CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE]?.attachment_id ??
        mergedAppliedFields[CANONICAL_FIELD_KEYS.QUANTITY]?.attachment_id ??
        null
      
      // Create confirmation_record if missing
      if (!existing) {
        console.log('[APPLY_UPDATES] creating confirmation_record', { caseId, lookupKey })
      }

      db.prepare(
        `
        INSERT OR REPLACE INTO confirmation_records (
          po_id,
          line_id,
          supplier_order_number,
          confirmed_ship_date,
          confirmed_quantity,
          confirmed_uom,
          source_type,
          source_message_id,
          source_attachment_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        po_id,
        line_id,
        nextSupplierOrder,
        nextShipDate,
        nextQty,
        existing?.confirmed_uom ?? null,
        source_type,
        null,
        source_attachment_id,
        now
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[APPLY_UPDATES] confirmation_records update failed', msg)
    }

    const afterCase = getCase(caseId)

    // Audit event (reuse existing events table)
    addEvent(caseId, {
      case_id: caseId,
      timestamp: now,
      event_type: 'APPLY_UPDATES',
      summary: 'Applied confirmation updates',
      evidence_refs_json: {
        attachment_ids: Object.values(nextApplied)
          .map((v: any) => v?.attachment_id)
          .filter((v: any) => typeof v === 'string'),
      },
      meta_json: {
        source,
        before_missing_fields: beforeMissing,
        after_missing_fields: Array.from(nextMissing),
        applied: nextApplied,
        merged_applied_state: mergedAppliedFields,
      },
    })

    return NextResponse.json({ ok: true, case: afterCase })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to apply updates'
    console.error('[APPLY_UPDATES] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

