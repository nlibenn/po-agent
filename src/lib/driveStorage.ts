/**
 * Drive Storage Utilities
 * 
 * Manages Drive documents with localStorage persistence.
 * This is the single source of truth for all uploaded documents.
 */

export interface DriveDocument {
  id: string
  name: string
  type: string
  mimeType: string
  uploadedAt: number
  size: number
  fileContent?: string // Base64 encoded file content for CSV/Excel (parsed data)
  parsedRows?: Record<string, any>[] // Parsed CSV/Excel rows (for PO data)
}

const DRIVE_STORAGE_KEY = 'drive_documents_v1'

/**
 * Get all Drive documents
 */
export function getDriveDocuments(): DriveDocument[] {
  try {
    const stored = localStorage.getItem(DRIVE_STORAGE_KEY)
    if (!stored) return []
    return JSON.parse(stored) as DriveDocument[]
  } catch (error) {
    console.error('Error loading Drive documents:', error)
    return []
  }
}

/**
 * Save a Drive document
 */
export function saveDriveDocument(document: DriveDocument): void {
  try {
    const documents = getDriveDocuments()
    documents.push(document)
    localStorage.setItem(DRIVE_STORAGE_KEY, JSON.stringify(documents))
  } catch (error) {
    console.error('Error saving Drive document:', error)
    throw new Error('Failed to save document. Storage may be full.')
  }
}

/**
 * Delete a Drive document by ID
 */
export function deleteDriveDocument(id: string): void {
  try {
    const documents = getDriveDocuments()
    const filtered = documents.filter(doc => doc.id !== id)
    localStorage.setItem(DRIVE_STORAGE_KEY, JSON.stringify(filtered))
  } catch (error) {
    console.error('Error deleting Drive document:', error)
  }
}

/**
 * Get the latest CSV/Excel document (for PO data)
 */
export function getLatestPODocument(): DriveDocument | null {
  const documents = getDriveDocuments()
  const poDocuments = documents
    .filter(doc => {
      const ext = doc.name.split('.').pop()?.toLowerCase()
      return ext === 'csv' || ext === 'xlsx' || ext === 'xls'
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
  
  return poDocuments.length > 0 ? poDocuments[0] : null
}

/**
 * Get Drive summary stats
 */
export function getDriveSummary(): {
  totalDocuments: number
  lastUpload: number | null
  latestDocument: DriveDocument | null
} {
  const documents = getDriveDocuments()
  const sorted = documents.sort((a, b) => b.uploadedAt - a.uploadedAt)
  
  return {
    totalDocuments: documents.length,
    lastUpload: sorted.length > 0 ? sorted[0].uploadedAt : null,
    latestDocument: sorted.length > 0 ? sorted[0] : null,
  }
}

/**
 * Clear all Drive documents
 */
export function clearDriveDocuments(): void {
  try {
    localStorage.removeItem(DRIVE_STORAGE_KEY)
  } catch (error) {
    console.error('Error clearing Drive documents:', error)
  }
}
