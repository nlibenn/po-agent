/**
 * Gmail OAuth Token Storage (SQLite)
 */

import { getDb } from '../supplier-agent/storage/sqlite'

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
 * Ensure gmail_tokens table exists (called on first use)
 */
function ensureTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_tokens (
      id TEXT PRIMARY KEY DEFAULT 'default',
      access_token TEXT,
      refresh_token TEXT,
      scope TEXT,
      token_type TEXT,
      expiry_date INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

/**
 * Save Gmail OAuth tokens
 */
export function saveTokens(tokens: GmailTokensInput): void {
  ensureTable()
  const db = getDb()
  const now = Date.now()
  
  // Check if record exists
  const existing = db.prepare('SELECT id FROM gmail_tokens WHERE id = ?').get('default') as { id: string } | undefined
  
  if (existing) {
    // Update existing
    const stmt = db.prepare(`
      UPDATE gmail_tokens 
      SET access_token = ?,
          refresh_token = ?,
          scope = ?,
          token_type = ?,
          expiry_date = ?,
          updated_at = ?
      WHERE id = 'default'
    `)
    stmt.run(
      tokens.access_token || null,
      tokens.refresh_token || null,
      tokens.scope || null,
      tokens.token_type || null,
      tokens.expiry_date || null,
      now
    )
  } else {
    // Insert new
    const stmt = db.prepare(`
      INSERT INTO gmail_tokens (
        id, access_token, refresh_token, scope, token_type, expiry_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      'default',
      tokens.access_token || null,
      tokens.refresh_token || null,
      tokens.scope || null,
      tokens.token_type || null,
      tokens.expiry_date || null,
      now,
      now
    )
  }
}

/**
 * Get Gmail OAuth tokens
 */
export function getTokens(): GmailTokens | null {
  ensureTable()
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM gmail_tokens WHERE id = ?')
  const row = stmt.get('default') as any
  
  if (!row) {
    return null
  }
  
  return {
    id: row.id,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    scope: row.scope,
    token_type: row.token_type,
    expiry_date: row.expiry_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Clear Gmail OAuth tokens
 */
export function clearTokens(): void {
  ensureTable()
  const db = getDb()
  const stmt = db.prepare('DELETE FROM gmail_tokens WHERE id = ?')
  stmt.run('default')
}
