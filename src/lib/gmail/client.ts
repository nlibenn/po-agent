/**
 * Gmail API Client Helpers
 * 
 * SERVER-ONLY: This module uses google-auth-library which requires Node.js APIs.
 * Do not import this in client components.
 */

import 'server-only'

import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { getTokens, saveTokens } from './tokenStore'

// Debug logging helper - only runs at runtime, not during build
const debugLog = (data: any) => {
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
    return // Skip during build
  }
  fetch('http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,timestamp:Date.now(),sessionId:'debug-session',runId:'run1'})}).catch(()=>{});
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

/**
 * Get OAuth2 client (configured but not authenticated)
 */
export function getOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Gmail OAuth credentials not configured. Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env.local')
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri)
}

/**
 * Get authenticated OAuth2 client (with tokens from storage)
 * Automatically refreshes token if expired
 */
export async function getAuthenticatedOAuth2Client(): Promise<OAuth2Client> {
  const client = getOAuth2Client()
  const tokens = await getTokens()

  if (!tokens || !tokens.access_token) {
    throw new Error('Gmail OAuth tokens not found. Please authenticate first via /api/gmail/auth')
  }

  // Set current tokens
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope || undefined,
    token_type: tokens.token_type || undefined,
    expiry_date: tokens.expiry_date || undefined,
  })

  // Check if token is expired (with 5 minute buffer)
  const now = Date.now()
  const expiryBuffer = 5 * 60 * 1000 // 5 minutes
  const isExpired = tokens.expiry_date && (tokens.expiry_date - now) < expiryBuffer

  if (isExpired && tokens.refresh_token) {
    try {
      // Refresh the token
      const { credentials } = await client.refreshAccessToken()
      
      // Save refreshed tokens (credentials.expiry_date is in ms, so no conversion needed)
      await saveTokens({
        access_token: credentials.access_token || null,
        refresh_token: credentials.refresh_token || tokens.refresh_token, // Keep existing if not provided
        scope: credentials.scope || tokens.scope || null,
        token_type: credentials.token_type || tokens.token_type || null,
        expiry_date: credentials.expiry_date || null, // Already in ms
      })

      // Update client credentials (expiry_date already in ms)
      client.setCredentials(credentials)
    } catch (error) {
      console.error('Error refreshing Gmail OAuth token:', error)
      throw new Error('Failed to refresh Gmail OAuth token. Please re-authenticate via /api/gmail/auth')
    }
  }

  return client
}

/**
 * Get authenticated Gmail client
 */
export async function getGmailClient() {
  const auth = await getAuthenticatedOAuth2Client()
  return google.gmail({ version: 'v1', auth: auth as any })
}

/**
 * Get OAuth2 authorization URL
 */
export function getAuthUrl(): string {
  const client = getOAuth2Client()
  return client.generateAuthUrl({
    access_type: 'offline', // Request refresh token
    scope: SCOPES,
    prompt: 'consent', // Force consent screen to ensure refresh token
  })
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  // #region agent log
  debugLog({location:'client.ts:108',message:'exchangeCodeForTokens entry',data:{hasCode:!!code},hypothesisId:'A'});
  // #endregion
  const client = getOAuth2Client()
  // #region agent log
  debugLog({location:'client.ts:110',message:'Before getToken',data:{},hypothesisId:'A'});
  // #endregion
  const { tokens } = await client.getToken(code)
  // #region agent log
  debugLog({location:'client.ts:112',message:'getToken succeeded',data:{hasAccessToken:!!tokens.access_token,hasRefreshToken:!!tokens.refresh_token,hasExpiry:!!tokens.expiry_date},hypothesisId:'A'});
  // #endregion

  // Save tokens to storage (tokens.expiry_date is already in ms)
  // #region agent log
  debugLog({location:'client.ts:115',message:'Before saveTokens',data:{},hypothesisId:'B'});
  // #endregion
  await saveTokens({
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    scope: tokens.scope || null,
    token_type: tokens.token_type || null,
    expiry_date: tokens.expiry_date || null, // Already in ms
  })
  // #region agent log
  debugLog({location:'client.ts:120',message:'saveTokens completed',data:{},hypothesisId:'B'});
  // #endregion
}
