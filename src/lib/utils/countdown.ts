/**
 * Countdown utilities for PO date tracking
 * Uses ERP dates from po_line meta (order_date, due_date)
 */

/**
 * Days since PO was created (TODAY - order_date).
 * Returns positive number = days elapsed, negative if order_date is in future.
 * Returns null if date is invalid.
 */
export function daysSincePoCreated(orderDate: string | Date, today: Date = new Date()): number | null {
  const d = orderDate instanceof Date ? orderDate : new Date(orderDate)
  if (isNaN(d.getTime())) return null

  const todayNorm = new Date(today)
  todayNorm.setHours(0, 0, 0, 0)
  const dNorm = new Date(d)
  dNorm.setHours(0, 0, 0, 0)

  return Math.floor((todayNorm.getTime() - dNorm.getTime()) / (24 * 60 * 60 * 1000))
}

/**
 * Days until delivery (due_date - TODAY).
 * Positive = days remaining, negative = overdue, 0 = due today.
 * Returns null if date is invalid.
 */
export function daysUntilDelivery(dueDate: string | Date, today: Date = new Date()): number | null {
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate)
  if (isNaN(d.getTime())) return null

  const todayNorm = new Date(today)
  todayNorm.setHours(0, 0, 0, 0)
  const dNorm = new Date(d)
  dNorm.setHours(0, 0, 0, 0)

  return Math.floor((dNorm.getTime() - todayNorm.getTime()) / (24 * 60 * 60 * 1000))
}

/**
 * Format countdown for display.
 * e.g. "3d overdue", "Due today", "12d left", "45d ago"
 */
export function formatCountdown(days: number, mode: 'until' | 'since'): string {
  if (mode === 'until') {
    if (days < 0) return `${Math.abs(days)}d overdue`
    if (days === 0) return 'Due today'
    return `${days}d left`
  }
  // mode === 'since'
  if (days < 0) return `in ${Math.abs(days)}d`
  if (days === 0) return 'Today'
  return `${days}d ago`
}
