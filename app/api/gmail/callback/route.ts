import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/callback
 * Handle OAuth callback from Google, exchange code for tokens, and store them
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const googleError = searchParams.get('error')

  if (googleError) {
    console.error('[GMAIL_CALLBACK] OAuth error from Google:', googleError)
    const msg = encodeURIComponent(`Google OAuth error: ${googleError}`)
    return NextResponse.redirect(new URL(`/login?error=${msg}`, request.url))
  }

  if (!code) {
    console.error('[GMAIL_CALLBACK] No authorization code received')
    const msg = encodeURIComponent('No authorization code received from Google')
    return NextResponse.redirect(new URL(`/login?error=${msg}`, request.url))
  }

  try {
    console.log('[GMAIL_CALLBACK] Exchanging code for tokens...')
    console.log('[GMAIL_CALLBACK] Client ID exists:', !!process.env.GOOGLE_CLIENT_ID)
    console.log('[GMAIL_CALLBACK] Client Secret exists:', !!process.env.GOOGLE_CLIENT_SECRET)
    console.log('[GMAIL_CALLBACK] Redirect URI:', process.env.GOOGLE_REDIRECT_URI)

    await exchangeCodeForTokens(code)

    console.log('[GMAIL_CALLBACK] Token exchange and save succeeded')
    return NextResponse.redirect(new URL('/dashboard', request.url))
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error('[GMAIL_CALLBACK] Full error:', error)
    console.error('[GMAIL_CALLBACK] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
    const errorParam = encodeURIComponent(errMsg.slice(0, 300))
    return NextResponse.redirect(new URL(`/login?error=${errorParam}`, request.url))
  }
}
