'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, FileText, MoreVertical } from 'lucide-react'
import { formatRelativeTime } from '@/src/lib/utils/relativeTime'
import { parseFile, ParseResult } from '@/src/lib/parseUpload'
import {
  getDriveDocuments,
  saveDriveDocument,
  deleteDriveDocument,
  clearDriveDocuments,
  type DriveDocument,
} from '@/src/lib/driveStorage'
import { useWorkspace } from '@/components/WorkspaceProvider'

export default function DrivePage() {
  const [files, setFiles] = useState<DriveDocument[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [fileToRemove, setFileToRemove] = useState<DriveDocument | null>(null)
  const [showToast, setShowToast] = useState(false)
  const [toastMessage, setToastMessage] = useState('')
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { loadFromStorage } = useWorkspace()

  // Load files from storage on mount
  const loadFiles = useCallback(() => {
    const documents = getDriveDocuments()
    setFiles(documents)
  }, [])

  useEffect(() => {
    loadFiles()
    
    // Listen for storage changes (if user uploads from another tab)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'drive_documents_v1') {
        loadFiles()
      }
    }
    
    // Listen for custom storage event (same-tab updates)
    const handleCustomStorageChange = () => {
      loadFiles()
    }
    
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('driveStorageChanged', handleCustomStorageChange)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('driveStorageChanged', handleCustomStorageChange)
    }
  }, [loadFiles])

  // Close menu when clicking outside
  useEffect(() => {
    if (!openMenuId) return
    
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null)
      }
    }
    
    // Use setTimeout to ensure menu is rendered before adding listener
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 0)
    
    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [openMenuId])

  const getFileType = (filename: string): string => {
    const extension = filename.split('.').pop()?.toLowerCase() || ''
    const typeMap: Record<string, string> = {
      pdf: 'PDF',
      csv: 'CSV',
      xlsx: 'Excel',
      xls: 'Excel',
      doc: 'Word',
      docx: 'Word',
      txt: 'Text',
      json: 'JSON',
    }
    return typeMap[extension] || extension.toUpperCase() || 'File'
  }

  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return

    setIsUploading(true)
    setUploadError(null)

    try {
      const fileArray = Array.from(fileList)
      
      // Log file selection
      console.log(`[DRIVE_UPLOAD] ${fileArray.length} file(s) selected`)
      fileArray.forEach(file => {
        console.log(`[DRIVE_UPLOAD] selected {name: "${file.name}", size: ${file.size}}`)
      })
      
      const newDocuments: DriveDocument[] = []

      for (const file of fileArray) {
        const documentId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        const fileExtension = file.name.split('.').pop()?.toLowerCase() || ''
        const isPOFile = ['csv', 'xlsx', 'xls'].includes(fileExtension)

        // Read file content as base64 for storage
        const fileContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              // Remove data URL prefix
              const base64 = reader.result.split(',')[1]
              resolve(base64)
            } else {
              reject(new Error('Failed to read file'))
            }
          }
          reader.onerror = () => reject(new Error('Failed to read file'))
          reader.readAsDataURL(file)
        })

        const document: DriveDocument = {
          id: documentId,
          name: file.name,
          type: getFileType(file.name),
          mimeType: file.type,
          uploadedAt: Date.now(),
          size: file.size,
          fileContent,
        }

        // If it's a CSV/Excel file, parse it and store the rows
        if (isPOFile) {
          try {
            console.log(`[INGEST] parse start for "${file.name}"`)
            const parseResult: ParseResult = await parseFile(file)
            const rowCount = parseResult.rows ? parseResult.rows.length : 0
            console.log(`[INGEST] parse end {rowCount: ${rowCount}}`)
            document.parsedRows = parseResult.rows
            
            // Log persistence
            console.log(`[DRIVE_UPLOAD] persisting "${file.name}" to localStorage (drive_documents_v1)`)
            saveDriveDocument(document)
            console.log(`[INGEST] persisted {insertedCount: ${rowCount}, documentId: "${documentId}"}`)
          } catch (parseError) {
            console.error('[INGEST] parse error:', parseError)
            // Still save the document, but without parsed rows
            console.log(`[DRIVE_UPLOAD] persisting "${file.name}" to localStorage (without parsed rows)`)
            saveDriveDocument(document)
            console.log(`[DRIVE_UPLOAD] persisted {insertedCount: 0, documentId: "${documentId}"}`)
          }
        } else {
          // Non-PO file - just save it
          console.log(`[DRIVE_UPLOAD] persisting "${file.name}" to localStorage (non-PO file)`)
          saveDriveDocument(document)
          console.log(`[DRIVE_UPLOAD] persisted {insertedCount: 0, documentId: "${documentId}"}`)
        }
        
        newDocuments.push(document)
      }

      // Update UI
      const allDocuments = getDriveDocuments()
      setFiles(allDocuments)
      
      // Trigger WorkspaceProvider refresh if PO file was uploaded
      const hasPOFile = fileArray.some(file => {
        const ext = file.name.split('.').pop()?.toLowerCase()
        return ['csv', 'xlsx', 'xls'].includes(ext || '')
      })
      if (hasPOFile) {
        console.log('[DRIVE_UPLOAD] triggering WorkspaceProvider refresh')
        // Dispatch custom event for same-tab refresh
        window.dispatchEvent(new Event('driveStorageChanged'))
        // Also trigger manual refresh to ensure immediate update
        loadFromStorage()
        console.log('[DRIVE_UPLOAD] WorkspaceProvider refresh triggered')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to upload files'
      setUploadError(errorMessage)
      console.error('[DRIVE_UPLOAD] error:', err)
    } finally {
      setIsUploading(false)
      console.log('[DRIVE_UPLOAD] upload complete')
    }
  }, [loadFromStorage])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      console.log('[DRIVE_UPLOAD] file input onChange triggered')
      handleFiles(e.target.files)
      // Reset file input to allow selecting the same file again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [handleFiles]
  )

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleRemoveFile = (file: DriveDocument) => {
    setFileToRemove(file)
    setOpenMenuId(null)
  }

  const confirmRemoveFile = useCallback(() => {
    if (!fileToRemove) return

    // Delete file from storage
    deleteDriveDocument(fileToRemove.id)

    // Refresh file list
    loadFiles()

    // Trigger WorkspaceProvider refresh if it was a PO file
    const ext = fileToRemove.name.split('.').pop()?.toLowerCase()
    const isPOFile = ['csv', 'xlsx', 'xls'].includes(ext || '')
    if (isPOFile) {
      // Dispatch custom event for same-tab refresh
      window.dispatchEvent(new Event('driveStorageChanged'))
      // Also trigger manual refresh to ensure immediate update
      loadFromStorage()
    }

    // Show toast
    setToastMessage('File removed')
    setShowToast(true)
    setTimeout(() => setShowToast(false), 3000)

    // Close dialog
    setFileToRemove(null)
  }, [fileToRemove, loadFiles, loadFromStorage])

  const handleResetWorkspace = async () => {
    setResetting(true)
    
    try {
      // Clear localStorage
      clearDriveDocuments()
      
      // Clear SQLite tables via API
      const response = await fetch('/api/debug/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to reset workspace')
      }
      
      // Refresh file list
      loadFiles()
      
      // Trigger WorkspaceProvider refresh
      window.dispatchEvent(new Event('driveStorageChanged'))
      if (loadFromStorage) {
        loadFromStorage()
      }
      
      // Close confirmation
      setResetConfirmOpen(false)
      
      // Show toast
      setToastMessage('Workspace reset complete')
      setShowToast(true)
      setTimeout(() => setShowToast(false), 3000)
    } catch (error) {
      console.error('Error resetting workspace:', error)
      alert(error instanceof Error ? error.message : 'Failed to reset workspace')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="h-full">
      <div className="max-w-4xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-800 mb-2">Drive</h1>
            <p className="text-sm text-neutral-600">Drop documents here for the agent to use across runs.</p>
          </div>
          {/* Demo/Dev Reset Button */}
          <button
            onClick={() => setResetConfirmOpen(true)}
            className="px-4 py-2 rounded-xl text-sm font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 transition-colors border border-neutral-200"
            title="Demo/Dev only: Reset workspace"
          >
            Reset Demo Workspace
          </button>
        </div>

        {/* Error Message */}
        {uploadError && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-red-50 border border-red-100">
            <p className="text-sm text-red-700">{uploadError}</p>
          </div>
        )}

        {/* Drag and Drop Area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleUploadClick}
          className={`
            bg-white/70 rounded-2xl shadow-sm border-2 border-dashed transition-all cursor-pointer
            ${isDragging ? 'border-neutral-400 bg-neutral-50/50' : 'border-neutral-200 hover:border-neutral-300 hover:bg-white/80'}
          `}
        >
          <div className="px-8 py-16 text-center">
            <Upload className="w-10 h-10 mx-auto mb-4 text-neutral-400" />
            <p className="text-sm font-medium text-neutral-700 mb-1">
              {isDragging ? 'Drop files here' : 'Drop files here or click to upload'}
            </p>
            <p className="text-xs text-neutral-500 mt-1">Multiple files supported</p>
            {isUploading && (
              <p className="text-xs text-neutral-500 mt-2">Uploading...</p>
            )}
          </div>
        </div>

        {/* Hidden File Input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Files List */}
        {files.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-neutral-700">Uploaded files</h2>
              <span className="text-xs text-neutral-500 bg-neutral-100 px-3 py-1 rounded-full">
                Available to the agent
              </span>
            </div>
            <div className="bg-white/70 rounded-2xl shadow-sm overflow-hidden">
              <div className="divide-y divide-neutral-200/50">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="px-6 py-4 hover:bg-neutral-50/30 transition-colors relative"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <FileText className="w-4 h-4 text-neutral-500 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-neutral-800 truncate">
                            {file.name}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-neutral-500">{file.type}</span>
                            <span className="text-xs text-neutral-400">·</span>
                            <span className="text-xs text-neutral-500">
                              {formatRelativeTime(file.uploadedAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="ml-4 flex items-center gap-3 flex-shrink-0">
                        <span className="px-3 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700">
                          Ready
                        </span>
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setOpenMenuId(openMenuId === file.id ? null : file.id)
                            }}
                            className="p-1.5 rounded-lg hover:bg-neutral-100 transition-colors text-neutral-500 hover:text-neutral-700"
                            aria-label="More options"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                          {openMenuId === file.id && (
                            <div
                              ref={menuRef}
                              onClick={(e) => e.stopPropagation()}
                              className="absolute right-0 top-full mt-1 bg-white border border-neutral-200 rounded-lg shadow-lg z-10 min-w-[140px]"
                            >
                              <button
                                onClick={() => handleRemoveFile(file)}
                                className="w-full text-left px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 first:rounded-t-lg last:rounded-b-lg transition-colors"
                              >
                                Remove file
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Empty State (when files exist but shown separately for clarity) */}
        {files.length === 0 && (
          <div className="mt-8 text-center">
            <p className="text-xs text-neutral-400">No files uploaded yet</p>
          </div>
        )}
      </div>

      {/* Remove File Confirmation Dialog */}
      {fileToRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Overlay */}
          <div
            className="fixed inset-0 bg-black/10 backdrop-blur-[2px]"
            onClick={() => setFileToRemove(null)}
          />
          {/* Dialog Content */}
          <div className="relative bg-white rounded-2xl shadow-lg p-6 max-w-sm w-full border border-neutral-200/50">
            <h3 className="text-lg font-semibold text-neutral-800 mb-3">Remove file?</h3>
            <p className="text-sm text-neutral-600 mb-6 leading-relaxed">
              This will remove it from your workspace.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setFileToRemove(null)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmRemoveFile}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-900 transition-colors shadow-sm"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {showToast && (
        <div className="fixed bottom-4 right-4 z-50 bg-neutral-800 text-white px-4 py-3 rounded-xl shadow-lg animate-in slide-in-from-bottom-2">
          <p className="text-sm font-medium">{toastMessage}</p>
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {resetConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Overlay */}
          <div
            className="fixed inset-0 bg-black/10 backdrop-blur-[2px]"
            onClick={() => {
              if (!resetting) {
                setResetConfirmOpen(false)
              }
            }}
          />
          {/* Modal Content */}
          <div className="relative bg-white rounded-2xl shadow-lg p-6 max-w-md w-full border border-neutral-200/50">
            <h3 className="text-lg font-semibold text-neutral-800 mb-3">
              Reset Demo Workspace?
            </h3>
            <p className="text-sm text-neutral-600 mb-6 leading-relaxed">
              This will delete uploaded documents and all confirmation/attachment data. Continue?
            </p>
            
            <div className="flex gap-3">
              <button
                onClick={handleResetWorkspace}
                disabled={resetting}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {resetting ? 'Resetting...' : 'Reset'}
              </button>
              <button
                onClick={() => setResetConfirmOpen(false)}
                disabled={resetting}
                className="px-4 py-2.5 rounded-xl text-sm font-medium text-neutral-700 bg-white hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-neutral-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
