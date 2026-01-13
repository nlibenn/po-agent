import { NextRequest, NextResponse } from 'next/server'
import { createCase } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/cases
 * Creates a case for inbox search validation (dev-only)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.po_number || !body.line_id) {
      return NextResponse.json(
        { error: 'Missing required fields: po_number, line_id' },
        { status: 400 }
      )
    }
    
    if (!body.supplier_email && !body.supplier_domain) {
      return NextResponse.json(
        { error: 'Must provide either supplier_email or supplier_domain' },
        { status: 400 }
      )
    }
    
    if (!body.missing_fields || !Array.isArray(body.missing_fields)) {
      return NextResponse.json(
        { error: 'missing_fields must be a JSON array of strings' },
        { status: 400 }
      )
    }
    
    // Generate case ID
    const caseId = `${Date.now()}-${Math.random().toString(36).substring(7)}`
    const now = Date.now()
    
    // Create case
    createCase({
      case_id: caseId,
      po_number: body.po_number,
      line_id: body.line_id,
      supplier_name: body.supplier_name || null,
      supplier_email: body.supplier_email || null,
      supplier_domain: body.supplier_domain || null,
      missing_fields: body.missing_fields,
      state: CaseState.INBOX_LOOKUP,
      status: CaseStatus.STILL_AMBIGUOUS,
      touch_count: 0,
      last_action_at: now,
      created_at: now,
      updated_at: now,
      meta: {},
    })
    
    return NextResponse.json({
      success: true,
      caseId,
    })
  } catch (error) {
    console.error('Error creating case:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create case' },
      { status: 500 }
    )
  }
}
