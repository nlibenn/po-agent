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
      // Redirect to login with error parameter
      return NextResponse.redirect(new URL('/login?error=1', request.url))
    }

    if (!code) {
      // Redirect to login with error parameter
      return NextResponse.redirect(new URL('/login?error=1', request.url))
    }

    // Exchange code for tokens
    await exchangeCodeForTokens(code)

    console.log('Gmail callback succeeded')

    // Redirect to /home after successful authentication
    return NextResponse.redirect(new URL('/home', request.url))
  } catch (error) {
    console.error('Error in Gmail OAuth callback:', error)
    // Redirect to login with error parameter
    return NextResponse.redirect(new URL('/login?error=1', request.url))
  }
}
