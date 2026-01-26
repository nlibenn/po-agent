import { NextRequest, NextResponse } from 'next/server'
import { getAuthUrl } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/auth
 * Initiate Gmail OAuth flow by redirecting to Google consent screen
 */
export async function GET(request: NextRequest) {
  // Mock mode for demo
  if (process.env.MOCK_GMAIL === 'true') {
    return NextResponse.json({
      success: true,
      message: 'Demo mode - Gmail connected'
    })
  }

  try {
    const authUrl = getAuthUrl()
    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('Error initiating Gmail OAuth:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to initiate OAuth flow' },
      { status: 500 }
    )
  }
}
