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
  const now = Date.now()
  
  // Get existing tokens to preserve refresh_token if not provided
  const existing = await getTokens()
  
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
  
  await kv.set(TOKEN_KEY, tokenData)
}

/**
 * Get Gmail OAuth tokens
 */
export async function getTokens(): Promise<GmailTokens | null> {
  try {
    const tokenData = await kv.get<GmailTokens>(TOKEN_KEY)
    return tokenData || null
  } catch (error) {
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
