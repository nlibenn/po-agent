/**
 * SQLite Storage Initialization and Connection Helpers
 * 
 * This module provides a singleton database connection that initializes all tables
 * (supplier-agent tables + gmail_tokens) on first access.
 * 
 * Initialization flow:
 * 1. First call to getDb() triggers initDb()
 * 2. initDb() opens the database connection at data/chase-agent.db
 * 3. Executes schema.sql which creates all tables:
 *    - Supplier-agent tables: cases, events, messages, attachments
 *    - Gmail OAuth table: gmail_tokens
 * 4. Subsequent calls to getDb() return the same connection instance
 * 
 * All modules (supplier-agent/store.ts and gmail/tokenStore.ts) should use
 * getDb() to access the database, which guarantees initialization.
 */

import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

const DB_PATH = join(process.cwd(), 'data', 'chase-agent.db')

let db: Database.Database | null = null
let isInitialized = false

/**
 * Initialize the database connection and create all tables if they don't exist.
 * 
 * This is the canonical initialization function that creates ALL tables:
 * - Supplier-agent tables: cases, events, messages, attachments (and indexes)
 * - Gmail OAuth table: gmail_tokens
 * 
 * This function uses a singleton pattern - only one database connection exists.
 */
export function initDb(): Database.Database {
  if (db && isInitialized) {
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

  // Create all tables if they don't exist
  // The schema.sql file contains all table definitions:
  // - Supplier-agent tables (cases, events, messages, attachments)
  // - Gmail OAuth table (gmail_tokens)
  const schemaPath = join(process.cwd(), 'src', 'lib', 'supplier-agent', 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  
  // Execute schema as a single multi-statement SQL string
  // This ensures all CREATE TABLE statements are executed, including those
  // preceded by SQL comments (e.g., "-- Events table")
  try {
    db.exec(schema)
  } catch (error: any) {
    // Ignore "table already exists" errors (can happen on subsequent calls)
    if (!error.message.includes('already exists')) {
      throw error
    }
  }

  // Migrate existing attachments table to add binary_data_base64 column if needed
  try {
    const columnCheck = db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>
    const hasBinaryDataColumn = columnCheck.some(col => col.name === 'binary_data_base64')
    
    if (!hasBinaryDataColumn) {
      db.exec('ALTER TABLE attachments ADD COLUMN binary_data_base64 TEXT')
    }
  } catch (error: any) {
    // Ignore migration errors (column might already exist or table might not exist yet)
    if (!error.message.includes('duplicate column') && !error.message.includes('no such table')) {
      console.warn('Warning: Could not migrate attachments table:', error.message)
    }
  }

  isInitialized = true
  return db
}

/**
 * Get the current database connection (initializes if needed).
 * 
 * This function is the entry point for all database access.
 * It guarantees that all tables are created before any database operation.
 * 
 * Usage:
 * - All supplier-agent store operations should call getDb() first
 * - All gmail token operations should call getDb() first
 * - This ensures schema consistency across all modules
 */
export function getDb(): Database.Database {
  if (!db || !isInitialized) {
    return initDb()
  }
  return db
}

/**
 * Close the database connection (useful for cleanup)
 * 
 * This resets the singleton state, so the next call to getDb() will
 * re-initialize the database and recreate all tables if needed.
 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
    isInitialized = false
  }
}
