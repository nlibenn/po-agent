'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { Upload, RotateCcw, FileText } from 'lucide-react'
import { useWorkspace } from '@/components/WorkspaceProvider'
import { formatRelativeTime } from '@/src/lib/utils/relativeTime'

export default function HomePage() {
  const {
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
  } = useWorkspace()

  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploadError(null)

    // Validate file type
    const fileExtension = file.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'xlsx', 'xls'].includes(fileExtension || '')) {
      setUploadError('Please upload a .csv, .xlsx, or .xls file.')
      return
    }

    try {
      await uploadReplace(file)
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload file')
    }
  }

  const handleClear = () => {
    if (showClearConfirm) {
      clear()
      setShowClearConfirm(false)
    } else {
      setShowClearConfirm(true)
    }
  }

  const hasWorkspace = source === 'local' || source === 'sample'
  const rowCount = rows.length

  return (
    <div className="h-full">
      <div className="max-w-2xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-neutral-800 mb-2">Workspace</h1>
          <p className="text-sm text-neutral-600">Manage your purchase order data</p>
        </div>

        {/* Primary Workspace Card */}
        <div className="bg-white/70 rounded-2xl shadow-sm p-6 mb-4">
          {/* Error Message */}
          {(error || uploadError) && (
            <div className="mb-4 px-4 py-2.5 rounded-xl bg-red-50 text-sm text-red-700">
              {error || uploadError}
            </div>
          )}

          {hasWorkspace && filename && updatedAt ? (
            <>
              {/* Workspace Loaded State */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FileText className="w-4 h-4 text-neutral-600 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-neutral-800 truncate">{filename}</div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {formatRelativeTime(updatedAt)} · {rowCount} {rowCount === 1 ? 'row' : 'rows'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                  <button
                    onClick={handleUploadClick}
                    disabled={isLoading}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    {isLoading ? 'Uploading...' : 'Replace'}
                  </button>
                  <button
                    onClick={handleClear}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 transition-colors"
                  >
                    {showClearConfirm ? 'Confirm' : 'Clear'}
                  </button>
                </div>
              </div>

              {showClearConfirm && (
                <div className="pt-4 border-t border-neutral-200/50">
                  <p className="text-sm text-neutral-600 mb-3">Clear workspace and remove all data?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowClearConfirm(false)}
                      className="px-4 py-2 rounded-xl text-sm font-medium text-neutral-700 bg-white hover:bg-neutral-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        clear()
                        setShowClearConfirm(false)
                      }}
                      className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors"
                    >
                      Clear workspace
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-neutral-200/50">
                <button
                  onClick={resetToSample}
                  disabled={isLoading}
                  className="text-xs font-medium text-neutral-600 hover:text-neutral-800 transition-colors"
                >
                  Load sample data
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Empty State */}
              <div className="text-center py-4 mb-4">
                <p className="text-sm text-neutral-600 mb-4">No workspace data loaded</p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={handleUploadClick}
                    disabled={isLoading}
                    className="px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    <Upload className="w-4 h-4 inline mr-2" />
                    {isLoading ? 'Uploading...' : 'Upload'}
                  </button>
                  <button
                    onClick={resetToSample}
                    disabled={isLoading}
                    className="px-4 py-2.5 rounded-xl text-sm font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <RotateCcw className="w-4 h-4 inline mr-2" />
                    Sample
                  </button>
                </div>
                <p className="text-xs text-neutral-500 mt-3">
                  Supports .csv, .xlsx, and .xls files
                </p>
              </div>
            </>
          )}

          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Info */}
        <div className="mt-6 text-center">
          <p className="text-xs text-neutral-400">Data processed locally and persists across sessions</p>
        </div>
      </div>
    </div>
  )
}
