'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { deriveExceptions, Exception, generateDraftMessage, computeTriage, TriageResult } from '@/src/lib/po'
import { useWorkspace } from '@/components/WorkspaceProvider'

export default function ExceptionPage({
  params,
}: {
  params: { id: string }
}) {
  const { id } = params
  const [copiedState, setCopiedState] = useState<boolean>(false)
  const [exception, setException] = useState<Exception | null>(null)
  const [normalizedRow, setNormalizedRow] = useState<any>(null)
  const [triage, setTriage] = useState<TriageResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorType, setErrorType] = useState<'no_data' | 'no_match' | null>(null)

  const { normalizedRows } = useWorkspace()

  useEffect(() => {
    if (!normalizedRows || normalizedRows.length === 0) {
      setError('No workspace data found. Please upload a CSV or Excel file in Drive.')
      setErrorType('no_data')
      setLoading(false)
      return
    }

    try {
      
      // Derive exceptions
      const today = new Date()
      const exceptions = deriveExceptions(normalizedRows, today)
      
      // Find matching exception by id
      const matchingException = exceptions.find(ex => ex.id === id)
      
      if (!matchingException) {
        setError(`No matching case found for ${id}`)
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

      // Compute triage for this row (pass all rows for cohort analysis)
      const triageResult = computeTriage(matchingRow, today, normalizedRows)
      
      setException(matchingException)
      setNormalizedRow(matchingRow)
      setTriage(triageResult)
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
        <div className="h-full flex items-center justify-center">
          <div className="text-neutral-600">Loading case data...</div>
      </div>
    )
  }

  if (error || !exception || !normalizedRow || !triage) {
    const backLink = errorType === 'no_data' ? '/drive' : '/exceptions'
    const backText = errorType === 'no_data' ? '← Return to Drive' : '← Return to exceptions'
    
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="max-w-md w-full bg-white/70 rounded-3xl shadow-sm px-12 py-16 text-center">
          <div className="text-neutral-700 mb-6 font-medium">{error || 'Case not found'}</div>
          <Link 
            href={backLink} 
            className="text-neutral-600 hover:text-neutral-800 underline text-sm transition-colors"
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
        // UOM_AMBIGUITY is about measurement interpretation risk, not operational status
        return 'Ambiguous item measurement'
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
        // Only add receipt date if present, but don't assume line is open
        // UOM_AMBIGUITY can occur on both open and closed lines
        if (row.receipt_date && row.receipt_date.trim() !== '') {
          observed.push(`Receipt date: ${row.receipt_date}`)
        }
        break
    }
    
    return { expected, observed }
  }
  
  const diagnosisTitle = getDiagnosisTitle(exception)
  const whatsUnusual = getWhatsUnusual(exception, normalizedRow)
  const evidenceCategories = categorizeEvidence(exception, normalizedRow)

  return (
    <div className="h-full">
      <div className="max-w-7xl mx-auto px-8 py-10">
        <div className="space-y-8">
            {/* Header - elevated card surface */}
            <div className="bg-white/70 rounded-3xl shadow-sm">
              <div className="px-10 py-8">
                <div className="flex items-center justify-between mb-6">
                    <Link 
                      href="/exceptions"
                      className="inline-flex items-center gap-2 text-sm font-medium text-neutral-600 hover:text-neutral-800 transition-colors"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back to exceptions
                    </Link>
                    {errorType === 'no_data' && (
                      <Link 
                        href="/drive"
                        className="inline-flex items-center gap-2 text-sm font-medium text-neutral-700 hover:text-neutral-900 transition-colors"
                      >
                        Go to Drive
                      </Link>
                    )}
                  <div className="text-sm text-neutral-500">
                    PO {exception.po_id} • Line {exception.line_id}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${
                      triage.status === 'Action' ? 'bg-neutral-700' :
                      triage.status === 'Review' ? 'bg-neutral-600' :
                      'bg-neutral-500'
                  }`}></div>
                    <h1 className="text-2xl font-semibold text-neutral-800">
                      {triage.status === 'Action' ? 'Attention suggested' : triage.status === 'Review' ? 'Attention suggested' : 'Case: ' + triage.status}
                    </h1>
                  </div>
              </div>
            </div>
            
            {/* Status and Signals - elevated card */}
            <div className="bg-white/70 rounded-3xl shadow-sm">
              <div className="px-10 py-8">
                <h2 className="text-base font-semibold text-neutral-800 mb-6">Status & Signals</h2>
                <div className="space-y-6">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Status</div>
                    <div>
                      <span className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-medium ${
                        triage.status === 'Action' ? 'bg-neutral-200 text-neutral-800' :
                        triage.status === 'Review' ? 'bg-neutral-100 text-neutral-700' :
                        'bg-neutral-100 text-neutral-600'
                      }`}>
                        {triage.status}
                      </span>
                    </div>
                  </div>
                  {triage.signals.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Signals</div>
                      <div className="flex flex-wrap gap-2">
                        {triage.signals.map((signal, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium bg-neutral-50/80 text-neutral-700 shadow-sm"
                          >
                            {signal}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {triage.next_step && (
                    <div>
                      <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Next Step</div>
                      <div className="text-sm text-neutral-800 font-medium">
                        {triage.next_step}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {/* What's unusual - elevated card */}
            <div className="bg-white/70 rounded-3xl shadow-sm">
              <div className="px-10 py-8">
                <h2 className="text-base font-semibold text-neutral-800 mb-6">What's unusual</h2>
                <div className="space-y-6">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Expected</div>
                    <div className="text-sm text-neutral-700 leading-relaxed">{whatsUnusual.expected}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Observed</div>
                    <div className="text-sm text-neutral-800 leading-relaxed">{whatsUnusual.observed}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Case Summary - elevated card */}
            <div className="bg-white/70 rounded-3xl shadow-sm">
              <div className="px-10 py-8">
                <h2 className="text-base font-semibold text-neutral-800 mb-6">Case Summary</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">PO</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.po_id || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Line</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.line_id || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Supplier</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.supplier_name || '—'}</div>
                  </div>
                    <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Part Num</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.part_num || '—'}</div>
                    </div>
                    <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Description</div>
                    <div className="text-sm text-neutral-800">{normalizedRow.description || '—'}</div>
                    </div>
                    <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Qty</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.order_qty !== null ? normalizedRow.order_qty.toLocaleString() : '—'}</div>
                  </div>
                <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Unit Price</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.unit_price !== null ? `$${normalizedRow.unit_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</div>
                </div>
                <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Due Date</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.due_date ? normalizedRow.due_date.toLocaleDateString() : '—'}</div>
                </div>
                <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Receipt Date</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.receipt_date || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Line Open</div>
                    <div className="text-sm font-semibold text-neutral-800">{normalizedRow.line_open ? 'Yes' : 'No'}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Evidence - elevated card */}
            <div className="bg-white/70 rounded-3xl shadow-sm">
              <div className="px-10 py-8">
                <h2 className="text-base font-semibold text-neutral-800 mb-6">Evidence</h2>
                <div className="space-y-8">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-4">Expected</div>
                    <ul className="space-y-3">
                      {evidenceCategories.expected.map((item, index) => (
                        <li key={index} className="flex items-start gap-3 text-sm text-neutral-700 leading-relaxed">
                          <span className="text-neutral-400 mt-1.5 flex-shrink-0">•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-4">Observed</div>
                    <ul className="space-y-3">
                      {evidenceCategories.observed.map((item, index) => (
                        <li key={index} className="flex items-start gap-3 text-sm text-neutral-800 leading-relaxed">
                          <span className="text-neutral-500 mt-1.5 flex-shrink-0">•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Recommended Action - only show if next_step is different from triage next_step */}
            {triage.next_step && triage.next_step !== getRecommendedAction(exception.exception_type) && (
              <div className="bg-white/70 rounded-3xl shadow-sm">
                <div className="px-10 py-8">
                  <h2 className="text-base font-semibold text-neutral-800 mb-4">Recommended Action</h2>
                  <div className="text-sm font-semibold text-neutral-800">
                    {getRecommendedAction(exception.exception_type)}
                  </div>
                </div>
              </div>
            )}

            {/* Prepared Message - elevated card */}
            <div className="bg-white/70 rounded-3xl shadow-sm">
              <div className="px-10 py-8">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-base font-semibold text-neutral-800">Prepared Message</h2>
                  <button
                    onClick={handleCopy}
                    className="text-xs font-medium text-neutral-700 hover:text-neutral-800 px-3 py-1.5 bg-white/70 hover:bg-white/85 rounded-xl transition-colors shadow-sm"
                  >
                    {copiedState ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <div className="space-y-5">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Subject</div>
                    <div className="bg-neutral-50/50 rounded-2xl shadow-sm px-4 py-3">
                      <div className="text-sm text-neutral-800 font-medium">{draft.subject}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">Body</div>
                    <div className="bg-neutral-50/50 rounded-2xl shadow-sm px-4 py-3">
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
    </div>
  )
}
