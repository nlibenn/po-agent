import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * POST /api/debug/reset
 * Demo/dev-only: Reset workspace by clearing all stored state
 * 
 * Clears:
 * - SQLite tables: attachments, confirmation_records, cases, messages, events
 * - Note: Client must clear localStorage separately
 * 
 * Safety: Only available in demo/dev mode
 */
export async function POST(request: NextRequest) {
  try {
    // Safety gate: Only allow in demo/dev mode
    if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE !== 'true') {
      return NextResponse.json(
        { error: 'Reset workspace is only available in demo/dev mode' },
        { status: 403 }
      )
    }
    
    const db = getDb()
    
    // Clear tables in dependency order (children first due to foreign keys)
    // Using DELETE FROM instead of DROP TABLE to preserve schema
    db.exec(`
      DELETE FROM attachments;
      DELETE FROM confirmation_records;
      DELETE FROM events;
      DELETE FROM messages;
      DELETE FROM cases;
    `)
    
    console.log('[RESET] completed')
    
    return NextResponse.json({ ok: true, message: 'Workspace reset complete' })
  } catch (error) {
    console.error('[RESET] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reset workspace' },
      { status: 500 }
    )
  }
}
