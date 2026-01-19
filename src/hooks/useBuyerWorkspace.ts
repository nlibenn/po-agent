/**
 * Buyer Workspace Hook
 * 
 * Manages workspace data (PO rows) with localStorage persistence.
 */

import { useState, useEffect, useCallback } from 'react'
import { parseFile, ParseResult } from '@/src/lib/parseUpload'
import { NormalizedPORow } from '@/src/lib/po'
import { formatRelativeTime } from '@/src/lib/utils/relativeTime'
import { getLatestPODocument } from '@/src/lib/driveStorage'

const STORAGE_KEY = 'buyer_workspace_v1'

export type WorkspaceSource = 'local' | 'sample' | 'empty'

// Removed WorkspaceData interface - not needed externally

export interface UseBuyerWorkspaceReturn {
  // State
  rows: Record<string, any>[]
  normalizedRows: NormalizedPORow[]
  filename: string | null
  updatedAt: number | null
  source: WorkspaceSource
  isLoading: boolean
  error: string | null

  // Actions
  uploadReplace: (file: File) => Promise<void>
  resetToSample: () => void
  clear: () => void
  loadFromStorage: () => void
  saveToStorage: () => void
}

/**
 * Sample data for reset functionality
 */
function getSampleData(): Record<string, any>[] {
  // Return empty array for now - can be populated with actual sample data later
  return []
}

/**
 * Load workspace data from localStorage (raw data only, normalization happens in hook)
 */
function loadFromLocalStorage(): {
  rows: Record<string, any>[]
  filename: string
  updatedAt: number
} | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null

    const data = JSON.parse(stored) as {
      rows: Record<string, any>[]
      filename: string
      updatedAt: number
    }

    return data
  } catch (error) {
    console.error('Error loading workspace from localStorage:', error)
    return null
  }
}

/**
 * Save workspace data to localStorage
 */
function saveToLocalStorage(data: {
  rows: Record<string, any>[]
  filename: string
  updatedAt: number
}): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (error) {
    console.error('Error saving workspace to localStorage:', error)
    throw new Error('Failed to save workspace data. Storage may be full.')
  }
}

/**
 * Clear workspace data from localStorage
 */
function clearLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.error('Error clearing workspace from localStorage:', error)
  }
}

export function useBuyerWorkspace(): UseBuyerWorkspaceReturn {
  const [rows, setRows] = useState<Record<string, any>[]>([])
  const [normalizedRows, setNormalizedRows] = useState<NormalizedPORow[]>([])
  const [filename, setFilename] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [source, setSource] = useState<WorkspaceSource>('empty')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Define loadFromStorage BEFORE useEffect that uses it
  const loadFromStorage = useCallback(async () => {
    // PRIMARY SOURCE: Load from Drive storage (single source of truth)
    const driveDoc = getLatestPODocument()
    if (driveDoc && driveDoc.parsedRows) {
      // Always re-normalize to ensure consistency
      const { normalizeRow } = await import('@/src/lib/po')
      const normalized = driveDoc.parsedRows.map((row: Record<string, any>) => normalizeRow(row))
      setRows(driveDoc.parsedRows)
      setNormalizedRows(normalized)
      setFilename(driveDoc.name)
      setUpdatedAt(driveDoc.uploadedAt)
      setSource('local')
      setError(null)
      return
    }

    // FALLBACK: Load from legacy workspace storage (migration support only)
    // This path exists for backward compatibility but should not be written to anymore
    const data = loadFromLocalStorage()
    if (data) {
      // Always re-normalize to ensure consistency
      const { normalizeRow } = await import('@/src/lib/po')
      const normalized = data.rows.map((row: Record<string, any>) => normalizeRow(row))
      setRows(data.rows)
      setNormalizedRows(normalized)
      setFilename(data.filename)
      setUpdatedAt(data.updatedAt)
      setSource('local')
      setError(null)
    } else {
      // No stored data - set to empty
      setRows([])
      setNormalizedRows([])
      setFilename(null)
      setUpdatedAt(null)
      setSource('empty')
      setError(null)
    }
  }, [])

  // Load from storage on mount
  useEffect(() => {
    const loadData = async () => {
      await loadFromStorage()
    }
    loadData()

    // Listen for Drive storage changes (works across tabs)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'drive_documents_v1') {
        loadFromStorage()
      }
    }
    
    // Listen for custom storage event (works in same tab)
    const handleCustomStorageChange = () => {
      loadFromStorage()
    }
    
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('driveStorageChanged', handleCustomStorageChange)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('driveStorageChanged', handleCustomStorageChange)
    }
  }, [loadFromStorage])

  const saveToStorage = useCallback(() => {
    if (rows.length === 0 || !filename || !updatedAt) {
      return
    }

    try {
      saveToLocalStorage({
        rows,
        filename,
        updatedAt,
      })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save workspace')
    }
  }, [rows, filename, updatedAt])

  const uploadReplace = useCallback(async (file: File) => {
    // DEPRECATED: Uploads should go through Drive page only
    // This function is kept for backward compatibility but no longer writes to buyer_workspace_v1
    // Drive storage (drive_documents_v1) is now the single source of truth
    setIsLoading(true)
    setError(null)

    try {
      const result: ParseResult = await parseFile(file)
      
      const now = Date.now()
      setRows(result.rows)
      setNormalizedRows(result.normalizedRows)
      setFilename(file.name)
      setUpdatedAt(now)
      setSource('local')

      // NO LONGER saving to buyer_workspace_v1 - Drive storage is single source of truth
      // If this function is called, it means Drive already saved the document
      // We just update state to reflect it immediately
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to parse file'
      setError(errorMessage)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  const resetToSample = useCallback(() => {
    const sampleRows = getSampleData()
    // Dynamic import for client-side
    import('@/src/lib/po').then(({ normalizeRow }) => {
      const normalized = sampleRows.map((row: Record<string, any>) => normalizeRow(row))
      
      const now = Date.now()
      setRows(sampleRows)
      setNormalizedRows(normalized)
      setFilename('sample-data.csv')
      setUpdatedAt(now)
      setSource('sample')

      // Save to localStorage
      saveToLocalStorage({
        rows: sampleRows,
        filename: 'sample-data.csv',
        updatedAt: now,
      })
    })
    
  }, [])

  const clear = useCallback(() => {
    clearLocalStorage()
    setRows([])
    setNormalizedRows([])
    setFilename(null)
    setUpdatedAt(null)
    setSource('empty')
    setError(null)
  }, [])

  return {
    rows,
    normalizedRows,
    filename,
    updatedAt,
    source,
    isLoading,
    error,
    uploadReplace,
    resetToSample,
    clear,
    loadFromStorage,
    saveToStorage,
  }
}
