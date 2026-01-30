/**
 * Gmail OAuth Token Storage (Vercel KV)
 * 
 * This module stores Gmail OAuth tokens in Vercel KV (Redis).
 * Tokens are stored under the key: gmail:tokens:default
 * 
 * For local development when KV is not configured, uses file-based storage.
 * All functions are async since KV operations are asynchronous.
 */

import { kv } from '@vercel/kv'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const TOKEN_KEY = 'gmail:tokens:default'
const LOCAL_STORAGE_DIR = join(process.cwd(), '.local-storage')
const LOCAL_TOKEN_FILE = join(LOCAL_STORAGE_DIR, 'gmail-tokens.json')

// Check if we're in a production environment (Vercel)
const isProduction = () => {
  return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'
}

// File-based storage helpers for local development
const loadTokensFromFile = (): GmailTokens | null => {
  try {
    const data = readFileSync(LOCAL_TOKEN_FILE, 'utf-8')
    return JSON.parse(data)
  } catch (error) {
    return null
  }
}

const saveTokensToFile = (tokens: GmailTokens): void => {
  try {
    mkdirSync(LOCAL_STORAGE_DIR, { recursive: true })
    writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf-8')
  } catch (error) {
    console.error('[GMAIL_TOKEN_STORE] Error saving tokens to file:', error)
    throw error
  }
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
  // Skip KV access during build if environment variables are missing
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
    return
  }
  const hasKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  
  if (!hasKv) {
    // In production (Vercel), KV must be configured
    if (isProduction()) {
      throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN environment variables are required for Gmail token storage in production')
    }
    // In local development, use file-based storage as fallback
    const now = Date.now()
    const existing = loadTokensFromFile()
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
    
    saveTokensToFile(tokenData)
    return
  }
  
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
  
  try {
    console.log('[GMAIL_TOKEN_STORE] Writing to KV, key:', TOKEN_KEY)
    console.log('[GMAIL_TOKEN_STORE] KV_REST_API_URL:', process.env.KV_REST_API_URL?.slice(0, 30) + '...')
    await kv.set(TOKEN_KEY, tokenData)
    console.log('[GMAIL_TOKEN_STORE] KV write succeeded')
    // Verify write by reading back
    const verify = await kv.get<GmailTokens>(TOKEN_KEY)
    console.log('[GMAIL_TOKEN_STORE] KV verify read-back:', verify ? 'success' : 'FAILED - token not found after write')
  } catch (error) {
    console.error('[GMAIL_TOKEN_STORE] KV write error:', error instanceof Error ? error.message : error)
    throw error
  }
}

/**
 * Get Gmail OAuth tokens
 */
export async function getTokens(): Promise<GmailTokens | null> {
  try {
    // Skip KV access during build if environment variables are missing
    if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NEXT_PHASE === 'phase-export') {
      return null
    }
    const hasKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
    
    if (!hasKv) {
      // In local development, use file-based storage as fallback
      return loadTokensFromFile()
    }
    
    console.log('[GMAIL_TOKEN_STORE] Reading from KV, key:', TOKEN_KEY)
    console.log('[GMAIL_TOKEN_STORE] KV_REST_API_URL:', process.env.KV_REST_API_URL?.slice(0, 30) + '...')
    const tokenData = await kv.get<GmailTokens>(TOKEN_KEY)
    console.log('[GMAIL_TOKEN_STORE] KV read result:', tokenData ? 'found token data' : 'null')
    return tokenData || null
  } catch (error) {
    console.error('[GMAIL_TOKEN_STORE] Error getting tokens from KV:', error instanceof Error ? error.message : error)
    // Fallback to file-based storage if KV fails in local dev
    if (!isProduction()) {
      return loadTokensFromFile()
    }
    return null
  }
}

/**
 * Clear Gmail OAuth tokens
 */
export async function clearTokens(): Promise<void> {
  const hasKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  if (hasKv) {
    await kv.del(TOKEN_KEY)
  } else {
    // Clear file-based storage
    try {
      const { unlinkSync } = require('fs')
      unlinkSync(LOCAL_TOKEN_FILE)
    } catch (error) {
      // File doesn't exist, that's fine
    }
  }
}
