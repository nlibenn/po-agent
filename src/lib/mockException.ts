export interface ExceptionData {
  po_id: string
  line_id: string
  supplier_name: string
  supplier_id: string
  buyer_id: string
  part_num: string
  description: string
  order_qty: number
  unit_price: number
  order_date: string
  due_date: string
  receipt_date: string
  exception_type: string
  days_late: number
  agent: {
    action_id: string
    action_title: string
    why: string
    draft_email_subject: string
    draft_email_body: string
  }
  allowed_actions_count: number
}

export function csvRowToException(row: Record<string, string>): ExceptionData {
  // Helper to get value with fallback
  const get = (key: string, alt?: string) => {
    const value = row[key] || row[key.toLowerCase()] || row[key.toUpperCase()] || alt || ''
    return value.trim()
  }

  // Helper to get numeric value
  const getNum = (key: string, alt?: string | number) => {
    const value = get(key, typeof alt === 'string' ? alt : undefined)
    const num = parseFloat(value) || parseFloat(value.replace(/[^0-9.-]/g, '')) || (typeof alt === 'number' ? alt : 0)
    return num
  }

  // Helper to get date value
  const getDate = (key: string, alt?: string) => {
    const value = get(key, alt)
    // Try to parse and format date, or return as-is
    if (value) {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0]
      }
    }
    return value || alt || ''
  }

  // Calculate days late if not provided
  const dueDate = getDate('due_date', 'due date')
  const receiptDate = getDate('receipt_date', 'receipt date')
  let daysLate = getNum('days_late', 0)
  
  if (daysLate === 0 && dueDate && receiptDate) {
    const due = new Date(dueDate)
    const receipt = new Date(receiptDate)
    if (!isNaN(due.getTime()) && !isNaN(receipt.getTime())) {
      const diffTime = receipt.getTime() - due.getTime()
      daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    }
  }

  // Determine exception type if not provided
  let exceptionType = get('exception_type', 'exception type')
  if (!exceptionType || exceptionType === '') {
    if (daysLate > 0) {
      exceptionType = 'Late Delivery'
    } else if (daysLate < 0) {
      exceptionType = 'Early Delivery'
    } else {
      exceptionType = 'Delivery Exception'
    }
  }

  // Generate agent action based on exception
  const poId = get('po_id', 'po id')
  const supplierName = get('supplier_name', 'supplier name')
  const actionId = `ACT-${poId.slice(-6)}` || 'ACT-001'
  
  let actionTitle = 'Request Follow-up'
  let why = `Supplier ${supplierName || 'missed delivery deadline'}. Need to escalate to ensure future on-time deliveries.`
  
  if (exceptionType === 'Late Delivery' && daysLate > 0) {
    actionTitle = 'Request Expedited Shipping'
    why = `Supplier missed delivery deadline by ${daysLate} days. Need to escalate to ensure future on-time deliveries and discuss compensation for delay.`
  }

  // Generate email subject and body
  const draftEmailSubject = `Urgent: ${exceptionType} - ${poId} - Follow-up Required`
  
  const draftEmailBody = `Dear ${supplierName || 'Supplier Team'},

I hope this message finds you well. I am writing to follow up on Purchase Order ${poId}, which was scheduled for delivery on ${dueDate}, but was received on ${receiptDate}${daysLate > 0 ? ` - ${daysLate} days past the agreed delivery date` : ''}.

This ${daysLate > 0 ? 'delay has' : 'situation has'} impacted our production schedule and requires immediate attention. I would like to schedule a call to discuss:

1. The root cause of this ${daysLate > 0 ? 'delay' : 'issue'}
2. Measures to prevent similar issues in future orders
3. Potential compensation or expedited shipping options for future orders

Please let me know your availability this week for a brief discussion.

Thank you for your prompt attention to this matter.

Best regards,
Procurement Team`

  return {
    po_id: get('po_id', 'po id'),
    line_id: get('line_id', 'line id'),
    supplier_name: get('supplier_name', 'supplier name'),
    supplier_id: get('supplier_id', 'supplier id'),
    buyer_id: get('buyer_id', 'buyer id'),
    part_num: get('part_num', 'part num'),
    description: get('description'),
    order_qty: getNum('order_qty', 'order qty'),
    unit_price: getNum('unit_price', 'unit price'),
    order_date: getDate('order_date', 'order date'),
    due_date: dueDate,
    receipt_date: receiptDate,
    exception_type: exceptionType,
    days_late: daysLate,
    agent: {
      action_id: actionId,
      action_title: actionTitle,
      why: why,
      draft_email_subject: draftEmailSubject,
      draft_email_body: draftEmailBody,
    },
    allowed_actions_count: 5
  }
}

// Export a default mock for backward compatibility
export const mockException = csvRowToException({
  'po_id': 'PO-2024-001234',
  'line_id': 'LINE-001',
  'supplier_name': 'Acme Manufacturing Inc.',
  'supplier_id': 'SUP-789',
  'buyer_id': 'BUYER-456',
  'part_num': 'PN-98765-ABC',
  'description': 'High-Precision Ball Bearing Assembly - 50mm',
  'order_qty': '150',
  'unit_price': '125.50',
  'order_date': '2024-01-15',
  'due_date': '2024-02-20',
  'receipt_date': '2024-02-28',
  'exception_type': 'Late Delivery',
  'days_late': '8'
})
