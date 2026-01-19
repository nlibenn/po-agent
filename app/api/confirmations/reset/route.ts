import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/reset
 * Reset confirmation agent data for a specific PO (demo mode only)
 * 
 * Safety: Only enabled when DEMO_MODE=true or NODE_ENV !== 'production'
 */
export async function POST(request: NextRequest) {
  // Safety check: only allow in demo mode or non-production
  const isDemoMode = process.env.DEMO_MODE === 'true'
  const isDevelopment = process.env.NODE_ENV !== 'production'
  
  if (!isDemoMode && !isDevelopment) {
    return NextResponse.json(
      { error: 'Reset is only available in demo mode or development' },
      { status: 403 }
    )
  }

  try {
    const body = await request.json()
    const { poNumber, lineId } = body

    // Validate poNumber (required)
    if (!poNumber) {
      return NextResponse.json(
        { error: 'Missing required field: poNumber' },
        { status: 400 }
      )
    }

    const db = getDb()

    // Find all cases matching the PO number
    // If lineId is provided, only match that specific line
    let casesToDelete: Array<{ case_id: string; po_number: string; line_id: string }>
    
    if (lineId) {
      // Reset specific PO/Line combination
      const stmt = db.prepare('SELECT case_id, po_number, line_id FROM cases WHERE po_number = ? AND line_id = ?')
      casesToDelete = stmt.all(poNumber, lineId) as Array<{ case_id: string; po_number: string; line_id: string }>
    } else {
      // Reset all lines for the PO
      const stmt = db.prepare('SELECT case_id, po_number, line_id FROM cases WHERE po_number = ?')
      casesToDelete = stmt.all(poNumber) as Array<{ case_id: string; po_number: string; line_id: string }>
    }

    if (casesToDelete.length === 0) {
      // No cases found - still return success (idempotent)
      return NextResponse.json({ ok: true, message: 'No cases found to reset' })
    }

    // Delete cases (CASCADE will automatically delete associated events, messages, and attachments)
    const deleteStmt = lineId
      ? db.prepare('DELETE FROM cases WHERE po_number = ? AND line_id = ?')
      : db.prepare('DELETE FROM cases WHERE po_number = ?')

    if (lineId) {
      deleteStmt.run(poNumber, lineId)
    } else {
      deleteStmt.run(poNumber)
    }

    return NextResponse.json({
      ok: true,
      message: `Reset ${casesToDelete.length} case(s) for PO ${poNumber}${lineId ? ` line ${lineId}` : ''}`,
      deletedCases: casesToDelete.length,
    })
  } catch (error) {
    console.error('Error resetting confirmation agent:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reset confirmation agent' },
      { status: 500 }
    )
  }
}
