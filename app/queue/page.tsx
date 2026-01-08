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

// Convert exception type to operator-first language
function getOperationalIssue(exception: ExceptionWithRisk): { title: string; subline: string | null } {
  const { exception_type, rowData, days_late } = exception
  
  // Helper to truncate description
  const getDescriptionSnippet = (desc: string | null | undefined, maxLength: number = 60): string | null => {
    if (!desc || desc.trim() === '') return null
    const trimmed = desc.trim()
    return trimmed.length > maxLength ? trimmed.substring(0, maxLength) + '...' : trimmed
  }
  
  switch (exception_type) {
    case 'LATE_PO':
      // Use description snippet if available, otherwise omit subline
      const lateDesc = getDescriptionSnippet(rowData.description)
      return {
        title: 'Shipment overdue, not received',
        subline: lateDesc ? `Description: ${lateDesc}` : null
      }
    case 'PARTIAL_OPEN':
      // Prefer receipt date template, fallback to description
      if (rowData.receipt_date && rowData.receipt_date.trim() !== '') {
        return {
          title: 'Line remains open after receipt',
          subline: `Receipt posted on ${rowData.receipt_date}, line still open`
        }
      } else {
        const partialDesc = getDescriptionSnippet(rowData.description)
        return {
          title: 'Line remains open after receipt',
          subline: partialDesc ? `Description: ${partialDesc}` : null
        }
      }
    case 'ZOMBIE_PO':
      // Use description snippet if available, otherwise omit subline
      const zombieDesc = getDescriptionSnippet(rowData.description)
      return {
        title: 'Line open past expected closure',
        subline: zombieDesc ? `Description: ${zombieDesc}` : null
      }
    case 'UOM_AMBIGUITY':
      // UoM is about description ambiguity, so always use description snippet
      const uomDesc = getDescriptionSnippet(rowData.description)
      return {
        title: 'Ambiguous item measurement',
        subline: uomDesc ? `Description: ${uomDesc}` : null
      }
    default:
      return {
        title: 'Operational issue detected',
        subline: null
      }
  }
}

// Get operator-meaningful badge text
function getRiskDriverBadge(hasUoMRisk: boolean): string | null {
  if (hasUoMRisk) {
    return 'Interpretation risk'
  }
  return null
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
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="text-neutral-600">Loading...</div>
      </div>
    )
  }

  // Empty state
  if (rows.length === 0) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm px-12 py-16 text-center">
          <div className="text-neutral-700 mb-6">No CSV data found</div>
          <Link 
            href="/" 
            className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2"
          >
            Select CSV file
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-sm px-8 py-6 mb-6">
          <h1 className="text-2xl font-semibold text-neutral-900 mb-2">Exceptions Queue</h1>
          {filename && (
            <div className="text-sm text-neutral-600">
              <span className="font-medium">File:</span> {filename}
            </div>
          )}
        </div>

        {/* Triage Summary */}
        <div className="bg-white rounded-2xl shadow-sm px-8 py-6 mb-6">
          <h2 className="text-base font-semibold text-neutral-900 mb-6">Triage Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <button
              onClick={() => {
                setExceptionTypeFilter('all')
                setRiskFlagFilter('all')
              }}
              className={`text-left p-5 rounded-xl transition-all ${
                exceptionTypeFilter === 'all' && riskFlagFilter === 'all'
                  ? 'bg-neutral-100'
                  : 'bg-neutral-50 hover:bg-neutral-100'
              }`}
            >
              <div className="text-xs font-medium text-neutral-500 mb-2">Total Lines</div>
              <div className="text-2xl font-semibold text-neutral-900">{counts.totalLines}</div>
            </button>
            
            <button
              onClick={() => {
                setExceptionTypeFilter('all')
                setRiskFlagFilter('all')
              }}
              className={`text-left p-5 rounded-xl transition-all ${
                exceptionTypeFilter === 'all' && riskFlagFilter === 'all'
                  ? 'bg-neutral-100'
                  : 'bg-neutral-50 hover:bg-neutral-100'
              }`}
            >
              <div className="text-xs font-medium text-neutral-500 mb-2">Total Exceptions</div>
              <div className={`text-2xl font-semibold ${counts.totalExceptions === 0 ? 'text-neutral-600' : 'text-red-600'}`}>
                {counts.totalExceptions}
              </div>
            </button>
            
            <button
              onClick={() => handleKPIClick('LATE_PO')}
              className={`text-left p-5 rounded-xl transition-all ${
                exceptionTypeFilter === 'LATE_PO'
                  ? 'bg-red-50'
                  : 'bg-neutral-50 hover:bg-neutral-100'
              }`}
            >
              <div className="text-xs font-medium text-neutral-500 mb-2">Overdue</div>
              <div className={`text-2xl font-semibold ${counts.lateCount === 0 ? 'text-neutral-600' : 'text-red-600'}`}>
                {counts.lateCount}
              </div>
            </button>
            
            <button
              onClick={() => handleKPIClick('PARTIAL_OPEN')}
              className={`text-left p-5 rounded-xl transition-all ${
                exceptionTypeFilter === 'PARTIAL_OPEN'
                  ? 'bg-amber-50'
                  : 'bg-neutral-50 hover:bg-neutral-100'
              }`}
            >
              <div className="text-xs font-medium text-neutral-500 mb-2">Open After Receipt</div>
              <div className={`text-2xl font-semibold ${counts.partialCount === 0 ? 'text-neutral-600' : 'text-amber-600'}`}>
                {counts.partialCount}
              </div>
            </button>
            
            <button
              onClick={() => handleKPIClick('ZOMBIE_PO')}
              className={`text-left p-5 rounded-xl transition-all ${
                exceptionTypeFilter === 'ZOMBIE_PO'
                  ? 'bg-neutral-100'
                  : 'bg-neutral-50 hover:bg-neutral-100'
              }`}
            >
              <div className="text-xs font-medium text-neutral-500 mb-2">Past Expected Closure</div>
              <div className={`text-2xl font-semibold ${counts.zombieCount === 0 ? 'text-neutral-600' : 'text-neutral-700'}`}>
                {counts.zombieCount}
              </div>
            </button>
            
            <button
              onClick={() => handleKPIClick('UOM_AMBIGUITY')}
              className={`text-left p-5 rounded-xl transition-all ${
                riskFlagFilter === 'UOM_AMBIGUITY'
                  ? 'bg-orange-50'
                  : 'bg-neutral-50 hover:bg-neutral-100'
              }`}
            >
              <div className="text-xs font-medium text-neutral-500 mb-2">Ambiguous item measurement</div>
              <div className={`text-2xl font-semibold ${counts.uomRiskCount === 0 ? 'text-neutral-600' : 'text-orange-600'}`}>
                {counts.uomRiskCount}
              </div>
              <div className="text-xs text-neutral-500 mt-1">Description contains mixed or unclear measurements</div>
            </button>
          </div>
        </div>

        {exceptions.length > 0 ? (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className="px-8 py-5 border-b border-neutral-200 flex items-center justify-between flex-wrap gap-4">
              <h2 className="text-base font-semibold text-neutral-900">
                Exceptions
              </h2>
              <div className="flex items-center gap-3">
                <div>
                  <label htmlFor="exception-type-filter" className="sr-only">Filter by exception type</label>
                  <select
                    id="exception-type-filter"
                    value={exceptionTypeFilter}
                    onChange={(e) => setExceptionTypeFilter(e.target.value as ExceptionTypeFilter)}
                    className="text-sm border border-neutral-300 rounded-lg px-3 py-2 text-neutral-700 bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900 transition-colors"
                  >
                    <option value="all">All Issues</option>
                    <option value="LATE_PO">Overdue</option>
                    <option value="PARTIAL_OPEN">Open After Receipt</option>
                    <option value="ZOMBIE_PO">Past Expected Closure</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="risk-flag-filter" className="sr-only">Filter by risk driver</label>
                  <select
                    id="risk-flag-filter"
                    value={riskFlagFilter}
                    onChange={(e) => setRiskFlagFilter(e.target.value as RiskFlagFilter)}
                    className="text-sm border border-neutral-300 rounded-lg px-3 py-2 text-neutral-700 bg-white focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-neutral-900 transition-colors"
                  >
                    <option value="all">All Risk Drivers</option>
                    <option value="UOM_AMBIGUITY">Interpretation Risk</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-neutral-200">
                <thead className="bg-neutral-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Operational Issue
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Risk Driver
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      PO ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Line ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Supplier
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Due Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                      Days Late
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-neutral-200">
                  {filteredAndSortedExceptions.map((exception) => {
                    const issue = getOperationalIssue(exception)
                    const riskDriver = getRiskDriverBadge(exception.hasUoMRisk)
                    
                    return (
                      <tr
                        key={exception.id}
                        onClick={() => handleRowClick(exception.id)}
                        className="hover:bg-neutral-50 cursor-pointer transition-colors"
                      >
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <div className="text-sm font-medium text-neutral-900">
                              {issue.title}
                            </div>
                            {issue.subline && (
                              <div className="text-xs text-neutral-500 mt-0.5 truncate">
                                {issue.subline}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {riskDriver ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-orange-100 text-orange-700">
                              {riskDriver}
                            </span>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-neutral-900">
                          {exception.po_id}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-900">
                          {exception.line_id}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-900">
                          {exception.supplier_name || '—'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-900">
                          {exception.due_date ? exception.due_date.toLocaleDateString() : '—'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-neutral-900">
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
          <div className="bg-white rounded-2xl shadow-sm px-12 py-16 text-center">
            <div className="text-neutral-700 mb-2">No exceptions found</div>
            <div className="text-sm text-neutral-500">All purchase orders are in good standing.</div>
          </div>
        )}
      </div>
    </div>
  )
}
