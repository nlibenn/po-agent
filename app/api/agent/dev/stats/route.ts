/**
 * Dev-only Stats Endpoint - Returns case counts and database info
 * 
 * This endpoint provides diagnostic information about the supplier chase cases:
 * - Database path
 * - Total case count
 * - Counts by state
 * - Sample cases (5 most recently updated)
 * 
 * Auth: Requires X-CRON-SECRET header AND NODE_ENV !== 'production'
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDb, getDbPath } from '@/src/lib/supplier-agent/storage/sqlite'
import { CaseState } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

/**
 * GET /api/agent/dev/stats
 * Returns case statistics and database path
 * 
 * Auth: X-CRON-SECRET header must match process.env.CRON_SECRET
 *       AND NODE_ENV must not be 'production'
 * 
 * Returns:
 * {
 *   dbPath: string,
 *   totalCases: number,
 *   countsByState: Record<string, number>,
 *   sampleCases: Array<{ caseId, state, next_check_at, updated_at }>
 * }
 */
export async function GET(request: NextRequest) {
  try {
    // Auth check: require X-CRON-SECRET header
    const cronSecret = request.headers.get('X-CRON-SECRET')
    const expectedSecret = process.env.CRON_SECRET

    if (!expectedSecret) {
      console.error('[DEV_STATS] CRON_SECRET not configured')
      return NextResponse.json(
        { error: 'Stats endpoint not configured' },
        { status: 500 }
      )
    }

    if (cronSecret !== expectedSecret) {
      console.warn('[DEV_STATS] Invalid CRON_SECRET')
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Environment check: require NODE_ENV !== 'production'
    if (process.env.NODE_ENV === 'production') {
      console.warn('[DEV_STATS] Attempted access in production')
      return NextResponse.json(
        { error: 'This endpoint is not available in production' },
        { status: 403 }
      )
    }

    const db = getDb()
    const dbPath = getDbPath()

    // Get total case count
    const totalCasesResult = db
      .prepare('SELECT COUNT(*) as count FROM cases')
      .get() as { count: number }
    const totalCases = totalCasesResult.count

    // Get counts by state
    const countsByState: Record<string, number> = {}
    const stateCounts = db
      .prepare(`
        SELECT state, COUNT(*) as count
        FROM cases
        GROUP BY state
        ORDER BY state
      `)
      .all() as Array<{ state: string; count: number }>

    for (const row of stateCounts) {
      countsByState[row.state] = row.count
    }

    // Ensure all states are represented (even if count is 0)
    const allStates = Object.values(CaseState)
    for (const state of allStates) {
      if (!(state in countsByState)) {
        countsByState[state] = 0
      }
    }

    // Get 5 most recently updated cases
    const sampleCases = db
      .prepare(`
        SELECT case_id, state, next_check_at, updated_at
        FROM cases
        ORDER BY updated_at DESC
        LIMIT 5
      `)
      .all() as Array<{
        case_id: string
        state: string
        next_check_at: number | null
        updated_at: number | null
      }>

    const response = {
      dbPath,
      totalCases,
      countsByState,
      sampleCases: sampleCases.map((row) => ({
        caseId: row.case_id,
        state: row.state,
        next_check_at: row.next_check_at,
        updated_at: row.updated_at,
      })),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[DEV_STATS] Fatal error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get stats' },
      { status: 500 }
    )
  }
}
