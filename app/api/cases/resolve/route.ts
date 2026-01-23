import { NextRequest, NextResponse } from 'next/server'
import { findCaseByPoLine, createCase } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * POST /api/cases/resolve
 * Resolve PO-LINE to case_id (find existing or create new)
 * 
 * Body: { poNumber: string, lineId: string }
 * Returns: { ok: true, caseId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.poNumber || !body.lineId) {
      return NextResponse.json(
        { error: 'Missing required fields: poNumber, lineId' },
        { status: 400 }
      )
    }
    
    const { poNumber, lineId } = body
    
    // Find existing case
    let caseData = findCaseByPoLine(poNumber, lineId)
    
    if (!caseData) {
      // Create new case with minimal defaults
      const caseId = `${Date.now()}-${Math.random().toString(36).substring(7)}`
      const now = Date.now()
      
      createCase({
        case_id: caseId,
        po_number: poNumber,
        line_id: lineId,
        supplier_name: null,
        supplier_email: null,
        supplier_domain: null,
        missing_fields: ['supplier_reference', 'delivery_date', 'quantity'], // Use canonical keys
        state: CaseState.INBOX_LOOKUP,
        status: CaseStatus.STILL_AMBIGUOUS,
        touch_count: 0,
        last_action_at: now,
        created_at: now,
        updated_at: now,
        meta: {},
      })
      
      // Fetch the newly created case
      caseData = findCaseByPoLine(poNumber, lineId)
      
      // Create confirmation_record if missing (system of record)
      if (caseData) {
        try {
          const db = getDb()
          const existing = db
            .prepare('SELECT po_id FROM confirmation_records WHERE po_id = ? AND line_id = ?')
            .get(poNumber, lineId) as { po_id: string } | undefined
          
          if (!existing) {
            const now = Date.now()
            db.prepare(`
              INSERT INTO confirmation_records (
                po_id, line_id, supplier_order_number, confirmed_ship_date,
                confirmed_quantity, confirmed_uom, source_type, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              poNumber,
              lineId,
              null,
              null,
              null,
              null,
              'manual',
              now
            )
            console.log('[CASES_RESOLVE] created confirmation_record', { caseId: caseData.case_id, po_id: poNumber, line_id: lineId })
          }
        } catch (err) {
          console.warn('[CASES_RESOLVE] failed to create confirmation_record', err)
          // Don't fail the whole request if confirmation_record creation fails
        }
      }
    }
    
    if (!caseData) {
      return NextResponse.json(
        { error: 'Failed to create or retrieve case' },
        { status: 500 }
      )
    }
    
    return NextResponse.json({
      ok: true,
      caseId: caseData.case_id,
    })
  } catch (error) {
    console.error('Error resolving case:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to resolve case' },
      { status: 500 }
    )
  }
}
