/**
 * SQLite Storage Initialization and Connection Helpers
 */

import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const DB_PATH = join(process.cwd(), 'data', 'chase-agent.db')

let db: Database.Database | null = null

/**
 * Initialize the database connection and create tables if they don't exist
 */
export function initDb(): Database.Database {
  if (db) {
    return db
  }

  // Ensure data directory exists
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true })
  } catch (error: any) {
    // Directory might already exist, ignore
    if (error.code !== 'EEXIST') {
      throw error
    }
  }

  // Open database connection
  db = new Database(DB_PATH)

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Create tables if they don't exist
  const schemaPath = join(process.cwd(), 'src', 'lib', 'supplier-agent', 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  
  // Execute schema (better-sqlite3 doesn't support multi-statement exec well,
  // so we'll split by semicolon and execute each statement)
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))

  for (const statement of statements) {
    try {
      db.exec(statement)
    } catch (error: any) {
      // Ignore "table already exists" errors
      if (!error.message.includes('already exists')) {
        throw error
      }
    }
  }

  return db
}

/**
 * Get the current database connection (initializes if needed)
 */
export function getDb(): Database.Database {
  if (!db) {
    return initDb()
  }
  return db
}

/**
 * Close the database connection (useful for cleanup)
 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
