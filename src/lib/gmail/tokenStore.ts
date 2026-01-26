/**
 * Gmail OAuth Token Storage (Vercel KV)
 * 
 * This module stores Gmail OAuth tokens in Vercel KV (Redis).
 * Tokens are stored under the key: gmail:tokens:default
 * 
 * All functions are async since KV operations are asynchronous.
 */

import { kv } from '@vercel/kv'

const TOKEN_KEY = 'gmail:tokens:default'

// Debug logging helper - only runs at runtime, not during build
const debugLog = (data: any) => {
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
    return // Skip during build
  }
  fetch('http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,timestamp:Date.now(),sessionId:'debug-session',runId:'run1'})}).catch(()=>{});
}

export interface GmailTokens {
  id: string // 'default'
  access_token: string | null
  refresh_token: string | null
  scope: string | null
  token_type: string | null
  expiry_date: number | null // epoch ms
  created_at: number // epoch ms
  updated_at: number // epoch ms
}

export interface GmailTokensInput {
  access_token?: string | null
  refresh_token?: string | null
  scope?: string | null
  token_type?: string | null
  expiry_date?: number | null
}

/**
 * Save Gmail OAuth tokens
 * 
 * Preserves existing refresh_token if a new one is not provided.
 */
export async function saveTokens(tokens: GmailTokensInput): Promise<void> {
  // #region agent log
  debugLog({location:'tokenStore.ts:38',message:'saveTokens entry',data:{hasAccessToken:!!tokens.access_token,hasRefreshToken:!!tokens.refresh_token},hypothesisId:'B'});
  // #endregion
  // Skip KV access during build if environment variables are missing
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
    return
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    // KV not configured - throw error to indicate configuration needed
    throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN environment variables are required for Gmail token storage')
  }
  
  const now = Date.now()
  
  // Get existing tokens to preserve refresh_token if not provided
  const existing = await getTokens()
  // #region agent log
  debugLog({location:'tokenStore.ts:43',message:'Existing tokens retrieved',data:{hasExisting:!!existing},hypothesisId:'B'});
  // #endregion
  
  // Preserve refresh_token if not provided in input
  const refresh_token = tokens.refresh_token !== undefined 
    ? tokens.refresh_token 
    : (existing?.refresh_token || null)
  
  const tokenData: GmailTokens = {
    id: 'default',
    access_token: tokens.access_token ?? null,
    refresh_token,
    scope: tokens.scope ?? null,
    token_type: tokens.token_type ?? null,
    expiry_date: tokens.expiry_date ?? null,
    created_at: existing?.created_at || now,
    updated_at: now,
  }
  
  // #region agent log
  debugLog({location:'tokenStore.ts:60',message:'Before KV set',data:{hasAccessToken:!!tokenData.access_token,hasRefreshToken:!!tokenData.refresh_token},hypothesisId:'B'});
  // #endregion
  try {
    await kv.set(TOKEN_KEY, tokenData)
    // #region agent log
    debugLog({location:'tokenStore.ts:62',message:'KV set succeeded',data:{},hypothesisId:'B'});
    // #endregion
  } catch (error) {
    // #region agent log
    debugLog({location:'tokenStore.ts:65',message:'KV set failed',data:{errorMessage:error instanceof Error ? error.message : String(error),errorStack:error instanceof Error ? error.stack : undefined},hypothesisId:'B'});
    // #endregion
    throw error
  }
}

/**
 * Get Gmail OAuth tokens
 */
export async function getTokens(): Promise<GmailTokens | null> {
  // #region agent log
  debugLog({location:'tokenStore.ts:66',message:'getTokens entry',data:{},hypothesisId:'C'});
  // #endregion
  try {
    // Skip KV access during build if environment variables are missing
    if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
      return null
    }
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      // KV not configured - return null gracefully
      return null
    }
    const tokenData = await kv.get<GmailTokens>(TOKEN_KEY)
    // #region agent log
    debugLog({location:'tokenStore.ts:69',message:'KV get succeeded',data:{hasTokenData:!!tokenData,hasAccessToken:!!tokenData?.access_token},hypothesisId:'C'});
    // #endregion
    return tokenData || null
  } catch (error) {
    // #region agent log
    debugLog({location:'tokenStore.ts:73',message:'KV get failed',data:{errorMessage:error instanceof Error ? error.message : String(error)},hypothesisId:'C'});
    // #endregion
    console.error('[GMAIL_TOKEN_STORE] Error getting tokens from KV:', error)
    return null
  }
}

/**
 * Clear Gmail OAuth tokens
 */
export async function clearTokens(): Promise<void> {
  await kv.del(TOKEN_KEY)
}
