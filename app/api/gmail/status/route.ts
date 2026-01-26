import { NextRequest, NextResponse } from 'next/server'
import { getTokens } from '@/src/lib/gmail/tokenStore'
import { getGmailClient } from '@/src/lib/gmail/client'

export const runtime = 'nodejs'

/**
 * GET /api/gmail/status
 * Check Gmail OAuth connection status (does NOT expose tokens)
 */
export async function GET(request: NextRequest) {
  // #region agent log
  debugLog({location:'status/route.ts:11',message:'Status check entry',data:{},hypothesisId:'C'});
  // #endregion
  try {
    const tokens = await getTokens()
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'status/route.ts:14',message:'Tokens retrieved',data:{hasTokens:!!tokens,hasAccessToken:!!tokens?.access_token},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    if (!tokens || !tokens.access_token) {
      // #region agent log
      debugLog({location:'status/route.ts:17',message:'Returning connected:false',data:{},hypothesisId:'C'});
      // #endregion
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
