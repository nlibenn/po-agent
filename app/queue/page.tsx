'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { normalizeRow, deriveExceptions, Exception, ExceptionType, detectUoMAmbiguity } from '../../src/lib/po'

type ExceptionTypeFilter = 'all' | 'LATE_PO' | 'PARTIAL_OPEN' | 'ZOMBIE_PO'
type RiskFlagFilter = 'all' | 'UOM_AMBIGUITY'

interface ExceptionWithRisk extends Exception {
  hasUoMRisk: boolean
}

// Helper to check if exception has UoM risk
function hasUoMRisk(exception: Exception): boolean {
  return detectUoMAmbiguity(exception.rowData.description)
}

// Helper to get exception priority for sorting (lower number = higher priority)
function getExceptionPriority(exceptionType: ExceptionType): number {
  switch (exceptionType) {
    case 'LATE_PO': return 1
    case 'PARTIAL_OPEN': return 2
    case 'ZOMBIE_PO': return 3
    case 'UOM_AMBIGUITY': return 4
    default: return 99
  }
}

// Triage sort: most urgent first
function triageSort(a: ExceptionWithRisk, b: ExceptionWithRisk): number {
  // First by exception type priority
  const priorityA = getExceptionPriority(a.exception_type)
  const priorityB = getExceptionPriority(b.exception_type)
  if (priorityA !== priorityB) {
    return priorityA - priorityB
  }
  
  // Within same type, UoM risk floats higher
  if (a.hasUoMRisk !== b.hasUoMRisk) {
    return a.hasUoMRisk ? -1 : 1
  }
  
  // Then by due date (oldest first, nulls last)
  if (a.due_date && b.due_date) {
    return a.due_date.getTime() - b.due_date.getTime()
  }
  if (a.due_date) return -1
  if (b.due_date) return 1
  
  return 0
}

// Dedupe exceptions by unique key: PO ID + Line ID + Exception Type + Risk Flag
function dedupeExceptions(exceptions: Exception[]): Exception[] {
  const seen = new Set<string>()
  const result: Exception[] = []
  
  for (const ex of exceptions) {
    const hasUoM = hasUoMRisk(ex)
    const key = `${ex.po_id}-${ex.line_id}-${ex.exception_type}-${hasUoM ? 'UOM' : 'NO_UOM'}`
    
    if (!seen.has(key)) {
      seen.add(key)
      result.push(ex)
    }
  }
  
  return result
}

export default function QueuePage() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [exceptions, setExceptions] = useState<Exception[]>([])
  const [filename, setFilename] = useState<string>('')
  const [exceptionTypeFilter, setExceptionTypeFilter] = useState<ExceptionTypeFilter>('all')
  const [riskFlagFilter, setRiskFlagFilter] = useState<RiskFlagFilter>('all')
  const router = useRouter()

  useEffect(() => {
    // Read from sessionStorage
    const storedData = sessionStorage.getItem('po_rows')
    const storedFilename = sessionStorage.getItem('po_filename') || ''

    console.log('Queue: po_rows found:', !!storedData)

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

      console.log('Queue: parsed rows length:', parsedRows.length)

      setRows(parsedRows)
      setFilename(storedFilename)

      // Normalize all rows
      const normalizedRows = parsedRows.map(row => normalizeRow(row))
      
      // Derive exceptions from normalized rows
      const today = new Date()
      const exceptionsList = deriveExceptions(normalizedRows, today)
      
      // Dedupe exceptions
      const dedupedExceptions = dedupeExceptions(exceptionsList)

      console.log('Queue: exceptions length:', dedupedExceptions.length)

      setExceptions(dedupedExceptions)
    } catch (e) {
      console.error('Error processing data:', e)
      setRows([])
      setFilename(storedFilename)
    }
  }, [])

  // Add UoM risk flag to exceptions
  const exceptionsWithRisk = useMemo(() => {
    return exceptions.map(ex => ({
      ...ex,
      hasUoMRisk: hasUoMRisk(ex)
    })) as ExceptionWithRisk[]
  }, [exceptions])

  // Compute counts
  const counts = useMemo(() => {
    const totalLines = rows?.length || 0
    const totalExceptions = exceptionsWithRisk.length
    const lateCount = exceptionsWithRisk.filter(e => e.exception_type === 'LATE_PO').length
    const partialCount = exceptionsWithRisk.filter(e => e.exception_type === 'PARTIAL_OPEN').length
    const zombieCount = exceptionsWithRisk.filter(e => e.exception_type === 'ZOMBIE_PO').length
    const uomRiskCount = exceptionsWithRisk.filter(e => e.hasUoMRisk).length
    
    return {
      totalLines,
      totalExceptions,
      lateCount,
      partialCount,
      zombieCount,
      uomRiskCount
    }
  }, [exceptionsWithRisk, rows])

  // Filter and sort exceptions
  const filteredAndSortedExceptions = useMemo(() => {
    let filtered = exceptionsWithRisk
    
    // Apply exception type filter
    if (exceptionTypeFilter !== 'all') {
      filtered = filtered.filter(e => e.exception_type === exceptionTypeFilter)
    }
    
    // Apply risk flag filter
    if (riskFlagFilter === 'UOM_AMBIGUITY') {
      filtered = filtered.filter(e => e.hasUoMRisk)
    }
    
    // Sort by triage priority
    return [...filtered].sort(triageSort)
  }, [exceptionsWithRisk, exceptionTypeFilter, riskFlagFilter])

  const handleRowClick = (id: string) => {
    router.push(`/exception/${id}`)
  }

  const handleKPIClick = (type: ExceptionTypeFilter | 'UOM_AMBIGUITY') => {
    if (type === 'UOM_AMBIGUITY') {
      setRiskFlagFilter('UOM_AMBIGUITY')
      setExceptionTypeFilter('all')
    } else {
      setExceptionTypeFilter(type)
      setRiskFlagFilter('all')
    }
  }

  // Loading state
  if (rows === null) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    )
  }

  // Empty state
  if (rows.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 shadow-sm p-6 text-center">
          <div className="text-gray-600 mb-4">No CSV data found</div>
          <Link 
            href="/" 
            className="inline-block px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded border border-blue-700 transition-colors"
          >
            Upload a CSV
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mb-6">
          <h1 className="text-2xl font-semibold text-gray-900 mb-4">Exceptions Queue</h1>
          {filename && (
            <div className="text-sm text-gray-600 mb-4">
              <span className="font-medium">File:</span> {filename}
            </div>
          )}
        </div>

        {/* Triage Summary */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Triage Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <button
              onClick={() => {
                setExceptionTypeFilter('all')
                setRiskFlagFilter('all')
              }}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                exceptionTypeFilter === 'all' && riskFlagFilter === 'all'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Total Lines</div>
              <div className="text-2xl font-bold text-gray-900">{counts.totalLines}</div>
            </button>
            
            <button
              onClick={() => {
                setExceptionTypeFilter('all')
                setRiskFlagFilter('all')
              }}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                exceptionTypeFilter === 'all' && riskFlagFilter === 'all'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Total Exceptions</div>
              <div className="text-2xl font-bold text-red-700">{counts.totalExceptions}</div>
            </button>
            
            <button
              onClick={() => handleKPIClick('LATE_PO')}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                exceptionTypeFilter === 'LATE_PO'
                  ? 'border-red-500 bg-red-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Late</div>
              <div className="text-2xl font-bold text-red-700">{counts.lateCount}</div>
            </button>
            
            <button
              onClick={() => handleKPIClick('PARTIAL_OPEN')}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                exceptionTypeFilter === 'PARTIAL_OPEN'
                  ? 'border-yellow-500 bg-yellow-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Partial Open</div>
              <div className="text-2xl font-bold text-yellow-700">{counts.partialCount}</div>
            </button>
            
            <button
              onClick={() => handleKPIClick('ZOMBIE_PO')}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                exceptionTypeFilter === 'ZOMBIE_PO'
                  ? 'border-gray-500 bg-gray-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Zombie</div>
              <div className="text-2xl font-bold text-gray-700">{counts.zombieCount}</div>
            </button>
            
            <button
              onClick={() => handleKPIClick('UOM_AMBIGUITY')}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                riskFlagFilter === 'UOM_AMBIGUITY'
                  ? 'border-orange-500 bg-orange-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Risk Flags</div>
              <div className="text-2xl font-bold text-orange-700">{counts.uomRiskCount}</div>
              <div className="text-xs text-gray-500 mt-1">UoM Ambiguity</div>
            </button>
          </div>
        </div>

        {exceptions.length > 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-wrap gap-4">
              <h2 className="text-base font-semibold text-gray-900">
                Exceptions
              </h2>
              <div className="flex items-center gap-4">
                <div>
                  <label htmlFor="exception-type-filter" className="sr-only">Filter by exception type</label>
                  <select
                    id="exception-type-filter"
                    value={exceptionTypeFilter}
                    onChange={(e) => setExceptionTypeFilter(e.target.value as ExceptionTypeFilter)}
                    className="text-sm border border-gray-300 rounded px-3 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Types</option>
                    <option value="LATE_PO">Late PO</option>
                    <option value="PARTIAL_OPEN">Partial Open</option>
                    <option value="ZOMBIE_PO">Zombie PO</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="risk-flag-filter" className="sr-only">Filter by risk flag</label>
                  <select
                    id="risk-flag-filter"
                    value={riskFlagFilter}
                    onChange={(e) => setRiskFlagFilter(e.target.value as RiskFlagFilter)}
                    className="text-sm border border-gray-300 rounded px-3 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Risk Flags</option>
                    <option value="UOM_AMBIGUITY">UoM Ambiguity</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Exception Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Risk
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      PO ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Line ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Supplier
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Due Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Days Late
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredAndSortedExceptions.map((exception) => {
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
                      <tr
                        key={exception.id}
                        onClick={() => handleRowClick(exception.id)}
                        className="hover:bg-blue-50 cursor-pointer transition-colors"
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeColor}`}>
                            {badgeText}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {exception.hasUoMRisk && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                              UoM
                            </span>
                          )}
                          {!exception.hasUoMRisk && <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {exception.po_id}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {exception.line_id}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {exception.supplier_name || '—'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {exception.due_date ? exception.due_date.toLocaleDateString() : '—'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                          {exception.days_late !== null ? `${exception.days_late} days` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 text-center">
            <div className="text-gray-600 mb-4">No exceptions found</div>
            <div className="text-sm text-gray-500">All purchase orders are in good standing.</div>
          </div>
        )}
      </div>
    </div>
  )
}
