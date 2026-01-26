import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

// Debug logging helper - only runs at runtime, not during build
const debugLog = (data: any) => {
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
    return // Skip during build
  }
  fetch('http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,timestamp:Date.now(),sessionId:'debug-session',runId:'run1'})}).catch(()=>{});
}

/**
 * GET /api/gmail/callback
 * Handle OAuth callback from Google, exchange code for tokens, and store them
 */
export async function GET(request: NextRequest) {
  // #region agent log
  debugLog({location:'callback/route.ts:10',message:'Callback entry',data:{url:request.url},hypothesisId:'A'});
  // #endregion
  try {
    console.log('[GMAIL_CALLBACK] Starting OAuth callback')
    console.log('[GMAIL_CALLBACK] URL:', request.url)
    
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const error = searchParams.get('error')
    
    // #region agent log
    debugLog({location:'callback/route.ts:19',message:'Params parsed',data:{hasCode:!!code,hasError:!!error,error},hypothesisId:'A'});
    // #endregion
    
    console.log('[GMAIL_CALLBACK] Code exists:', !!code)
    console.log('[GMAIL_CALLBACK] Error param:', error)
    
    if (error) {
      console.error('[GMAIL_CALLBACK] OAuth error from Google:', error)
      // #region agent log
      debugLog({location:'callback/route.ts:25',message:'Redirecting to login with error',data:{error},hypothesisId:'A'});
      // #endregion
      // Redirect to login with error parameter
      return NextResponse.redirect(new URL('/login?error=1', request.url))
    }

    if (!code) {
      console.error('[GMAIL_CALLBACK] No authorization code received')
      // #region agent log
      debugLog({location:'callback/route.ts:31',message:'No code received, redirecting to login',data:{},hypothesisId:'A'});
      // #endregion
      // Redirect to login with error parameter
      return NextResponse.redirect(new URL('/login?error=1', request.url))
    }

    // Before token exchange
    console.log('[GMAIL_CALLBACK] Exchanging code for tokens...')
    console.log('[GMAIL_CALLBACK] Client ID exists:', !!process.env.GOOGLE_CLIENT_ID)
    console.log('[GMAIL_CALLBACK] Client Secret exists:', !!process.env.GOOGLE_CLIENT_SECRET)
    console.log('[GMAIL_CALLBACK] Redirect URI:', process.env.GOOGLE_REDIRECT_URI)

    // #region agent log
    debugLog({location:'callback/route.ts:41',message:'Before token exchange',data:{hasClientId:!!process.env.GOOGLE_CLIENT_ID,hasClientSecret:!!process.env.GOOGLE_CLIENT_SECRET},hypothesisId:'A'});
    // #endregion

    // Exchange code for tokens
    await exchangeCodeForTokens(code)

    // #region agent log
    debugLog({location:'callback/route.ts:44',message:'Token exchange completed, redirecting to home',data:{},hypothesisId:'A'});
    // #endregion

    console.log('[GMAIL_CALLBACK] Gmail callback succeeded')

    // Redirect to /home with success parameter after successful authentication
    return NextResponse.redirect(new URL('/home?gmail_connected=1', request.url))
  } catch (error) {
    // #region agent log
    debugLog({location:'callback/route.ts:51',message:'Callback error caught',data:{errorMessage:error instanceof Error ? error.message : String(error),errorStack:error instanceof Error ? error.stack : undefined},hypothesisId:'A'});
    // #endregion
    console.error('[GMAIL_CALLBACK] Full error:', error)
    console.error('[GMAIL_CALLBACK] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
    // Redirect to login with error parameter
    return NextResponse.redirect(new URL('/login?error=1', request.url))
  }
}
