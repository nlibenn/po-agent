'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { normalizeRow, deriveExceptions, Exception, generateDraftMessage } from '../../../src/lib/po'

export default function ExceptionPage({
  params,
}: {
  params: { id: string }
}) {
  const { id } = params
  const [copiedState, setCopiedState] = useState<boolean>(false)
  const [exception, setException] = useState<Exception | null>(null)
  const [normalizedRow, setNormalizedRow] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorType, setErrorType] = useState<'no_data' | 'no_match' | null>(null)

  useEffect(() => {
    // Load po_rows from sessionStorage
    const storedData = sessionStorage.getItem('po_rows')
    
    if (!storedData) {
      setError('No CSV data found. Please upload a CSV file first.')
      setErrorType('no_data')
      setLoading(false)
      return
    }

    try {
      const rawRows = JSON.parse(storedData) as Record<string, any>[]
      
      if (!Array.isArray(rawRows) || rawRows.length === 0) {
        setError('No data rows found. Please upload a CSV file first.')
        setErrorType('no_data')
        setLoading(false)
        return
      }
      
      // Normalize all rows
      const normalizedRows = rawRows.map(row => normalizeRow(row))
      
      // Derive exceptions
      const today = new Date()
      const exceptions = deriveExceptions(normalizedRows, today)
      
      // Find matching exception by id
      const matchingException = exceptions.find(ex => ex.id === id)
      
      if (!matchingException) {
        setError(`No matching exception found for ${id}`)
        setErrorType('no_match')
        setLoading(false)
        return
      }
      
      // Find matching normalized row
      const matchingRow = normalizedRows.find(row => 
        `${row.po_id}-${row.line_id}` === id
      )
      
      if (!matchingRow) {
        setError(`No matching row found for ${id}`)
        setErrorType('no_match')
        setLoading(false)
        return
      }
      
      setException(matchingException)
      setNormalizedRow(matchingRow)
      setLoading(false)
    } catch (e) {
      setError(`Error loading data: ${e instanceof Error ? e.message : 'Unknown error'}`)
      setErrorType('no_data')
      setLoading(false)
    }
  }, [id])

  const handleCopy = async () => {
    if (!exception) return
    
    const draft = generateDraftMessage(exception)
    const fullText = `Subject: ${draft.subject}\n\n${draft.body}`
    
    await navigator.clipboard.writeText(fullText)
    setCopiedState(true)
    setTimeout(() => setCopiedState(false), 2000)
  }

  const getRecommendedAction = (exceptionType: string | null): string => {
    switch (exceptionType) {
      case 'LATE_PO':
        return 'Confirm ship date + expedite if needed'
      case 'PARTIAL_OPEN':
        return 'Confirm remaining qty / close line if complete'
      case 'ZOMBIE_PO':
        return 'Close line or revalidate demand'
      case 'UOM_AMBIGUITY':
        return 'Pause before release and confirm unit basis (per piece vs per foot)'
      default:
        return 'Review and follow up'
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading exception data...</div>
      </div>
    )
  }

  if (error || !exception || !normalizedRow) {
    const backLink = errorType === 'no_data' ? '/' : '/queue'
    const backText = errorType === 'no_data' ? '← Return to upload page' : '← Return to queue'
    
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 shadow-sm p-6 text-center">
          <div className="text-red-600 mb-4">{error || 'Exception not found'}</div>
          <Link 
            href={backLink} 
            className="text-blue-600 hover:text-blue-800 underline text-sm"
          >
            {backText}
          </Link>
        </div>
      </div>
    )
  }

  const draft = generateDraftMessage(exception)
  const badgeColor = 
    exception.exception_type === 'LATE_PO' ? 'bg-red-100 text-red-800' :
    exception.exception_type === 'PARTIAL_OPEN' ? 'bg-yellow-100 text-yellow-800' :
    exception.exception_type === 'UOM_AMBIGUITY' ? 'bg-blue-100 text-blue-800' :
    'bg-gray-100 text-gray-800'

  const badgeText = 
    exception.exception_type === 'LATE_PO' ? 'Late PO' :
    exception.exception_type === 'PARTIAL_OPEN' ? 'Partial Open' :
    exception.exception_type === 'UOM_AMBIGUITY' ? 'UoM Ambiguity' :
    'Zombie PO'

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-6">
            {/* Header */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="px-6 py-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      exception.exception_type === 'LATE_PO' ? 'bg-red-500' :
                      exception.exception_type === 'PARTIAL_OPEN' ? 'bg-yellow-500' :
                      exception.exception_type === 'UOM_AMBIGUITY' ? 'bg-blue-500' :
                      'bg-gray-500'
                    }`}></div>
                    <h1 className="text-2xl font-semibold text-gray-900">Exception Detected</h1>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${badgeColor}`}>
                      {badgeText}
                    </span>
                    <div className="text-sm text-gray-500">
                      Exception #{id}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Case Summary */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-base font-semibold text-gray-900">Case Summary</h2>
              </div>
              <div className="px-6 py-4">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">PO</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.po_id || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Line</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.line_id || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Supplier</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.supplier_name || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Part Num</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.part_num || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Description</div>
                    <div className="text-sm text-gray-900">{normalizedRow.description || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Qty</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.order_qty !== null ? normalizedRow.order_qty.toLocaleString() : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Unit Price</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.unit_price !== null ? `$${normalizedRow.unit_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Due Date</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.due_date ? normalizedRow.due_date.toLocaleDateString() : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Receipt Date</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.receipt_date || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Line Open</div>
                    <div className="text-sm font-semibold text-gray-900">{normalizedRow.line_open ? 'Yes' : 'No'}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Evidence */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-base font-semibold text-gray-900">Evidence</h2>
              </div>
              <div className="px-6 py-4">
                <ul className="space-y-2.5">
                  {exception.evidence.map((item, index) => (
                    <li key={index} className="flex items-start gap-2.5 text-sm text-gray-700">
                      <span className="text-gray-400 mt-1.5 flex-shrink-0">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                  {exception.days_late !== null && exception.days_late > 0 && (
                    <li className="flex items-start gap-2.5 text-sm font-semibold text-red-700">
                      <span className="text-red-400 mt-1.5 flex-shrink-0">•</span>
                      <span>Days Late: {exception.days_late} day{exception.days_late !== 1 ? 's' : ''}</span>
                    </li>
                  )}
                </ul>
              </div>
            </div>

            {/* Recommended Action */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="px-6 py-4 border-b border-gray-200">
                <h2 className="text-base font-semibold text-gray-900">Recommended Action</h2>
              </div>
              <div className="px-6 py-4">
                <div className="text-sm font-semibold text-gray-900">
                  {getRecommendedAction(exception.exception_type)}
                </div>
              </div>
            </div>

            {/* Prepared Message */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="px-6 py-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-gray-900">Prepared Message</h2>
                  <button
                    onClick={handleCopy}
                    className="text-xs font-medium text-gray-700 hover:text-gray-900 px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                  >
                    {copiedState ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="px-6 py-4 space-y-4">
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Subject</div>
                  <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2.5">
                    <div className="text-sm text-gray-900 font-medium">{draft.subject}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Body</div>
                  <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2.5">
                    <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                      {draft.body}
                    </div>
                  </div>
                </div>
              </div>
            </div>
        </div>
      </div>
    </div>
  )
}
