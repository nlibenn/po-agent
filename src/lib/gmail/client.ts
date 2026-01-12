/**
 * Gmail API Client Helpers
 */

import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { getTokens, saveTokens } from './tokenStore'

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
  const tokens = getTokens()

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
      saveTokens({
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
  return google.gmail({ version: 'v1', auth })
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
  const client = getOAuth2Client()
  const { tokens } = await client.getToken(code)

  // Save tokens to storage (tokens.expiry_date is already in ms)
  saveTokens({
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    scope: tokens.scope || null,
    token_type: tokens.token_type || null,
    expiry_date: tokens.expiry_date || null, // Already in ms
  })
}
