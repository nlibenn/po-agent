/**
 * Email Text Normalization Utility
 * 
 * Normalizes email text to ensure compatibility with email systems:
 * - Forces UTF-8 normalization (NFC form)
 * - Replaces smart punctuation with ASCII equivalents
 * - Removes malformed Latin-1 artifacts
 */

/**
 * Normalize email text for safe transmission via email APIs
 * 
 * @param text - The text to normalize
 * @returns Normalized text safe for email transmission
 */
export function normalizeEmailText(text: string): string {
  if (!text) return text

  // Step 1: Force UTF-8 normalization (NFC form)
  // NFC (Canonical Composition) is the most compatible form
  let normalized = text.normalize('NFC')

  // Step 2: Replace smart punctuation with ASCII equivalents
  const smartPunctuationMap: Record<string, string> = {
    // Smart quotes
    '\u2018': "'", // Left single quotation mark
    '\u2019': "'", // Right single quotation mark
    '\u201C': '"', // Left double quotation mark
    '\u201D': '"', // Right double quotation mark
    '\u201E': '"', // Double low-9 quotation mark
    '\u2032': "'", // Prime (minutes)
    '\u2033': '"', // Double prime (seconds)
    
    // Dashes
    '\u2013': '-', // En dash
    '\u2014': '-', // Em dash
    '\u2015': '-', // Horizontal bar
    '\u2212': '-', // Minus sign
    
    // Ellipsis
    '\u2026': '...', // Horizontal ellipsis
    
    // Other common smart punctuation
    '\u2022': '*', // Bullet
    '\u00A0': ' ', // Non-breaking space -> regular space
    '\u2009': ' ', // Thin space -> regular space
    '\u200A': ' ', // Hair space -> regular space
    '\u200B': '',  // Zero-width space -> remove
    '\u200C': '',  // Zero-width non-joiner -> remove
    '\u200D': '',  // Zero-width joiner -> remove
    '\uFEFF': '',  // Zero-width no-break space -> remove
  }

  // Replace smart punctuation
  normalized = normalized.replace(/[\u2018\u2019\u201C\u201D\u201E\u2032\u2033\u2013\u2014\u2015\u2212\u2026\u2022\u00A0\u2009\u200A\u200B\u200C\u200D\uFEFF]/g, (char) => {
    return smartPunctuationMap[char] || char
  })

  // Step 3: Remove malformed Latin-1 artifacts and control characters
  // These are often caused by incorrect encoding conversions
  // Remove control characters except common whitespace (tab, newline, carriage return)
  // Control characters: \x00-\x1F except \x09 (tab), \x0A (newline), \x0D (carriage return)
  normalized = normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

  // Remove DEL and extended control characters (often from Latin-1 encoding issues)
  normalized = normalized.replace(/[\x7F-\x9F]/g, '')

  // Remove invalid UTF-8 sequences that might appear as replacement characters
  normalized = normalized.replace(/\uFFFD/g, '') // Replacement character

  // Replace any remaining problematic Unicode whitespace with regular space
  // This handles various Unicode space characters that might cause issues
  normalized = normalized.replace(/[\u2000-\u200A\u2028\u2029\u202F\u205F]/g, ' ')

  return normalized
}
