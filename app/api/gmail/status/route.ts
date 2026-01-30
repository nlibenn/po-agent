import { NextRequest, NextResponse } from 'next/server'
import { getTokens } from '@/src/lib/gmail/tokenStore'
import { getGmailClient } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/status
 * Check Gmail OAuth connection status (does NOT expose tokens)
 */
export async function GET(request: NextRequest) {
  try {
    // During build, return not connected to allow static generation
    if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
      return NextResponse.json({
        connected: false,
      })
    }
    const tokens = await getTokens()
    console.log('[GMAIL_STATUS] Has KV env:', !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN))
    console.log('[GMAIL_STATUS] Tokens found:', !!tokens)
    console.log('[GMAIL_STATUS] Has access_token:', !!tokens?.access_token)

    if (!tokens || !tokens.access_token) {
      console.log('[GMAIL_STATUS] No tokens — returning connected: false')
      return NextResponse.json({
        connected: false,
      })
    }

    // Try to get Gmail profile to verify token is valid and get email address
    let email: string | undefined
    let scopes: string[] | undefined

    try {
      const gmail = await getGmailClient()
      const profile = await gmail.users.getProfile({
        userId: 'me',
      })

      email = profile.data.emailAddress || undefined
      scopes = tokens.scope ? tokens.scope.split(' ') : undefined
    } catch (error) {
      console.error('[GMAIL_STATUS] Error verifying token:', error instanceof Error ? error.message : error)
      return NextResponse.json({
        connected: false,
      })
    }

    return NextResponse.json({
      connected: true,
      email,
      scopes,
      tokenExpiry: tokens.expiry_date || undefined,
    })
  } catch (error) {
    console.error('Error checking Gmail OAuth status:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to check OAuth status' },
      { status: 500 }
    )
  }
}
