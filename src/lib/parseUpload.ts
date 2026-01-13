/**
 * File Upload Parsing Utilities
 * 
 * Handles parsing of CSV and Excel files into normalized PO rows.
 */

import Papa from 'papaparse'
import { normalizeRow, NormalizedPORow } from './po'

// Dynamic import for xlsx to avoid bundling in client
let XLSX: any = null
async function getXLSX() {
  if (!XLSX) {
    XLSX = await import('xlsx')
  }
  return XLSX
}

export interface ParseResult {
  rows: Record<string, any>[]
  normalizedRows: NormalizedPORow[]
}

/**
 * Required columns for PO data (flexible matching)
 */
const REQUIRED_COLUMNS = [
  ['po_id', 'po id', 'PO_ID', 'PO ID', 'poId', 'PO', 'po'],
  ['line_id', 'line id', 'LINE_ID', 'LINE ID', 'lineId', 'Line', 'line'],
]

/**
 * Check if a row has required columns
 */
function hasRequiredColumns(row: Record<string, any>): boolean {
  const rowKeys = Object.keys(row).map(k => k.toLowerCase().trim())
  
  for (const columnVariants of REQUIRED_COLUMNS) {
    const found = columnVariants.some(variant => 
      rowKeys.includes(variant.toLowerCase().trim())
    )
    if (!found) {
      return false
    }
  }
  
  return true
}

/**
 * Validate parsed rows
 */
export function validateRows(rows: Record<string, any>[]): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('File contains no data rows. Please ensure your file has at least one data row.')
  }

  // Check if at least one row has required columns
  const hasValidColumns = rows.some(row => hasRequiredColumns(row))
  
  if (!hasValidColumns) {
    throw new Error(
      'File is missing required columns. Please ensure your file includes:\n' +
      '- PO ID (or PO, po_id, etc.)\n' +
      '- Line ID (or Line, line_id, etc.)\n\n' +
      'Column names are case-insensitive and spaces/underscores are flexible.'
    )
  }
}

/**
 * Parse CSV file
 */
export async function parseCsv(file: File): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          const errorMessages = results.errors
            .map(e => e.message)
            .filter((msg, idx, arr) => arr.indexOf(msg) === idx) // unique
            .join(', ')
          reject(new Error(`CSV parsing errors: ${errorMessages}`))
          return
        }

        if (!results.data || results.data.length === 0) {
          reject(new Error('CSV file contains no data rows.'))
          return
        }

        resolve(results.data as Record<string, any>[])
      },
      error: (error) => {
        reject(new Error(`Failed to parse CSV: ${error.message}`))
      },
    })
  })
}

/**
 * Parse Excel file (.xlsx, .xls)
 */
export async function parseXlsx(file: File): Promise<Record<string, any>[]> {
  const xlsxLib = await getXLSX()
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    
    reader.onload = (e) => {
      try {
        const data = e.target?.result
        if (!data) {
          reject(new Error('Failed to read Excel file.'))
          return
        }

        const workbook = xlsxLib.read(data, { type: 'binary' })
        
        // Get first sheet
        const firstSheetName = workbook.SheetNames[0]
        if (!firstSheetName) {
          reject(new Error('Excel file contains no sheets.'))
          return
        }

        const worksheet = workbook.Sheets[firstSheetName]
        const rows = xlsxLib.utils.sheet_to_json(worksheet, { defval: null })
        
        if (!rows || rows.length === 0) {
          reject(new Error('Excel file contains no data rows.'))
          return
        }

        resolve(rows as Record<string, any>[])
      } catch (error) {
        reject(new Error(`Failed to parse Excel file: ${error instanceof Error ? error.message : 'Unknown error'}`))
      }
    }

    reader.onerror = () => {
      reject(new Error('Failed to read Excel file.'))
    }

    reader.readAsBinaryString(file)
  })
}

/**
 * Normalize parsed rows
 */
export function normalizeRows(rows: Record<string, any>[]): NormalizedPORow[] {
  return rows.map(row => normalizeRow(row))
}

/**
 * Parse and normalize a file based on its type
 */
export async function parseFile(file: File): Promise<ParseResult> {
  const fileExtension = file.name.split('.').pop()?.toLowerCase()
  
  let rows: Record<string, any>[]
  
  if (fileExtension === 'csv') {
    rows = await parseCsv(file)
  } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
    rows = await parseXlsx(file)
  } else {
    throw new Error(`Unsupported file type: .${fileExtension}. Please upload a .csv, .xlsx, or .xls file.`)
  }

  // Validate rows
  validateRows(rows)

  // Normalize rows
  const normalizedRows = normalizeRows(rows)

  return {
    rows,
    normalizedRows,
  }
}
