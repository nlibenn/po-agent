import { NextRequest, NextResponse } from 'next/server'
import { getCase, updateCase, addEvent } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

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
    supplier_order_number?: FieldPayload<string>
    confirmed_ship_or_delivery_date?: FieldPayload<string>
    confirmed_quantity?: FieldPayload<number>
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

    const beforeMissing = Array.isArray(caseData.missing_fields) ? [...caseData.missing_fields] : []

    const nextApplied: Record<string, any> = {}

    // Apply supplier_order_number
    if (!manualOverrides.supplier_order_number && fields.supplier_order_number && isNonEmptyString(fields.supplier_order_number.value)) {
      nextApplied.supplier_order_number = {
        ...fields.supplier_order_number,
        source,
        value: fields.supplier_order_number.value.trim(),
      }
    }

    // Apply confirmed_ship_or_delivery_date
    if (
      !manualOverrides.confirmed_ship_or_delivery_date &&
      fields.confirmed_ship_or_delivery_date &&
      isNonEmptyString(fields.confirmed_ship_or_delivery_date.value)
    ) {
      nextApplied.confirmed_ship_or_delivery_date = {
        ...fields.confirmed_ship_or_delivery_date,
        source,
        value: fields.confirmed_ship_or_delivery_date.value.trim(),
      }
    }

    // Apply confirmed_quantity
    if (
      !manualOverrides.confirmed_quantity &&
      fields.confirmed_quantity &&
      isFiniteNumber(fields.confirmed_quantity.value)
    ) {
      nextApplied.confirmed_quantity = {
        ...fields.confirmed_quantity,
        source,
        value: fields.confirmed_quantity.value,
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

    // Update missing_fields (only for fields we applied)
    const nextMissing = new Set(beforeMissing)
    if (mergedAppliedFields.supplier_order_number) nextMissing.delete('supplier_reference')
    if (mergedAppliedFields.confirmed_ship_or_delivery_date) nextMissing.delete('delivery_date')
    if (mergedAppliedFields.confirmed_quantity) nextMissing.delete('quantity')

    // Derive resolution status: treat supplier_order_number + ship/delivery as required (matches UI logic)
    const hasSupplierOrder = !!mergedAppliedFields.supplier_order_number
    const hasShipOrDelivery = !!mergedAppliedFields.confirmed_ship_or_delivery_date
    const isFullyConfirmed = hasSupplierOrder && hasShipOrDelivery

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

    updateCase(caseId, {
      missing_fields: Array.from(nextMissing),
      meta: nextMeta,
      last_action_at: now,
      ...(isFullyConfirmed
        ? { status: CaseStatus.CONFIRMED, state: CaseState.RESOLVED }
        : {}),
    })

    // Update canonical confirmation record (confirmation_records) for PO/line
    try {
      const db = getDb()
      const po_id = caseData.po_number
      const line_id = caseData.line_id

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

      const nextSupplierOrder = mergedAppliedFields.supplier_order_number?.value ?? existing?.supplier_order_number ?? null
      const nextShipDate = mergedAppliedFields.confirmed_ship_or_delivery_date?.value ?? existing?.confirmed_ship_date ?? null
      const nextQty = mergedAppliedFields.confirmed_quantity?.value ?? existing?.confirmed_quantity ?? null

      const source_type = source === 'pdf' ? 'sales_order_confirmation' : 'email_body'
      const source_attachment_id =
        mergedAppliedFields.confirmed_ship_or_delivery_date?.attachment_id ??
        mergedAppliedFields.supplier_order_number?.attachment_id ??
        mergedAppliedFields.confirmed_quantity?.attachment_id ??
        null

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

