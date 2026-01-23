/**
 * Dev-only Endpoint - Force a case to be due immediately for poller testing
 * 
 * This endpoint sets a case's next_check_at to the past so it will be picked up
 * by the poller on the next run. Useful for testing the poller without waiting.
 * 
 * Auth: Requires X-CRON-SECRET header AND NODE_ENV !== 'production'
 */

import { NextRequest, NextResponse } from 'next/server'
import { updateCase, getCase } from '@/src/lib/supplier-agent/store'

export const runtime = 'nodejs'

/**
 * POST /api/agent/dev/make-due
 * Forces a case to be due immediately for poller testing
 * 
 * Auth: X-CRON-SECRET header must match process.env.CRON_SECRET
 *       AND NODE_ENV must not be 'production'
 * 
 * Body: { caseId: string }
 * 
 * Returns:
 * {
 *   ok: true,
 *   caseId: string,
 *   next_check_at: number,
 *   now: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Safety check: require NODE_ENV !== 'production'
    if (process.env.NODE_ENV === 'production') {
      console.warn('[MAKE_DUE] Attempted access in production')
      return NextResponse.json(
        { ok: false, error: 'This endpoint is not available in production' },
        { status: 404 }
      )
    }

    // Auth check: require X-CRON-SECRET header
    const cronSecret = request.headers.get('X-CRON-SECRET')
    const expectedSecret = process.env.CRON_SECRET

    if (!expectedSecret) {
      console.error('[MAKE_DUE] CRON_SECRET not configured')
      return NextResponse.json(
        { ok: false, error: 'Endpoint not configured' },
        { status: 500 }
      )
    }

    if (cronSecret !== expectedSecret) {
      console.warn('[MAKE_DUE] Invalid CRON_SECRET')
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401 }
      )
    }

    // Parse request body
    let body: { caseId?: string }
    try {
      body = await request.json()
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    // Validate caseId
    const caseId = body.caseId
    if (!caseId || typeof caseId !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid caseId in body' },
        { status: 400 }
      )
    }

    // Verify case exists
    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json(
        { ok: false, error: `Case ${caseId} not found` },
        { status: 404 }
      )
    }

    // Force case to be due immediately (set next_check_at to 1 second ago)
    const now = Date.now()
    const nextCheckAt = now - 1000

    updateCase(caseId, {
      next_check_at: nextCheckAt,
      last_action_at: now,
    })

    return NextResponse.json({
      ok: true,
      caseId,
      next_check_at: nextCheckAt,
      now,
    })
  } catch (error) {
    console.error('[MAKE_DUE] Fatal error:', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to make case due' },
      { status: 500 }
    )
  }
}
