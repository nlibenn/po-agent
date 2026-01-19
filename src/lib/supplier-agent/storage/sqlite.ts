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
let columnCache: Set<string> | null = null

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

  // Check if attachments table exists (to determine if this is an existing DB)
  let attachmentsTableExists = false
  try {
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='attachments'
    `).get() as { name: string } | undefined
    attachmentsTableExists = !!tableCheck
  } catch (error: any) {
    // Table doesn't exist yet, will be created by schema.sql
  }

  // If attachments table exists, run migration FIRST to add columns before schema.sql tries to create indexes
  const addedColumns: string[] = []
  const createdIndices: string[] = []
  if (attachmentsTableExists) {
    try {
      const columnCheck = db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>
      const columnNames = columnCheck.map(col => col.name)
      
      if (!columnNames.includes('binary_data_base64')) {
        db.exec('ALTER TABLE attachments ADD COLUMN binary_data_base64 TEXT')
        addedColumns.push('binary_data_base64')
      }
      
      if (!columnNames.includes('content_sha256')) {
        db.exec('ALTER TABLE attachments ADD COLUMN content_sha256 TEXT')
        addedColumns.push('content_sha256')
      }
      
      if (!columnNames.includes('size_bytes')) {
        db.exec('ALTER TABLE attachments ADD COLUMN size_bytes INTEGER')
        addedColumns.push('size_bytes')
      }
      
      // Create unique indexes for content-based deduplication if they don't exist
      // Only create if content_sha256 column exists (either just added or already existed)
      const hasContentSha256 = columnNames.includes('content_sha256') || addedColumns.includes('content_sha256')
      if (hasContentSha256) {
        try {
          // Check if composite index already exists
          const indexCheck1 = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='index' AND name='idx_attachments_content_hash'
          `).get() as { name: string } | undefined
          
          if (!indexCheck1) {
            db.exec(`
              CREATE UNIQUE INDEX idx_attachments_content_hash 
              ON attachments(message_id, filename, mime_type, content_sha256) 
              WHERE content_sha256 IS NOT NULL AND filename IS NOT NULL AND mime_type IS NOT NULL
            `)
            createdIndices.push('idx_attachments_content_hash')
          }
          
          // Check if global content_sha256 index already exists
          const indexCheck2 = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='index' AND name='idx_attachments_content_sha256'
          `).get() as { name: string } | undefined
          
          if (!indexCheck2) {
            db.exec(`
              CREATE UNIQUE INDEX idx_attachments_content_sha256 
              ON attachments(content_sha256) 
              WHERE content_sha256 IS NOT NULL
            `)
            createdIndices.push('idx_attachments_content_sha256')
          }
        } catch (error: any) {
          // Index might already exist or creation failed
          if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
            console.warn('Warning: Could not create content hash indexes:', error.message)
          }
        }
      }
      
      // Reset column cache after migration so hasColumn() will see new columns
      columnCache = null
    } catch (error: any) {
      // Ignore migration errors (column might already exist)
      if (!error.message.includes('duplicate column') && !error.message.includes('no such table')) {
        console.warn('Warning: Could not migrate attachments table:', error.message)
      }
      // Reset cache even on error
      columnCache = null
    }
  }

  // Create all tables if they don't exist
  // The schema.sql file contains all table definitions:
  // - Supplier-agent tables (cases, events, messages, attachments)
  // - Gmail OAuth table (gmail_tokens)
  // For existing DBs, this will skip table creation but may create indexes (which is fine now that columns exist)
  const schemaPath = join(process.cwd(), 'src', 'lib', 'supplier-agent', 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  
  // Execute schema as a single multi-statement SQL string
  // This ensures all CREATE TABLE statements are executed, including those
  // preceded by SQL comments (e.g., "-- Events table")
  // For existing DBs, this will skip table creation (IF NOT EXISTS) but create indexes
  try {
    db.exec(schema)
  } catch (error: any) {
    // Ignore "table already exists" errors (can happen on subsequent calls)
    // Also ignore index creation errors if index already exists (for new DBs that already have it)
    if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
      // If it's an index error about missing column, that's unexpected since we migrated first
      if (error.message.includes('no such column') && attachmentsTableExists) {
        console.warn('Warning: Schema execution failed after migration:', error.message)
      } else {
        throw error
      }
    }
  }

  // Log migration results once per boot
  if (addedColumns.length > 0 || createdIndices.length > 0) {
    const logParts: string[] = []
    if (addedColumns.length > 0) {
      logParts.push(`added: ${JSON.stringify(addedColumns)}`)
    }
    if (createdIndices.length > 0) {
      logParts.push(`created: ${JSON.stringify(createdIndices)}`)
    }
    console.log(`[DB_MIGRATION] ensured attachments columns { ${logParts.join(', ')} }`)
  }
  
  isInitialized = true
  return db
}

/**
 * Check if a column exists in the attachments table.
 * Uses a cache to avoid repeated PRAGMA queries.
 */
export function hasColumn(tableName: string, columnName: string): boolean {
  if (!db) {
    return false
  }
  
  // Initialize cache if needed
  if (columnCache === null) {
    try {
      const columnCheck = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
      columnCache = new Set(columnCheck.map(col => col.name))
    } catch (error: any) {
      // Table might not exist yet
      columnCache = new Set()
    }
  }
  
  return columnCache.has(columnName)
}

/**
 * Reset the column cache (useful after migrations)
 */
export function resetColumnCache(): void {
  columnCache = null
}

/**
 * Get the current database connection (initializes if needed).
 * 
 * This function is the entry point for all database access.
 * It guarantees that all tables are created and migrations are run before any database operation.
 * 
 * Usage:
 * - All supplier-agent store operations should call getDb() first
 * - All gmail token operations should call getDb() first
 * - This ensures schema consistency across all modules
 * - Migrations run automatically on first access
 */
export function getDb(): Database.Database {
  if (!db || !isInitialized) {
    return initDb()
  }
  // Ensure migrations have run (they run during initDb, but double-check column cache is valid)
  if (columnCache === null && db) {
    // Cache will be populated on first hasColumn() call
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
