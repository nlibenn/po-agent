'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import Papa from 'papaparse'
import { 
  normalizeRow, 
  NormalizedPORow, 
  computeTriageForAll, 
  computeTriage, 
  deriveExceptions,
  Exception
} from '../../src/lib/po'
import { 
  ExceptionInboxItem,
  exceptionToInboxItem,
  filterActiveExceptions,
  sortExceptionsByPriority
} from '../../src/lib/exceptionInbox'
import { ExceptionInboxRow } from '@/components/ExceptionInboxRow'
import { ExceptionSidePanel } from '@/components/ExceptionSidePanel'

export default function ExceptionsPage() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [inboxItems, setInboxItems] = useState<ExceptionInboxItem[]>([])
  const [filename, setFilename] = useState<string>('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [selectedException, setSelectedException] = useState<ExceptionInboxItem | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const storedData = sessionStorage.getItem('po_rows')
    const storedFilename = sessionStorage.getItem('po_filename') || ''

    if (!storedData) {
      setRows([])
      setFilename(storedFilename)
      return
    }

    try {
      const parsedRows = JSON.parse(storedData) as Record<string, any>[]
      
      if (!Array.isArray(parsedRows)) {
        setRows([])
        setFilename(storedFilename)
        return
      }

      setRows(parsedRows)
      setFilename(storedFilename)

      const normalizedRows = parsedRows.map(row => normalizeRow(row))
      const today = new Date()
      
      // Compute triage for all rows
      computeTriageForAll(normalizedRows, today)
      
      // Derive exceptions
      const exceptions = deriveExceptions(normalizedRows, today)
      
      // Convert exceptions to inbox items
      const items: ExceptionInboxItem[] = exceptions.map(exception => {
        const matchingRow = normalizedRows.find(row => 
          row.po_id === exception.po_id && row.line_id === exception.line_id
        )
        
        if (!matchingRow) {
          // This shouldn't happen, but handle gracefully
          const triage = computeTriage(exception.rowData, today, normalizedRows)
          return exceptionToInboxItem(exception, triage, exception.rowData)
        }
        
        const triage = computeTriage(matchingRow, today, normalizedRows)
        return exceptionToInboxItem(exception, triage, matchingRow)
      })

      // Filter and sort
      const activeItems = filterActiveExceptions(items)
      const sortedItems = sortExceptionsByPriority(activeItems)
      
      setInboxItems(sortedItems)
    } catch (e) {
      console.error('Error processing data:', e)
      setRows([])
      setFilename(storedFilename)
    }
  }, [])

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setSelectedFile(file || null)
    setUploadError(null)
  }

  const handleSelectFile = () => {
    if (!isUploading && fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleScan = () => {
    if (!selectedFile) {
      return
    }

    setIsUploading(true)
    setUploadError(null)

    Papa.parse(selectedFile, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          setUploadError(`Parse errors: ${results.errors.map(e => e.message).join(', ')}`)
          setIsUploading(false)
          return
        }

        const parsedRows = results.data as any[]
        
        if (!parsedRows || parsedRows.length === 0) {
          setUploadError('CSV file contains no data rows.')
          setIsUploading(false)
          return
        }

        try {
          const jsonData = JSON.stringify(parsedRows)
          const dataSize = new Blob([jsonData]).size
          
          if (dataSize > 4 * 1024 * 1024) {
            setUploadError('File is too large. Please use a smaller file.')
            setIsUploading(false)
            return
          }
          
          sessionStorage.setItem('po_rows', jsonData)
          sessionStorage.setItem('po_filename', selectedFile.name)
          
          // Reload the page to process new data
          window.location.reload()
        } catch (storageError: any) {
          if (storageError.name === 'QuotaExceededError' || storageError.code === 22) {
            setUploadError('File is too large to process.')
          } else {
            setUploadError('Error processing file.')
          }
          setIsUploading(false)
        }
      },
      error: (error) => {
        setUploadError('Error parsing CSV file.')
        setIsUploading(false)
      }
    })
  }

  const handleRowClick = (item: ExceptionInboxItem) => {
    setSelectedException(item)
  }

  const handleClosePanel = () => {
    setSelectedException(null)
  }

  const handleAction = (action: 'approve' | 'override' | 'hold', exceptionId: string) => {
    // TODO: Implement actual action handling
    console.log(`Action: ${action} for exception ${exceptionId}`)
    
    // For now, just close the panel after action
    // In a real implementation, this would update the exception status and refresh the list
    if (action === 'approve') {
      // Update exception status to indicate approval
      alert(`Approved next agent step for ${exceptionId}`)
    } else if (action === 'override') {
      // Show override interface
      alert(`Override agent for ${exceptionId}`)
    } else if (action === 'hold') {
      // Update exception status to hold
      alert(`Held ${exceptionId}`)
    }
    
    setSelectedException(null)
  }

  // Counts by status
  const statusCounts = useMemo(() => {
    return {
      awaiting_buyer: inboxItems.filter(item => item.current_status === 'awaiting_buyer').length,
      blocked: inboxItems.filter(item => item.current_status === 'blocked').length,
      resolved: inboxItems.filter(item => item.current_status === 'resolved').length,
      total: inboxItems.length
    }
  }, [inboxItems])

  if (rows === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-neutral-600">Loading...</div>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="h-full">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <div className="mb-10">
            <h1 className="text-2xl font-semibold text-neutral-800 mb-2">Exceptions</h1>
            <p className="text-sm text-neutral-600">Review and resolve purchase order exceptions</p>
          </div>
          <div className="bg-white/70 rounded-3xl shadow-sm px-12 py-16 text-center max-w-lg mx-auto">
            <div className="space-y-6">
              <div className="text-neutral-700 mb-8">No CSV data found. Upload a CSV file to detect purchase order exceptions.</div>
              
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                disabled={isUploading}
                className="hidden"
              />

              {!selectedFile ? (
                <button
                  type="button"
                  onClick={handleSelectFile}
                  disabled={isUploading}
                  className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 shadow-sm"
                >
                  Select CSV file
                </button>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-neutral-800">{selectedFile.name}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFile(null)
                        if (fileInputRef.current) {
                          fileInputRef.current.value = ''
                        }
                      }}
                      className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
                    >
                      Change file
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleScan}
                    disabled={isUploading}
                    className="w-full px-6 py-3 text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 shadow-sm"
                  >
                    {isUploading ? 'Scanning…' : 'Scan for exceptions'}
                  </button>
                </div>
              )}

              {uploadError && (
                <div className="mt-6 text-sm text-neutral-700 bg-neutral-100/80 rounded-xl px-4 py-3 shadow-sm">
                  {uploadError}
                </div>
              )}

              <p className="text-xs text-neutral-400 mt-8">Data processed locally in your browser</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full relative">
        <div className="max-w-7xl mx-auto px-8 py-10">
        {/* Primary interaction surface - calm surface */}
        <div className="mb-10">
          <h1 className="text-2xl font-semibold text-neutral-800 mb-2">Exception Inbox</h1>
          <p className="text-sm text-neutral-600">Review purchase order exceptions and agent actions</p>
          {filename && (
            <div className="text-xs text-neutral-500 mt-3">
              File: {filename}
            </div>
          )}
        </div>

          {/* Status Summary - elevated card surface */}
          {inboxItems.length > 0 && (
            <div className="bg-white/70 rounded-2xl shadow-sm px-8 py-6 mb-8">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="p-5 rounded-xl bg-neutral-50/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Awaiting buyer</div>
                  <div className={`text-2xl font-semibold text-right ${statusCounts.awaiting_buyer === 0 ? 'text-neutral-400' : 'text-neutral-800'}`}>
                    {statusCounts.awaiting_buyer}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-neutral-50/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Blocked</div>
                  <div className={`text-2xl font-semibold text-right ${statusCounts.blocked === 0 ? 'text-neutral-400' : 'text-neutral-800'}`}>
                    {statusCounts.blocked}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-neutral-50/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Resolved</div>
                  <div className="text-2xl font-semibold text-right text-neutral-600">
                    {statusCounts.resolved}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-neutral-100/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Total active</div>
                  <div className="text-2xl font-semibold text-right text-neutral-800">
                    {statusCounts.total}
                  </div>
                </div>
              </div>
            </div>
          )}

        {/* Exception Inbox List - calm surface, no dividers */}
        {inboxItems.length > 0 ? (
          <div className="space-y-3">
            {inboxItems.map((item) => (
              <ExceptionInboxRow
                key={item.id}
                exception={item}
                onClick={() => handleRowClick(item)}
              />
            ))}
          </div>
        ) : (
          <div className="bg-white/70 rounded-3xl shadow-sm px-12 py-20 text-center max-w-xl mx-auto">
            <div className="text-neutral-700 mb-2 font-medium">No exceptions found</div>
            <div className="text-sm text-neutral-500">All purchase order lines appear normal.</div>
          </div>
        )}
        </div>
      </div>

      {/* Side Panel - Overlay */}
      <ExceptionSidePanel
        exception={selectedException}
        onClose={handleClosePanel}
        onAction={handleAction}
      />
    </>
  )
}
