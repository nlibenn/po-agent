import { NextRequest, NextResponse } from 'next/server'
import { getAuthUrl } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/auth
 * Initiate Gmail OAuth flow by redirecting to Google consent screen
 */
export async function GET(request: NextRequest) {
  try {
    console.log('[GMAIL_AUTH] Starting auth flow')
    console.log('[GMAIL_AUTH] Client ID exists:', !!process.env.GOOGLE_CLIENT_ID)
    console.log('[GMAIL_AUTH] Redirect URI:', process.env.GOOGLE_REDIRECT_URI)
    
    const authUrl = getAuthUrl()
    console.log('[GMAIL_AUTH] Generated auth URL, redirecting...')
    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('[GMAIL_AUTH] Error initiating Gmail OAuth:', error)
    console.error('[GMAIL_AUTH] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to initiate OAuth flow' },
      { status: 500 }
    )
  }
}
