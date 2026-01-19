/**
 * Unit tests for parseConfirmationFieldsV1 (heuristics, no LLM).
 *
 * Run (if you have ts-node):
 *   npx ts-node src/lib/supplier-agent/parseConfirmationFields.test.ts
 *
 * Or compile and run:
 *   npx tsc src/lib/supplier-agent/parseConfirmationFields.test.ts && node src/lib/supplier-agent/parseConfirmationFields.test.js
 */

import { parseConfirmationFieldsV1 } from './parseConfirmationFields'

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    return true
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`)
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`Expected truthy, got ${actual}`)
    },
    toBeGreaterThan: (n: number) => {
      if (!(typeof actual === 'number' && actual > n)) throw new Error(`Expected > ${n}, got ${actual}`)
    },
  }
}

console.log('Running parseConfirmationFieldsV1 tests...\n')

let passed = 0
let failed = 0

// Fixture 1: explicit Qty label
const t1 = test('extracts supplier order, delivery date, and labeled quantity', () => {
  const pdfText = `
    SALES ORDER CONFIRMATION
    Supplier Order No: SO-907255
    Delivery Date: 01/15/2026
    Qty: 240 EA
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: 'PO-123',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-1', text: pdfText }],
  })

  expect(parsed.supplier_order_number.value).toBe('SO-907255')
  expect(parsed.confirmed_delivery_date.value).toBe('2026-01-15')
  expect(parsed.confirmed_quantity.value).toBe(240)
  expect(parsed.supplier_order_number.confidence).toBeGreaterThan(0.6)
  expect(parsed.confirmed_quantity.confidence).toBeGreaterThan(0.7)
  expect(parsed.raw_excerpt).toBeTruthy()
})
if (t1) passed++; else failed++

// Fixture 2: implied qty in a table row (no "Qty:" label on the row itself)
const t2 = test('extracts implied quantity from table-ish rows', () => {
  const pdfText = `
    SALES ORDER CONFIRMATION
    Supplier Order Number: 907255-A
    Expected Delivery: 2026-01-18

    Line  Part        Description                 UOM   Unit Price  Amount
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00
    1     ABC-100     WIDGET, STANDARD            EA    12.50       3000.00

    Item Description Qty UOM Unit Price Amount
    1    WIDGET      240 EA  12.50      3000.00
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: 'PO-123',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-2', text: pdfText }],
  })

  expect(parsed.supplier_order_number.value).toBe('907255-A')
  expect(parsed.confirmed_delivery_date.value).toBe('2026-01-18')
  expect(parsed.confirmed_quantity.value).toBe(240)
  // implied table parsing should be lower confidence than labeled qty, but > 0
  expect(parsed.confirmed_quantity.confidence).toBeGreaterThan(0.45)
})
if (t2) passed++; else failed++

console.log(`\nTests complete: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

