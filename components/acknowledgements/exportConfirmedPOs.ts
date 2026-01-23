import { ConfirmedPO } from './AgentStateContext'

/**
 * Export confirmed POs to CSV
 */
export function exportConfirmedPOsToCSV(confirmedPOs: ConfirmedPO[]): void {
  if (confirmedPOs.length === 0) {
    return
  }

  // CSV headers
  const headers = [
    'PO Number',
    'Line ID',
    'Supplier Name',
    'Supplier Order Number',
    'Delivery Date',
    'Quantity',
    'Unit Price',
    'Confirmed At',
  ]

  // Convert to CSV rows
  const rows = confirmedPOs.map(po => [
    po.po_number,
    po.line_id,
    po.supplier_name || '',
    po.supplier_order_number || '',
    po.delivery_date || '',
    po.quantity?.toString() || '',
    po.unit_price?.toString() || '',
    new Date(po.confirmed_at).toISOString(),
  ])

  // Combine headers and rows
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => {
      // Escape commas and quotes in cell values
      const cellStr = String(cell || '')
      if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
        return `"${cellStr.replace(/"/g, '""')}"`
      }
      return cellStr
    }).join(',')),
  ].join('\n')

  // Create blob and download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  link.setAttribute('href', url)
  link.setAttribute('download', `po_confirmations_${timestamp}.csv`)
  link.style.visibility = 'hidden'
  
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  
  URL.revokeObjectURL(url)
}
