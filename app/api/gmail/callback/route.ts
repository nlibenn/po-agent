import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/callback
 * Handle OAuth callback from Google, exchange code for tokens, and store them
 */
export async function GET(request: NextRequest) {
  try {
    console.log('[GMAIL_CALLBACK] Starting OAuth callback')
    console.log('[GMAIL_CALLBACK] URL:', request.url)
    
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const error = searchParams.get('error')
    
    console.log('[GMAIL_CALLBACK] Code exists:', !!code)
    console.log('[GMAIL_CALLBACK] Error param:', error)
    
    if (error) {
      console.error('[GMAIL_CALLBACK] OAuth error from Google:', error)
      // Redirect to login with error parameter
      return NextResponse.redirect(new URL('/login?error=1', request.url))
    }

    if (!code) {
      console.error('[GMAIL_CALLBACK] No authorization code received')
      // Redirect to login with error parameter
      return NextResponse.redirect(new URL('/login?error=1', request.url))
    }

    // Before token exchange
    console.log('[GMAIL_CALLBACK] Exchanging code for tokens...')
    console.log('[GMAIL_CALLBACK] Client ID exists:', !!process.env.GOOGLE_CLIENT_ID)
    console.log('[GMAIL_CALLBACK] Client Secret exists:', !!process.env.GOOGLE_CLIENT_SECRET)
    console.log('[GMAIL_CALLBACK] Redirect URI:', process.env.GOOGLE_REDIRECT_URI)

    // Exchange code for tokens
    await exchangeCodeForTokens(code)

    console.log('[GMAIL_CALLBACK] Gmail callback succeeded')

    // Redirect to /home after successful authentication
    return NextResponse.redirect(new URL('/home', request.url))
  } catch (error) {
    console.error('[GMAIL_CALLBACK] Full error:', error)
    console.error('[GMAIL_CALLBACK] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
    // Redirect to login with error parameter
    return NextResponse.redirect(new URL('/login?error=1', request.url))
  }
}
