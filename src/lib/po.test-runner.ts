/**
 * Simple test harness for PO exception detection
 * Run with: npx ts-node src/lib/po.test-runner.ts
 * Or compile and run: tsc src/lib/po.test-runner.ts && node src/lib/po.test-runner.js
 */

import { normalizeRow, deriveExceptions, detectUoMAmbiguity } from './po'

interface TestResult {
  name: string
  passed: boolean
  error?: string
}

function runTest(name: string, testFn: () => void): TestResult {
  try {
    testFn()
    return { name, passed: true }
  } catch (error) {
    return { 
      name, 
      passed: false, 
      error: error instanceof Error ? error.message : String(error) 
    }
  }
}

function expect(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message)
  }
}

function expectEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`)
  }
}

function expectLength<T>(array: T[], length: number, message?: string) {
  if (array.length !== length) {
    throw new Error(message || `Expected array length ${length}, got ${array.length}`)
  }
}

const today = new Date('2024-04-20')
today.setHours(0, 0, 0, 0)

const tests: TestResult[] = []

// Test 1: Closed line with dimensional description
tests.push(runTest('Closed line with dimensional description gets UOM_AMBIGUITY', () => {
  const rawRow = {
    po_id: 'PO-001',
    line_id: '1',
    supplier_name: 'Test Supplier',
    description: 'Steel plate 10x20x5mm',
    line_open: false,
    order_qty: 100,
    due_date: '2024-04-15',
    receipt_date: '2024-04-18',
  }

  const normalized = normalizeRow(rawRow)
  const exceptions = deriveExceptions([normalized], today)

  expectLength(exceptions, 1, 'Should have exactly one exception')
  expectEqual(exceptions[0].exception_type, 'UOM_AMBIGUITY', 'Should be UOM_AMBIGUITY, not LATE_PO/PARTIAL_OPEN/ZOMBIE_PO')
  expectEqual(exceptions[0].po_id, 'PO-001')
  expectEqual(exceptions[0].line_id, '1')
}))

// Test 2: Open line with receipt and dimensional description
tests.push(runTest('Open line with receipt gets PARTIAL_OPEN and Interpretation risk', () => {
  const rawRow = {
    po_id: 'PO-002',
    line_id: '1',
    supplier_name: 'Test Supplier',
    description: 'Pipe 50mm diameter x 2m length',
    line_open: true,
    order_qty: 50,
    due_date: '2024-04-10',
    receipt_date: '2024-04-12',
  }

  const normalized = normalizeRow(rawRow)
  const exceptions = deriveExceptions([normalized], today)

  expectLength(exceptions, 1, 'Should have exactly one exception')
  expectEqual(exceptions[0].exception_type, 'PARTIAL_OPEN', 'Should be PARTIAL_OPEN (higher priority)')
  
  const hasUoMRisk = detectUoMAmbiguity(exceptions[0].rowData.description)
  expect(hasUoMRisk, 'Should have Interpretation risk badge')
}))

// Test 3: Closed line without dimensional description
tests.push(runTest('Closed line without dimensional description gets no exceptions', () => {
  const rawRow = {
    po_id: 'PO-003',
    line_id: '1',
    supplier_name: 'Test Supplier',
    description: 'Standard widget',
    line_open: false,
    order_qty: 100,
    due_date: '2024-04-15',
    receipt_date: '2024-04-18',
  }

  const normalized = normalizeRow(rawRow)
  const exceptions = deriveExceptions([normalized], today)

  expectLength(exceptions, 0, 'Should have no exceptions')
}))

// Test 4: Open line with late delivery and dimensional description
tests.push(runTest('Open line with late delivery gets LATE_PO, not UOM_AMBIGUITY', () => {
  const rawRow = {
    po_id: 'PO-004',
    line_id: '1',
    supplier_name: 'Test Supplier',
    description: 'Steel plate 10x20x5mm',
    line_open: true,
    order_qty: 100,
    due_date: '2024-04-15',
    receipt_date: '',
  }

  const normalized = normalizeRow(rawRow)
  const exceptions = deriveExceptions([normalized], today)

  expectLength(exceptions, 1, 'Should have exactly one exception')
  expectEqual(exceptions[0].exception_type, 'LATE_PO', 'Should be LATE_PO (highest priority)')
  
  const hasUoMRisk = detectUoMAmbiguity(exceptions[0].rowData.description)
  expect(hasUoMRisk, 'Should still have Interpretation risk badge')
}))

// Test 5: Closed line with empty description
tests.push(runTest('Closed line with empty description gets no exceptions', () => {
  const rawRow = {
    po_id: 'PO-005',
    line_id: '1',
    supplier_name: 'Test Supplier',
    description: '',
    line_open: false,
    order_qty: 100,
  }

  const normalized = normalizeRow(rawRow)
  const exceptions = deriveExceptions([normalized], today)

  expectLength(exceptions, 0, 'Should have no exceptions')
}))

// Print results
console.log('\n=== PO Exception Detection Tests ===\n')
let passed = 0
let failed = 0

tests.forEach(test => {
  if (test.passed) {
    console.log(`✓ ${test.name}`)
    passed++
  } else {
    console.log(`✗ ${test.name}`)
    if (test.error) {
      console.log(`  Error: ${test.error}`)
    }
    failed++
  }
})

console.log(`\nResults: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
} else {
  console.log('\nAll tests passed! ✓')
  process.exit(0)
}
