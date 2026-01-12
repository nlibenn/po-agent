import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/callback
 * Handle OAuth callback from Google, exchange code for tokens, and store them
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const error = searchParams.get('error')

    if (error) {
      console.error('OAuth error:', error)
      return NextResponse.json(
        { error: `OAuth error: ${error}` },
        { status: 400 }
      )
    }

    if (!code) {
      return NextResponse.json(
        { error: 'No authorization code provided' },
        { status: 400 }
      )
    }

    // Exchange code for tokens
    await exchangeCodeForTokens(code)

    // Return success response
    return NextResponse.json({
      success: true,
      message: 'Gmail OAuth tokens saved successfully',
    })
  } catch (error) {
    console.error('Error in Gmail OAuth callback:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to complete OAuth flow' },
      { status: 500 }
    )
  }
}
