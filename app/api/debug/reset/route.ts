import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import { clearTokens } from '@/src/lib/gmail/tokenStore'

export const runtime = 'nodejs'

/**
 * POST /api/debug/reset
 * Demo/dev-only: Reset workspace by clearing all stored state
 *
 * Clears:
 * - SQLite tables: attachments, confirmation_records, cases, messages, events
 * - Gmail OAuth tokens (Vercel KV + file storage)
 * - Returns flag for client to clear localStorage/sessionStorage
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

    // Get counts before deletion (for logging and response)
    const getCounts = () => {
      try {
        const cases = db.prepare('SELECT COUNT(*) as count FROM cases').get() as { count: number }
        const attachments = db.prepare('SELECT COUNT(*) as count FROM attachments').get() as { count: number }
        const confirmations = db.prepare('SELECT COUNT(*) as count FROM confirmation_records').get() as { count: number }
        const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }
        const events = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }
        return {
          cases: cases.count,
          attachments: attachments.count,
          confirmationRecords: confirmations.count,
          messages: messages.count,
          events: events.count
        }
      } catch (error) {
        console.error('[RESET] Error getting counts:', error)
        return {
          cases: 0,
          attachments: 0,
          confirmationRecords: 0,
          messages: 0,
          events: 0
        }
      }
    }

    const beforeCounts = getCounts()

    // Clear tables in dependency order (children first due to foreign keys)
    // Using DELETE FROM instead of DROP TABLE to preserve schema
    db.exec(`
      DELETE FROM attachments;
      DELETE FROM confirmation_records;
      DELETE FROM confirmation_extractions;
      DELETE FROM events;
      DELETE FROM messages;
      DELETE FROM cases;
    `)

    // Clear Gmail OAuth tokens from Vercel KV and file storage
    try {
      await clearTokens()
      console.log('[RESET] Gmail tokens cleared')
    } catch (error) {
      console.error('[RESET] Error clearing Gmail tokens:', error)
      // Don't fail the whole reset if token clearing fails
    }

    console.log('[RESET] completed', beforeCounts)

    return NextResponse.json({
      ok: true,
      message: 'Reset complete. Refresh the page to see changes.',
      deleted: beforeCounts,
      clientMustClear: true // Signal to client to clear localStorage/sessionStorage
    })
  } catch (error) {
    console.error('[RESET] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reset workspace' },
      { status: 500 }
    )
  }
}
