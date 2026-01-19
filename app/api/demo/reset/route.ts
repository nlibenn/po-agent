import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * POST /api/demo/reset
 * Reset all confirmation agent data for demo workspace (demo mode only)
 * 
 * Safety: Only enabled when DEMO_MODE=true or NODE_ENV !== 'production'
 * Requires confirmText: "RESET DEMO" in request body
 */
export async function POST(request: NextRequest) {
  // Safety check: only allow in demo mode or non-production
  const isDemoMode = process.env.DEMO_MODE === 'true'
  const isDevelopment = process.env.NODE_ENV !== 'production'
  
  if (!isDemoMode && !isDevelopment) {
    return NextResponse.json(
      { error: 'Demo reset is only available in demo mode or development' },
      { status: 403 }
    )
  }

  try {
    const body = await request.json()
    const { confirmText } = body

    // Validate confirmText
    if (confirmText !== 'RESET DEMO') {
      return NextResponse.json(
        { error: 'Invalid confirmText. Must be exactly "RESET DEMO"' },
        { status: 400 }
      )
    }

    const db = getDb()

    // Get count of cases before deletion (for response)
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM cases')
    const countResult = countStmt.get() as { count: number }
    const casesCount = countResult.count

    // Delete all cases (CASCADE will automatically delete associated events, messages, and attachments)
    // This resets the entire confirmation agent state
    db.prepare('DELETE FROM cases').run()

    return NextResponse.json({
      ok: true,
      message: `Reset complete. Cleared ${casesCount} case(s) and all associated data.`,
      deletedCases: casesCount,
    })
  } catch (error) {
    console.error('Error resetting demo workspace:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reset demo workspace' },
      { status: 500 }
    )
  }
}
