import { NextRequest, NextResponse } from 'next/server'
import { cleanupDuplicatePdfAttachments } from '@/src/lib/supplier-agent/store'

export const runtime = 'nodejs'

/**
 * POST /api/debug/cleanup-duplicates
 * Dev-only endpoint to cleanup duplicate PDF attachments
 * 
 * Returns:
 * {
 *   ok: true,
 *   groups: number,
 *   removed: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const result = cleanupDuplicatePdfAttachments()
    
    return NextResponse.json({
      ok: true,
      ...result,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to cleanup duplicates'
    console.error('[CLEANUP_DUPLICATES] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
