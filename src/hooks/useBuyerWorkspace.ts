/**
 * Buyer Workspace Hook
 * 
 * Manages workspace data (PO rows) with localStorage persistence.
 */

import { useState, useEffect, useCallback } from 'react'
import { parseFile, ParseResult } from '@/src/lib/parseUpload'
import { NormalizedPORow } from '@/src/lib/po'
import { formatRelativeTime } from '@/src/lib/utils/relativeTime'

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

  // Load from storage on mount
  useEffect(() => {
    const loadData = async () => {
      await loadFromStorage()
    }
    loadData()
  }, [])

  const loadFromStorage = useCallback(async () => {
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

      // Save to localStorage
      saveToLocalStorage({
        rows: result.rows,
        filename: file.name,
        updatedAt: now,
      })
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
