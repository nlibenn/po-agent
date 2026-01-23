import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * POST /api/agent/dev/set-expected-qty
 * 
 * Dev-only endpoint to set expected quantity for a case.
 * Useful for testing parse-fields without rebuilding ingestion.
 * 
 * Body: { caseId: string, expectedQty: number, uom?: string }
 * 
 * Updates cases.meta to include meta.po_line.ordered_quantity
 */
export async function POST(request: NextRequest) {
  try {
    // Block in production
    if (process.env.NODE_ENV === 'production') {
      console.warn('[SET_EXPECTED_QTY] Attempted access in production')
      return NextResponse.json(
        { ok: false, error: 'This endpoint is not available in production' },
        { status: 404 }
      )
    }

    // Auth check
    const cronSecret = request.headers.get('X-CRON-SECRET')
    const expectedSecret = process.env.CRON_SECRET

    if (!expectedSecret) {
      console.error('[SET_EXPECTED_QTY] CRON_SECRET not configured')
      return NextResponse.json(
        { ok: false, error: 'Endpoint not configured' },
        { status: 500 }
      )
    }

    if (cronSecret !== expectedSecret) {
      console.warn('[SET_EXPECTED_QTY] Invalid CRON_SECRET')
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401 }
      )
    }

    // Parse body
    let body: { caseId?: string; expectedQty?: number; uom?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const { caseId, expectedQty, uom } = body

    if (!caseId || typeof caseId !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid caseId' },
        { status: 400 }
      )
    }

    if (typeof expectedQty !== 'number' || !Number.isFinite(expectedQty) || expectedQty <= 0) {
      return NextResponse.json(
        { ok: false, error: 'expectedQty must be a positive number' },
        { status: 400 }
      )
    }

    const db = getDb()

    // Get current case with meta
    const caseRow = db.prepare(`SELECT case_id, po_number, line_id, meta FROM cases WHERE case_id = ?`)
      .get(caseId) as { case_id: string; po_number: string; line_id: string; meta: string } | undefined

    if (!caseRow) {
      return NextResponse.json(
        { ok: false, error: `Case not found: ${caseId}` },
        { status: 404 }
      )
    }

    // Parse existing meta (merge, don't overwrite)
    let meta: Record<string, any> = {}
    try {
      meta = caseRow.meta ? JSON.parse(caseRow.meta) : {}
    } catch {
      meta = {}
    }

    // Set or update po_line with ordered_quantity
    if (!meta.po_line || typeof meta.po_line !== 'object') {
      meta.po_line = {}
    }
    
    meta.po_line.ordered_quantity = expectedQty
    meta.po_line.po_number = caseRow.po_number
    meta.po_line.line_id = caseRow.line_id
    if (uom) {
      meta.po_line.uom = uom
    }

    // Write back
    const now = Date.now()
    db.prepare(`UPDATE cases SET meta = ?, updated_at = ? WHERE case_id = ?`)
      .run(JSON.stringify(meta), now, caseId)

    console.log('[SET_EXPECTED_QTY] Updated case', { caseId, expectedQty, uom })

    return NextResponse.json({
      ok: true,
      caseId,
      expectedQty,
    })
  } catch (error) {
    console.error('[SET_EXPECTED_QTY] Fatal error:', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to set expected qty' },
      { status: 500 }
    )
  }
}
