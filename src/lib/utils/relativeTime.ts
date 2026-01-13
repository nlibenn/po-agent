/**
 * Relative Time Formatting
 * 
 * Formats timestamps as relative time (e.g., "2h ago", "24m ago")
 */

/**
 * Format a timestamp as relative time
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  if (diff < 0) {
    return 'just now'
  }

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) {
    return 'just now'
  } else if (minutes < 60) {
    return `${minutes}${minutes === 1 ? '' : ''}m ago`
  } else if (hours < 24) {
    return `${hours}${hours === 1 ? '' : ''}h ago`
  } else if (days < 7) {
    return `${days}${days === 1 ? '' : ''}d ago`
  } else {
    // For older dates, show formatted date
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(timestamp))
  }
}

/**
 * Format a timestamp with both relative and absolute time
 */
export function formatTimestampWithRelative(timestamp: number): {
  relative: string
  absolute: string
} {
  return {
    relative: formatRelativeTime(timestamp),
    absolute: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(timestamp)),
  }
}
