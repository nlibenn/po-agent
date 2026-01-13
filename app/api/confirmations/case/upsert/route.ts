import { NextRequest, NextResponse } from 'next/server'
import { findCaseByPoLine, createCase } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/case/upsert
 * Find or create a case for a PO/line combination
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.poNumber || !body.lineId || !body.supplierEmail) {
      return NextResponse.json(
        { error: 'Missing required fields: poNumber, lineId, supplierEmail' },
        { status: 400 }
      )
    }
    
    const {
      poNumber,
      lineId,
      supplierName,
      supplierEmail,
      missingFields = ['delivery_date'],
    } = body
    
    // Find existing case
    let caseData = findCaseByPoLine(poNumber, lineId)
    
    if (!caseData) {
      // Create new case
      const caseId = `${Date.now()}-${Math.random().toString(36).substring(7)}`
      const now = Date.now()
      
      createCase({
        case_id: caseId,
        po_number: poNumber,
        line_id: lineId,
        supplier_name: supplierName || null,
        supplier_email: supplierEmail,
        supplier_domain: supplierEmail.includes('@') ? supplierEmail.split('@')[1] : null,
        missing_fields: missingFields,
        state: CaseState.INBOX_LOOKUP,
        status: CaseStatus.STILL_AMBIGUOUS,
        touch_count: 0,
        last_action_at: now,
        created_at: now,
        updated_at: now,
        meta: {},
      })
      
      caseData = findCaseByPoLine(poNumber, lineId)
    }
    
    if (!caseData) {
      return NextResponse.json(
        { error: 'Failed to create or retrieve case' },
        { status: 500 }
      )
    }
    
    return NextResponse.json({
      caseId: caseData.case_id,
      case: caseData,
    })
  } catch (error) {
    console.error('Error in case upsert API:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upsert case' },
      { status: 500 }
    )
  }
}
