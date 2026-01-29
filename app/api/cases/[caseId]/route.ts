import { NextRequest, NextResponse } from 'next/server'
import { getCase } from '@/src/lib/supplier-agent/store'

export const runtime = 'nodejs'

/**
 * GET /api/cases/[caseId]
 * Get case details including state and draft artifacts
 * 
 * Returns:
 * {
 *   case_id: string
 *   po_number: string
 *   line_id: string
 *   supplier_name: string | null
 *   state: string
 *   next_check_at: number | null
 *   updated_at: number
 *   meta: {
 *     parsed_best_fields_v1?: {...}
 *     agent_queue?: Array<{...}>
 *   }
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const { caseId } = params
    
    if (!caseId) {
      return NextResponse.json(
        { error: 'Missing caseId parameter' },
        { status: 400 }
      )
    }
    
    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json(
        { error: `Case ${caseId} not found` },
        { status: 404 }
      )
    }
    
    // Extract relevant fields
    const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>

    // Debug log: Check if ordered_quantity exists in meta
    console.log('[CASE_READ] ordered_quantity:', meta?.po_line?.ordered_quantity, 'caseId:', caseId)

    return NextResponse.json({
      case_id: caseData.case_id,
      po_number: caseData.po_number,
      line_id: caseData.line_id,
      supplier_name: caseData.supplier_name,
      state: caseData.state,
      status: caseData.status,
      missing_fields: caseData.missing_fields || [],
      next_check_at: (caseData as any).next_check_at ?? null,
      updated_at: caseData.updated_at,
      meta: {
        parsed_best_fields_v1: meta.parsed_best_fields_v1 ?? null,
        agent_queue: meta.agent_queue ?? null,
        po_line: meta.po_line ?? null, // ✅ FIX: Include po_line with ordered_quantity
      },
    })
  } catch (error) {
    console.error('Error fetching case:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch case' },
      { status: 500 }
    )
  }
}
