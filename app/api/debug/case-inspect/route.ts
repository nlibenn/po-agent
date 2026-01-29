import { NextRequest, NextResponse } from 'next/server'
import { findCaseByPoLine } from '@/src/lib/supplier-agent/store'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * GET /api/debug/case-inspect?po=907126&line=1
 * Inspect confirmation data for a PO (dev-only). Use to verify why confirmation card shows missing.
 */
export async function GET(request: NextRequest) {
  try {
    const po = request.nextUrl.searchParams.get('po')
    const line = request.nextUrl.searchParams.get('line') ?? '1'
    if (!po) {
      return NextResponse.json({ error: 'Missing ?po=...' }, { status: 400 })
    }

    const caseData = findCaseByPoLine(po, line)
    if (!caseData) {
      return NextResponse.json({
        found: false,
        po,
        line,
        error: 'No case found for this PO/line',
      })
    }

    const db = getDb()
    const confirmation_record = db
      .prepare(
        `SELECT supplier_order_number, confirmed_ship_date, confirmed_quantity, source_type, updated_at
         FROM confirmation_records WHERE po_id = ? AND line_id = ?`
      )
      .get(po, line) as
      | {
          supplier_order_number: string | null
          confirmed_ship_date: string | null
          confirmed_quantity: number | null
          source_type: string | null
          updated_at: number | null
        }
      | undefined

    const confirmation_extraction = db
      .prepare(
        `SELECT case_id, supplier_order_number, confirmed_delivery_date, confirmed_quantity, evidence_source, created_at, updated_at
         FROM confirmation_extractions WHERE case_id = ?`
      )
      .get(caseData.case_id) as any

    const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, unknown>
    const applied = meta?.confirmation_fields_applied as
      | { fields?: Record<string, { value?: unknown }> }
      | undefined
    const appliedFieldKeys = applied?.fields ? Object.keys(applied.fields) : []
    const hasApplied = !!applied?.fields && appliedFieldKeys.length > 0

    return NextResponse.json({
      found: true,
      po,
      line,
      case_id: caseData.case_id,
      case_state: caseData.state,
      case_status: caseData.status,
      confirmation_record: confirmation_record ?? null,
      confirmation_extraction: confirmation_extraction ?? null,
      meta_parsed_best_fields_v1: !!meta?.parsed_best_fields_v1,
      meta_applied: hasApplied,
      meta_applied_field_keys: appliedFieldKeys,
    })
  } catch (e) {
    console.error('[case-inspect]', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed' },
      { status: 500 }
    )
  }
}
