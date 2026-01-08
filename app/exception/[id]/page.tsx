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
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="text-neutral-600">Loading exception data...</div>
      </div>
    )
  }

  if (error || !exception || !normalizedRow) {
    const backLink = errorType === 'no_data' ? '/' : '/queue'
    const backText = errorType === 'no_data' ? '← Return to upload page' : '← Return to queue'
    
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm px-12 py-16 text-center">
          <div className="text-red-600 mb-6">{error || 'Exception not found'}</div>
          <Link 
            href={backLink} 
            className="text-neutral-700 hover:text-neutral-900 underline text-sm"
          >
            {backText}
          </Link>
        </div>
      </div>
    )
  }

  const draft = generateDraftMessage(exception)
  
  // Get operator-first diagnosis title
  function getDiagnosisTitle(exception: Exception): string {
    switch (exception.exception_type) {
      case 'LATE_PO':
        return 'Shipment overdue, not received'
      case 'PARTIAL_OPEN':
        return 'Line remains open after receipt'
      case 'ZOMBIE_PO':
        return 'Line open past expected closure'
      case 'UOM_AMBIGUITY':
        // Check if there's a receipt date
        if (normalizedRow.receipt_date && normalizedRow.receipt_date.trim() !== '') {
          return 'Receipt posted, line not closed'
        } else {
          return 'Received quantity doesn\'t reconcile to order'
        }
      default:
        return 'Operational issue detected'
    }
  }
  
  // Get "What's unusual" explanation
  function getWhatsUnusual(exception: Exception, row: any): { expected: string; observed: string } {
    switch (exception.exception_type) {
      case 'LATE_PO':
        const dueDateStr = row.due_date ? row.due_date.toLocaleDateString() : 'the due date'
        const daysLate = exception.days_late !== null && exception.days_late > 0 
          ? `${exception.days_late} day${exception.days_late !== 1 ? 's' : ''}` 
          : 'several days'
        return {
          expected: 'When a purchase order line reaches its due date, it should either be received and closed, or have a confirmed ship date.',
          observed: `This line was due ${dueDateStr} (${daysLate} ago) but has no receipt recorded and remains open.`
        }
      case 'PARTIAL_OPEN':
        const receiptDate = row.receipt_date || 'recently'
        const orderQty = row.order_qty !== null ? row.order_qty : 'the ordered quantity'
        return {
          expected: 'When goods are received, the purchase order line should be closed to reflect completion.',
          observed: `A receipt was recorded on ${receiptDate} for order quantity ${orderQty}, but the line remains open.`
        }
      case 'ZOMBIE_PO':
        const zombieDueDate = row.due_date ? row.due_date.toLocaleDateString() : 'the expected date'
        return {
          expected: 'Purchase order lines should be closed within a reasonable time after their due date, either through receipt or cancellation.',
          observed: `This line was due ${zombieDueDate} and has remained open for an extended period with no recent activity.`
        }
      case 'UOM_AMBIGUITY':
        if (row.receipt_date && row.receipt_date.trim() !== '') {
          return {
            expected: 'When a receipt is posted, the purchase order line should be closed to reflect completion.',
            observed: `A receipt was recorded on ${row.receipt_date}, but the line remains open. The description contains dimensional information that may indicate a unit of measure mismatch.`
          }
        } else {
          return {
            expected: 'Order quantities should have a clear unit of measure basis (e.g., per piece, per foot, per square foot) that matches pricing.',
            observed: `The description contains dimensional information (${row.description ? row.description.substring(0, 50) : 'dimensions'}), making it unclear whether quantity refers to pieces, linear feet, area, or volume.`
          }
        }
      default:
        return {
          expected: 'Purchase order lines should follow standard operational workflows.',
          observed: 'This line shows an unusual pattern that requires review.'
        }
    }
  }
  
  // Separate evidence into Expected and Observed
  function categorizeEvidence(exception: Exception, row: any): { expected: string[]; observed: string[] } {
    const expected: string[] = []
    const observed: string[] = []
    
    switch (exception.exception_type) {
      case 'LATE_PO':
        expected.push('Line should be closed after receipt')
        expected.push('Receipt should be recorded when goods arrive')
        if (row.due_date) {
          observed.push(`Due date: ${row.due_date.toLocaleDateString()}`)
        }
        if (exception.days_late !== null && exception.days_late > 0) {
          observed.push(`${exception.days_late} day${exception.days_late !== 1 ? 's' : ''} past due`)
        }
        if (!row.receipt_date || row.receipt_date.trim() === '') {
          observed.push('No receipt date recorded')
        }
        observed.push('Line is still open')
        break
      case 'PARTIAL_OPEN':
        expected.push('Line should close when receipt is posted')
        expected.push('Receipt date indicates goods were received')
        if (row.receipt_date && row.receipt_date.trim() !== '') {
          observed.push(`Receipt date: ${row.receipt_date}`)
        }
        if (row.order_qty !== null) {
          observed.push(`Order quantity: ${row.order_qty}`)
        }
        observed.push('Line is still open')
        break
      case 'ZOMBIE_PO':
        expected.push('Line should close within reasonable time after due date')
        expected.push('Stale lines should be reviewed and closed or revalidated')
        if (row.due_date) {
          observed.push(`Due date: ${row.due_date.toLocaleDateString()}`)
        }
        if (row.due_date) {
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          const sixtyDaysAgo = new Date(today)
          sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
          if (row.due_date < sixtyDaysAgo) {
            const daysPast = Math.ceil((today.getTime() - row.due_date.getTime()) / (1000 * 60 * 60 * 24))
            observed.push(`Over ${daysPast} days past due date`)
          }
        }
        observed.push('Line has been open for extended period')
        break
      case 'UOM_AMBIGUITY':
        expected.push('Unit of measure should be clear and unambiguous')
        expected.push('Quantity should reconcile to order basis')
        observed.push('Description contains dimensional language')
        if (row.description) {
          observed.push(`Description: "${row.description.substring(0, 100)}${row.description.length > 100 ? '...' : ''}"`)
        }
        if (row.receipt_date && row.receipt_date.trim() !== '') {
          observed.push(`Receipt date: ${row.receipt_date}`)
          observed.push('Line is still open')
        }
        break
    }
    
    return { expected, observed }
  }
  
  const diagnosisTitle = getDiagnosisTitle(exception)
  const whatsUnusual = getWhatsUnusual(exception, normalizedRow)
  const evidenceCategories = categorizeEvidence(exception, normalizedRow)

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-6">
            {/* Header */}
            <div className="bg-white rounded-2xl shadow-sm">
              <div className="px-8 py-6 border-b border-neutral-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      exception.exception_type === 'LATE_PO' ? 'bg-red-500' :
                      exception.exception_type === 'PARTIAL_OPEN' ? 'bg-amber-500' :
                      exception.exception_type === 'UOM_AMBIGUITY' ? 'bg-orange-500' :
                      'bg-neutral-500'
                    }`}></div>
                    <h1 className="text-2xl font-semibold text-neutral-900">{diagnosisTitle}</h1>
                  </div>
                  <div className="text-sm text-neutral-500">
                    PO {exception.po_id} • Line {exception.line_id}
                  </div>
                </div>
              </div>
            </div>
            
            {/* What's unusual */}
            <div className="bg-white rounded-2xl shadow-sm">
              <div className="px-8 py-6 border-b border-neutral-200">
                <h2 className="text-base font-semibold text-neutral-900 mb-4">What's unusual</h2>
              </div>
              <div className="px-8 py-6 space-y-4">
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Expected</div>
                  <div className="text-sm text-neutral-700 leading-relaxed">{whatsUnusual.expected}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Observed</div>
                  <div className="text-sm text-neutral-900 leading-relaxed">{whatsUnusual.observed}</div>
                </div>
              </div>
            </div>

            {/* Case Summary */}
            <div className="bg-white rounded-2xl shadow-sm">
              <div className="px-8 py-6 border-b border-neutral-200">
                <h2 className="text-base font-semibold text-neutral-900">Case Summary</h2>
              </div>
              <div className="px-8 py-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">PO</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.po_id || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Line</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.line_id || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Supplier</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.supplier_name || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Part Num</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.part_num || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Description</div>
                    <div className="text-sm text-neutral-900">{normalizedRow.description || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Qty</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.order_qty !== null ? normalizedRow.order_qty.toLocaleString() : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Unit Price</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.unit_price !== null ? `$${normalizedRow.unit_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Due Date</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.due_date ? normalizedRow.due_date.toLocaleDateString() : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Receipt Date</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.receipt_date || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Line Open</div>
                    <div className="text-sm font-semibold text-neutral-900">{normalizedRow.line_open ? 'Yes' : 'No'}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Evidence */}
            <div className="bg-white rounded-2xl shadow-sm">
              <div className="px-8 py-6 border-b border-neutral-200">
                <h2 className="text-base font-semibold text-neutral-900">Evidence</h2>
              </div>
              <div className="px-8 py-6 space-y-6">
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Expected</div>
                  <ul className="space-y-2">
                    {evidenceCategories.expected.map((item, index) => (
                      <li key={index} className="flex items-start gap-2.5 text-sm text-neutral-700">
                        <span className="text-neutral-400 mt-1.5 flex-shrink-0">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Observed</div>
                  <ul className="space-y-2">
                    {evidenceCategories.observed.map((item, index) => (
                      <li key={index} className="flex items-start gap-2.5 text-sm text-neutral-900">
                        <span className="text-neutral-500 mt-1.5 flex-shrink-0">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* Recommended Action */}
            <div className="bg-white rounded-2xl shadow-sm">
              <div className="px-8 py-6 border-b border-neutral-200">
                <h2 className="text-base font-semibold text-neutral-900">Recommended Action</h2>
              </div>
              <div className="px-8 py-6">
                <div className="text-sm font-semibold text-neutral-900">
                  {getRecommendedAction(exception.exception_type)}
                </div>
              </div>
            </div>

            {/* Prepared Message */}
            <div className="bg-white rounded-2xl shadow-sm">
              <div className="px-8 py-6 border-b border-neutral-200">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-neutral-900">Prepared Message</h2>
                  <button
                    onClick={handleCopy}
                    className="text-xs font-medium text-neutral-700 hover:text-neutral-900 px-3 py-1.5 border border-neutral-300 rounded-lg hover:bg-neutral-50 transition-colors"
                  >
                    {copiedState ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="px-8 py-6 space-y-4">
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Subject</div>
                  <div className="bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2.5">
                    <div className="text-sm text-neutral-900 font-medium">{draft.subject}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Body</div>
                  <div className="bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2.5">
                    <div className="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed">
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
