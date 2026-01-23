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

// Fixture 1: explicit Qty label with expectedQty provided
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
    expectedQty: 240, // Must provide expectedQty - no guessing allowed
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
    expectedQty: 240, // Must provide expectedQty - no guessing allowed
  })

  expect(parsed.supplier_order_number.value).toBe('907255-A')
  expect(parsed.confirmed_delivery_date.value).toBe('2026-01-18')
  expect(parsed.confirmed_quantity.value).toBe(240)
  // implied table parsing should be lower confidence than labeled qty, but > 0
  expect(parsed.confirmed_quantity.confidence).toBeGreaterThan(0.45)
})
if (t2) passed++; else failed++

// Fixture 3: Label-aware date extraction (Confirmed Ship Date vs Order Date)
const t3 = test('prefers Confirmed Ship Date over Order Date', () => {
  const pdfText = `
    SALES ORDER ACKNOWLEDGEMENT
    Order Date 10/25/2025
    Confirmed Ship Date 11/08/2025
    Customer PO: 907126
    Qty 140
    Total Weight: 6336 LBS
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: '907126',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-3', text: pdfText }],
    expectedQty: 140, // Must provide expectedQty - no guessing allowed
    debug: true,
  })

  // Should pick Confirmed Ship Date (11/08/2025), NOT Order Date (10/25/2025)
  expect(parsed.confirmed_delivery_date.value).toBe('2025-11-08')
  // Should pick Qty 140, NOT Total Weight 6336
  expect(parsed.confirmed_quantity.value).toBe(140)
  expect(parsed.evidence_source).toBe('pdf')
  
  // Debug candidates should be populated
  expect(parsed.debug_candidates).toBeTruthy()
  if (parsed.debug_candidates) {
    // Date candidates should include both, but Confirmed Ship Date should be first (highest priority)
    const dateCands = parsed.debug_candidates.dateCandidates
    expect(dateCands.length).toBeGreaterThan(0)
    // First date candidate should be from "Confirmed Ship Date"
    if (dateCands.length > 0) {
      const first = dateCands[0]
      if (first.label !== 'Confirmed Ship Date') {
        throw new Error(`Expected first date candidate to be 'Confirmed Ship Date', got '${first.label}'`)
      }
    }
    
    // Qty candidates: 140 should not be near weight unit
    // 6336 may or may not be found (depends on label matching), but if found, should be nearWeightUnit
    const qtyCands = parsed.debug_candidates.qtyCandidates
    const qty6336 = qtyCands.find(c => c.value === 6336)
    const qty140 = qtyCands.find(c => c.value === 140)
    // If 6336 is found (it may not be since "Total Weight" isn't a qty label), it should be nearWeightUnit
    if (qty6336 && !qty6336.nearWeightUnit) {
      throw new Error('Expected 6336 to be marked nearWeightUnit=true')
    }
    // 140 should be found and NOT marked as nearWeightUnit (it's on its own line with just "Qty")
    if (!qty140) {
      throw new Error('Expected to find qty candidate 140')
    }
    if (qty140.nearWeightUnit) {
      throw new Error('Expected 140 to be marked nearWeightUnit=false')
    }
  }
})
if (t3) passed++; else failed++

// Fixture 4: Complex PDF with multiple dates and quantities
const t4 = test('handles complex PDF with mixed labels correctly', () => {
  const pdfText = `
    Atlas Tube Sales Order Acknowledgement
    
    Order Date: 10/25/2025
    Ship Date: 11/05/2025
    Confirmed Delivery Date: 11/08/2025
    
    Line  Item        Description          Qty    UOM   Weight
    1     DOM-4500    4" DOM ROUND TUBE    140    EA    6,336 LBS
    
    Total Pieces: 140
    Total Weight: 6,336 LBS
    Total Length: 2,800 FT
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: 'PO-123',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-4', text: pdfText }],
    expectedQty: 140, // Must provide expectedQty - no guessing allowed
  })

  // Should prefer "Confirmed Delivery Date" over "Ship Date" and "Order Date"
  expect(parsed.confirmed_delivery_date.value).toBe('2025-11-08')
  // Should pick 140 (the line item qty), not 6336 (weight) or 2800 (length)
  expect(parsed.confirmed_quantity.value).toBe(140)
})
if (t4) passed++; else failed++

// Fixture 5: Dimension pattern exclusion
const t5 = test('excludes dimension/spec numbers like 20/24, A500, .120', () => {
  const pdfText = `
    SALES ORDER ACKNOWLEDGEMENT
    Qty Unit Price Extended
    1 18195 1.500 SQ X .120 X 20/24 A500
    
    Order Qty: 140 EA
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: '907126',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-5', text: pdfText }],
    expectedQty: 140,
    debug: true,
  })

  // Should pick 140 (the labeled qty), not 20, 24, 500, 120, or 18195
  expect(parsed.confirmed_quantity.value).toBe(140)
  expect(parsed.evidence_source).toBe('pdf')
  
  // Debug candidates should show excluded dimension numbers
  if (parsed.debug_candidates) {
    const excluded = parsed.debug_candidates.qtyCandidates.filter(c => c.excluded)
    // Some dimension numbers should be excluded
    const excludedValues = excluded.map(c => c.value)
    // 20 and 24 from "20/24" should be excluded as fractions
    // 500 from "A500" should be excluded as grade code
    // Note: they may or may not appear depending on label matching, but if they do, they should be excluded
  }
})
if (t5) passed++; else failed++

// Fixture 6: No match if expectedQty doesn't match any candidate
const t6 = test('returns null qty when expectedQty does not match any candidate', () => {
  const pdfText = `
    SALES ORDER ACKNOWLEDGEMENT
    Qty Unit Price Extended
    1 18195 1.500 SQ X .120 X 20/24 A500
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: '907126',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-6', text: pdfText }],
    expectedQty: 140, // Expected 140, but it's not in the text
    debug: true,
  })

  // Should return null because 140 is not found, and we don't want 20/24/500/etc.
  expect(parsed.confirmed_quantity.value).toBe(null)
  
  // Debug should show the reason
  if (parsed.debug_candidates) {
    expect(parsed.debug_candidates.qtyChosenReason.length).toBeGreaterThan(0)
  }
})
if (t6) passed++; else failed++

// Fixture 7: Returns correct qty when Qty 140 is explicitly present
const t7 = test('returns 140 when "Qty 140" is present and expectedQty=140', () => {
  const pdfText = `
    SALES ORDER ACKNOWLEDGEMENT
    
    Item: 18195 DOM ROUND TUBE 1.500 SQ X .120 X 20/24 A500
    
    Qty: 140 EA
    
    Ship Date: 11/08/2025
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: '907126',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-7', text: pdfText }],
    expectedQty: 140,
  })

  expect(parsed.confirmed_quantity.value).toBe(140)
})
if (t7) passed++; else failed++

// Fixture 8: NO GUESSING - returns null qty when expectedQty is not provided
const t8 = test('returns null qty when expectedQty is not provided (no guessing)', () => {
  const pdfText = `
    SALES ORDER ACKNOWLEDGEMENT
    
    Qty: 140 EA
    Order Qty: 140
    
    Ship Date: 11/08/2025
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: '907126',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-8', text: pdfText }],
    // NO expectedQty provided - should NOT guess
    debug: true,
  })

  // Should return null even though 140 is in the PDF
  expect(parsed.confirmed_quantity.value).toBe(null)
  expect(parsed.confirmed_quantity.confidence).toBe(0)
  
  // Debug should show the "no guessing" reason
  if (parsed.debug_candidates) {
    if (!parsed.debug_candidates.qtyChosenReason.includes('not guessing')) {
      throw new Error(`Expected qtyChosenReason to mention 'not guessing', got: ${parsed.debug_candidates.qtyChosenReason}`)
    }
  }
})
if (t8) passed++; else failed++

// Fixture 9: A500 should be excluded as alphanumeric spec token
const t9 = test('excludes 500 from "A500" as alphanumeric spec token', () => {
  const pdfText = `
    SALES ORDER ACKNOWLEDGEMENT
    Material Grade: A500
    Qty: 100 EA
  `

  const parsed = parseConfirmationFieldsV1({
    poNumber: '907126',
    lineId: '1',
    pdfTexts: [{ attachment_id: 'att-9', text: pdfText }],
    expectedQty: 100,
    debug: true,
  })

  // Should pick 100, not 500
  expect(parsed.confirmed_quantity.value).toBe(100)
  
  // Check that 500 is excluded if it appears in candidates
  if (parsed.debug_candidates) {
    const qty500 = parsed.debug_candidates.qtyCandidates.find(c => c.value === 500)
    if (qty500 && !qty500.excluded) {
      throw new Error('Expected 500 from A500 to be excluded as alphanumeric spec token')
    }
  }
})
if (t9) passed++; else failed++

console.log(`\nTests complete: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

