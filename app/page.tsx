'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'

export default function HomePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setSelectedFile(file || null)
    setError(null)
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
    setError(null)

    Papa.parse(selectedFile, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          setError(`Parse errors: ${results.errors.map(e => e.message).join(', ')}`)
          setIsUploading(false)
          return
        }

        const parsedRows = results.data as any[]
        
        if (!parsedRows || parsedRows.length === 0) {
          setError('CSV file contains no data rows.')
          setIsUploading(false)
          return
        }

        try {
          const jsonData = JSON.stringify(parsedRows)
          const dataSize = new Blob([jsonData]).size
          
          if (dataSize > 4 * 1024 * 1024) {
            setError('File is too large. Please use a smaller file.')
            setIsUploading(false)
            return
          }
          
          sessionStorage.setItem('po_rows', jsonData)
          sessionStorage.setItem('po_filename', selectedFile.name)
          
          router.push('/queue')
          setIsUploading(false)
        } catch (storageError: any) {
          if (storageError.name === 'QuotaExceededError' || storageError.code === 22) {
            setError('File is too large to process.')
          } else {
            setError('Error processing file.')
          }
          setIsUploading(false)
        }
      },
      error: (error) => {
        setError('Error parsing CSV file.')
        setIsUploading(false)
      }
    })
  }

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-6">
      <div className="max-w-lg w-full">
        {/* Centered empty-state panel */}
        <div className="bg-white rounded-2xl shadow-sm px-12 py-16 text-center">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            disabled={isUploading}
            className="hidden"
          />

          {!selectedFile ? (
            <div className="space-y-8">
              {/* Clear instruction sentence */}
              <p className="text-lg text-neutral-700 leading-relaxed">
                Upload a CSV file to detect purchase order exceptions before release
              </p>

              {/* Primary button */}
              <button
                type="button"
                onClick={handleSelectFile}
                disabled={isUploading}
                className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2"
              >
                Select CSV file
              </button>

              {/* Subtle trust copy */}
              <p className="text-xs text-neutral-400 mt-8">
                Data processed locally in your browser
              </p>
            </div>
          ) : (
            <div className="space-y-6 animate-in fade-in duration-200">
              {/* File selected state */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-neutral-900">
                  {selectedFile.name}
                </p>
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

              {/* Scan button - revealed after file selection */}
              <button
                type="button"
                onClick={handleScan}
                disabled={isUploading}
                className="w-full px-6 py-3 text-sm font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2"
              >
                {isUploading ? 'Scanning…' : 'Scan for exceptions'}
              </button>

              {/* Subtle trust copy */}
              <p className="text-xs text-neutral-400">
                Data processed locally in your browser
              </p>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="mt-6 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
