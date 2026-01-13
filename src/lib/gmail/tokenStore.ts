/**
 * Gmail OAuth Token Storage (SQLite)
 * 
 * This module stores Gmail OAuth tokens in the shared SQLite database.
 * The gmail_tokens table is created automatically by the shared initialization
 * in src/lib/supplier-agent/storage/sqlite.ts via schema.sql.
 * 
 * All functions call getDb() which guarantees the database and all tables
 * (including gmail_tokens) are initialized before any operations.
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
 * Save Gmail OAuth tokens
 * 
 * The gmail_tokens table is guaranteed to exist because getDb() ensures
 * all tables from schema.sql are created before any database access.
 */
export function saveTokens(tokens: GmailTokensInput): void {
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
 * 
 * The gmail_tokens table is guaranteed to exist because getDb() ensures
 * all tables from schema.sql are created before any database access.
 */
export function getTokens(): GmailTokens | null {
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
 * 
 * The gmail_tokens table is guaranteed to exist because getDb() ensures
 * all tables from schema.sql are created before any database access.
 */
export function clearTokens(): void {
  const db = getDb()
  const stmt = db.prepare('DELETE FROM gmail_tokens WHERE id = ?')
  stmt.run('default')
}
