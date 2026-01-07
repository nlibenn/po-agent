'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'

export default function HomePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    console.log('File selected:', file?.name, file)
    setSelectedFile(file || null)
    setError(null)
  }

  const handleUploadAndAnalyze = (e?: React.MouseEvent<HTMLButtonElement>) => {
    e?.preventDefault()
    e?.stopPropagation()
    console.log('Button clicked, selectedFile:', selectedFile)
    
    if (!selectedFile) {
      console.log('No file selected')
      setError('Please select a file first')
      return
    }

    console.log('Starting upload...', selectedFile.name)
    setIsUploading(true)
    setError(null)

    Papa.parse(selectedFile, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        console.log('Parse complete, rows:', results.data?.length)
        if (results.errors.length > 0) {
          setError(`Parse errors: ${results.errors.map(e => e.message).join(', ')}`)
          setIsUploading(false)
          return
        }

        const parsedRows = results.data as any[]
        
        if (!parsedRows || parsedRows.length === 0) {
          setError('CSV file contains no data rows. Please check your file and try again.')
          setIsUploading(false)
          return
        }

        try {
          const jsonData = JSON.stringify(parsedRows)
          const dataSize = new Blob([jsonData]).size
          const sizeInMB = (dataSize / (1024 * 1024)).toFixed(2)
          
          console.log(`Data size: ${sizeInMB} MB, Rows: ${parsedRows.length}`)
          
          if (dataSize > 4 * 1024 * 1024) {
            setError(`File is too large (${sizeInMB} MB, ${parsedRows.length} rows). Please use a smaller file or split your data. SessionStorage limit is approximately 5-10MB.`)
            setIsUploading(false)
            return
          }
          
          sessionStorage.setItem('po_rows', jsonData)
          sessionStorage.setItem('po_filename', selectedFile.name)
          
          console.log('Saved to sessionStorage, navigating...')
          
          router.push('/queue')
          setIsUploading(false)
        } catch (storageError: any) {
          console.error('Storage error:', storageError)
          if (storageError.name === 'QuotaExceededError' || storageError.code === 22) {
            setError(`File is too large to store in browser storage (${parsedRows.length} rows). Please use a smaller file or split your data into smaller chunks.`)
          } else {
            setError(`Error saving data: ${storageError.message || 'Unknown storage error'}`)
          }
          setIsUploading(false)
        }
      },
      error: (error) => {
        console.error('Parse error:', error)
        setError(`Error parsing CSV: ${error.message || 'Unknown error occurred'}`)
        setIsUploading(false)
      }
    })
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-2xl w-full">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">CSV Upload</h1>
          <p className="text-sm text-gray-600 mb-6">
            Upload a CSV file to process exceptions
          </p>

          <div className="space-y-4">
            <div>
              <label
                htmlFor="csv-upload"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Select CSV File
              </label>
              <input
                id="csv-upload"
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                disabled={isUploading}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              {selectedFile && (
                <div className="mt-2 text-sm text-gray-600">
                  Selected: {selectedFile.name}
                </div>
              )}
              <div className="mt-1 text-xs text-gray-400">
                File state: {selectedFile ? '✓ Set' : '✗ Not set'} | Button disabled: {(!selectedFile || isUploading) ? 'Yes' : 'No'}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={handleUploadAndAnalyze}
                disabled={!selectedFile || isUploading}
                className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded border border-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
                style={{ pointerEvents: (!selectedFile || isUploading) ? 'none' : 'auto' }}
              >
                {isUploading ? 'Parsing…' : 'Upload & Analyze'}
              </button>
              <p className="mt-2 text-xs text-gray-500 text-center">
                Your data stays in your browser (v0).
              </p>
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
