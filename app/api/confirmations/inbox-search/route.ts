import { NextRequest, NextResponse } from 'next/server'
import { searchInboxForConfirmation } from '@/src/lib/supplier-agent/inboxSearch'
import { getCase, updateCase } from '@/src/lib/supplier-agent/store'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/inbox-search
 * Search Gmail inbox for supplier confirmation related to a PO case
 * 
 * Accepts caseId, loads case from SQLite, and runs inbox search
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required field
    if (!body.caseId) {
      return NextResponse.json(
        { error: 'Missing required field: caseId' },
        { status: 400 }
      )
    }
    
    // Load case from SQLite
    const caseData = getCase(body.caseId)
    if (!caseData) {
      return NextResponse.json(
        { error: `Case ${body.caseId} not found` },
        { status: 404 }
      )
    }
    
    // Search inbox using case data
    const result = await searchInboxForConfirmation({
      caseId: caseData.case_id,
      poNumber: caseData.po_number,
      lineId: caseData.line_id,
      supplierEmail: caseData.supplier_email || null,
      supplierDomain: caseData.supplier_domain || null,
      optionalKeywords: body.optionalKeywords || [],
      lookbackDays: body.lookbackDays || 90,
    })
    
    // Persist threadId if found
    if (result.matchedThreadId) {
      const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
      if (meta.thread_id !== result.matchedThreadId && !caseData.thread_id) {
        // Persist in meta if thread_id column doesn't exist
        meta.thread_id = result.matchedThreadId
        updateCase(caseData.case_id, { meta })
        console.log('[THREAD_PERSIST] inbox-search', { caseId: caseData.case_id, threadId: result.matchedThreadId })
      }
    }
    
    return NextResponse.json(result)
  } catch (error) {
    console.error('Error in inbox search API:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to search inbox' },
      { status: 500 }
    )
  }
}
