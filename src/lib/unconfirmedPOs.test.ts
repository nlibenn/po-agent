/**
 * Unit tests for getUnconfirmedPOs function
 * 
 * Simple test harness - can be run standalone or with a test framework
 * 
 * To run standalone:
 *   ts-node src/lib/unconfirmedPOs.test.ts
 * 
 * Or compile first:
 *   tsc src/lib/unconfirmedPOs.test.ts && node src/lib/unconfirmedPOs.test.js
 */

import { getUnconfirmedPOs } from './unconfirmedPOs'
import { NormalizedPORow } from './po'

// Simple test harness functions
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
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`)
      }
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

// Run tests
console.log('Running getUnconfirmedPOs tests...\n')

const today = new Date('2025-01-15')
today.setHours(12, 0, 0, 0) // Set to noon for consistent testing

let passed = 0
let failed = 0

// Test 1: receipt_date = "" and "N/A" are treated as missing
const test1 = test('receipt_date = "" and "N/A" are treated as missing', () => {
  const rows: NormalizedPORow[] = [
      {
        po_id: 'PO-001',
        line_id: '1',
        supplier_id: 'SUP-001',
        supplier_name: 'Test Supplier',
        part_num: 'PART-001',
        description: 'Test Part',
        order_qty: 10,
        unit_price: 100,
        line_open: true,
        receipt_date: '', // Empty string
        due_date: null,
        order_date: new Date('2025-01-10'),
        rawRow: {},
      },
      {
        po_id: 'PO-002',
        line_id: '1',
        supplier_id: 'SUP-001',
        supplier_name: 'Test Supplier',
        part_num: 'PART-002',
        description: 'Test Part 2',
        order_qty: 20,
        unit_price: 200,
        line_open: true,
        receipt_date: 'N/A', // Placeholder
        due_date: null,
        order_date: new Date('2025-01-11'),
        rawRow: {},
      },
    ]

  const result = getUnconfirmedPOs(rows, today)
  expect(result.length).toBe(2)
  expect(result[0].po_id).toBe('PO-001')
  expect(result[1].po_id).toBe('PO-002')
})
if (test1) passed++; else failed++;

// Test 2: receipt_date = "2025-01-02" excludes the row
const test2 = test('receipt_date = "2025-01-02" excludes the row', () => {
  const rows: NormalizedPORow[] = [
      {
        po_id: 'PO-001',
        line_id: '1',
        supplier_id: 'SUP-001',
        supplier_name: 'Test Supplier',
        part_num: 'PART-001',
        description: 'Test Part',
        order_qty: 10,
        unit_price: 100,
        line_open: true,
        receipt_date: '2025-01-02', // Valid receipt date
        due_date: null,
        order_date: new Date('2025-01-10'),
        rawRow: {},
      },
    ]

  const result = getUnconfirmedPOs(rows, today)
  expect(result.length).toBe(0)
})
if (test2) passed++; else failed++;

// Test 3: order_date missing excludes the row
const test3 = test('order_date missing excludes the row', () => {
  const rows: NormalizedPORow[] = [
      {
        po_id: 'PO-001',
        line_id: '1',
        supplier_id: 'SUP-001',
        supplier_name: 'Test Supplier',
        part_num: 'PART-001',
        description: 'Test Part',
        order_qty: 10,
        unit_price: 100,
        line_open: true,
        receipt_date: null, // No receipt date
        due_date: null,
        order_date: null, // Missing order_date
        rawRow: {},
      },
    ]

  const result = getUnconfirmedPOs(rows, today)
  expect(result.length).toBe(0)
})
if (test3) passed++; else failed++;

// Test 4: handles all placeholder values
const test4 = test('handles all placeholder values', () => {
  const placeholders = ['n/a', 'na', '-', 'null', 'none', '0']
    const rows: NormalizedPORow[] = placeholders.map((placeholder, idx) => ({
      po_id: `PO-${idx}`,
      line_id: '1',
      supplier_id: 'SUP-001',
      supplier_name: 'Test Supplier',
      part_num: 'PART-001',
      description: 'Test Part',
      order_qty: 10,
      unit_price: 100,
      line_open: true,
      receipt_date: placeholder,
      due_date: null,
      order_date: new Date('2025-01-10'),
      rawRow: {},
    }))

  const result = getUnconfirmedPOs(rows, today)
  expect(result.length).toBe(placeholders.length)
})
if (test4) passed++; else failed++;

// Test 5: case-insensitive placeholder matching
const test5 = test('case-insensitive placeholder matching', () => {
  const rows: NormalizedPORow[] = [
      {
        po_id: 'PO-001',
        line_id: '1',
        supplier_id: 'SUP-001',
        supplier_name: 'Test Supplier',
        part_num: 'PART-001',
        description: 'Test Part',
        order_qty: 10,
        unit_price: 100,
        line_open: true,
        receipt_date: 'N/A', // Uppercase
        due_date: null,
        order_date: new Date('2025-01-10'),
        rawRow: {},
      },
      {
        po_id: 'PO-002',
        line_id: '1',
        supplier_id: 'SUP-001',
        supplier_name: 'Test Supplier',
        part_num: 'PART-002',
        description: 'Test Part 2',
        order_qty: 20,
        unit_price: 200,
        line_open: true,
        receipt_date: 'NULL', // Uppercase
        due_date: null,
        order_date: new Date('2025-01-11'),
        rawRow: {},
      },
    ]

  const result = getUnconfirmedPOs(rows, today)
  expect(result.length).toBe(2)
})
if (test5) passed++; else failed++;

console.log(`\nTests complete: ${passed} passed, ${failed} failed`)

// Simple test harness for running without a test framework
if (typeof require !== 'undefined' && require.main === module) {
  console.log('\n--- Running additional standalone tests ---')
  
  // Test 1: Empty receipt_date
  const test1Rows: NormalizedPORow[] = [{
    po_id: 'PO-001',
    line_id: '1',
    supplier_id: 'SUP-001',
    supplier_name: 'Test Supplier',
    part_num: 'PART-001',
    description: 'Test Part',
    order_qty: 10,
    unit_price: 100,
    line_open: true,
    receipt_date: '',
    due_date: null,
    order_date: new Date('2025-01-10'),
    rawRow: {},
  }]
  const test1Result = getUnconfirmedPOs(test1Rows)
  console.log(`Test 1 (empty receipt_date): ${test1Result.length === 1 ? 'PASS' : 'FAIL'} - Expected 1, got ${test1Result.length}`)

  // Test 2: N/A receipt_date
  const test2Rows: NormalizedPORow[] = [{
    po_id: 'PO-002',
    line_id: '1',
    supplier_id: 'SUP-001',
    supplier_name: 'Test Supplier',
    part_num: 'PART-002',
    description: 'Test Part 2',
    order_qty: 20,
    unit_price: 200,
    line_open: true,
    receipt_date: 'N/A',
    due_date: null,
    order_date: new Date('2025-01-11'),
    rawRow: {},
  }]
  const test2Result = getUnconfirmedPOs(test2Rows)
  console.log(`Test 2 (N/A receipt_date): ${test2Result.length === 1 ? 'PASS' : 'FAIL'} - Expected 1, got ${test2Result.length}`)

  // Test 3: Valid receipt_date excludes row
  const test3Rows: NormalizedPORow[] = [{
    po_id: 'PO-003',
    line_id: '1',
    supplier_id: 'SUP-001',
    supplier_name: 'Test Supplier',
    part_num: 'PART-003',
    description: 'Test Part 3',
    order_qty: 30,
    unit_price: 300,
    line_open: true,
    receipt_date: '2025-01-02',
    due_date: null,
    order_date: new Date('2025-01-10'),
    rawRow: {},
  }]
  const test3Result = getUnconfirmedPOs(test3Rows)
  console.log(`Test 3 (valid receipt_date): ${test3Result.length === 0 ? 'PASS' : 'FAIL'} - Expected 0, got ${test3Result.length}`)

  // Test 4: Missing order_date excludes row
  const test4Rows: NormalizedPORow[] = [{
    po_id: 'PO-004',
    line_id: '1',
    supplier_id: 'SUP-001',
    supplier_name: 'Test Supplier',
    part_num: 'PART-004',
    description: 'Test Part 4',
    order_qty: 40,
    unit_price: 400,
    line_open: true,
    receipt_date: null,
    due_date: null,
    order_date: null,
    rawRow: {},
  }]
  const test4Result = getUnconfirmedPOs(test4Rows)
  console.log(`Test 4 (missing order_date): ${test4Result.length === 0 ? 'PASS' : 'FAIL'} - Expected 0, got ${test4Result.length}`)

  console.log('Tests complete!')
}
