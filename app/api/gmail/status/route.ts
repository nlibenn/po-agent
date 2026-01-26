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
    const tokens = getTokens()

    if (!tokens || !tokens.access_token) {
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
      console.error('Error verifying Gmail OAuth token:', error)
      // Token might be invalid, return connected: false
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
