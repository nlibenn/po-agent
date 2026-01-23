/**
 * Dev-only endpoint to reset a case from ERROR back to WAITING or INBOX_LOOKUP
 * 
 * Auth: Requires X-CRON-SECRET header AND NODE_ENV !== 'production'
 * 
 * Body:
 * {
 *   caseId: string
 *   state?: "WAITING" | "INBOX_LOOKUP"  // Defaults to "WAITING"
 * }
 * 
 * Returns:
 * {
 *   ok: true,
 *   caseId: string,
 *   state: string,
 *   next_check_at: number
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getCase, updateCase } from '@/src/lib/supplier-agent/store'
import { CaseState } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    // Auth check: require X-CRON-SECRET header
    const cronSecret = request.headers.get('X-CRON-SECRET')
    const expectedSecret = process.env.CRON_SECRET
    
    if (!cronSecret || cronSecret !== expectedSecret) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401 }
      )
    }
    
    // Safety check: only allow in non-production
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { ok: false, error: 'not_available_in_production' },
        { status: 404 }
      )
    }
    
    // Parse request body
    const body = await request.json()
    const { caseId, state } = body
    
    // Validate required fields
    if (!caseId) {
      return NextResponse.json(
        { ok: false, error: 'missing_caseId' },
        { status: 400 }
      )
    }
    
    // Validate state (default to WAITING)
    const desiredState = (state === 'INBOX_LOOKUP' ? CaseState.INBOX_LOOKUP : CaseState.WAITING) as CaseState
    
    // Verify case exists
    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json(
        { ok: false, error: 'case_not_found' },
        { status: 404 }
      )
    }
    
    // Update case state and set next_check_at to make it due immediately
    const now = Date.now()
    updateCase(caseId, {
      state: desiredState,
      next_check_at: now - 1000, // Make it due immediately
    })
    
    // Re-fetch to get updated values
    const updatedCase = getCase(caseId)
    
    return NextResponse.json({
      ok: true,
      caseId,
      state: updatedCase?.state || desiredState,
      next_check_at: updatedCase?.next_check_at ?? null,
    })
  } catch (error) {
    console.error('[RESET_CASE] Error:', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'unknown_error' },
      { status: 500 }
    )
  }
}
