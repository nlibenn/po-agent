/**
 * Unit tests for PO exception detection logic
 * Tests the refactored logic that allows UOM_AMBIGUITY on closed lines
 */

import { normalizeRow, deriveExceptions, detectUoMAmbiguity } from './po'

describe('Exception Detection - Pre-release risks on closed lines', () => {
  const today = new Date('2024-04-20')
  today.setHours(0, 0, 0, 0)

  describe('Closed line with dimensional description', () => {
    it('should get Interpretation risk (UOM_AMBIGUITY) but NOT in-flight exceptions', () => {
      const rawRow = {
        po_id: 'PO-001',
        line_id: '1',
        supplier_name: 'Test Supplier',
        description: 'Steel plate 10x20x5mm',
        line_open: false, // Closed line
        order_qty: 100,
        due_date: '2024-04-15',
        receipt_date: '2024-04-18',
      }

      const normalized = normalizeRow(rawRow)
      const exceptions = deriveExceptions([normalized], today)

      // Should have exactly one exception
      expect(exceptions.length).toBe(1)
      
      // Should be UOM_AMBIGUITY, not LATE_PO/PARTIAL_OPEN/ZOMBIE_PO
      expect(exceptions[0].exception_type).toBe('UOM_AMBIGUITY')
      expect(exceptions[0].po_id).toBe('PO-001')
      expect(exceptions[0].line_id).toBe('1')
    })
  })

  describe('Open line with dimensional description and receipt', () => {
    it('should get PARTIAL_OPEN as exception_type AND Interpretation risk badge', () => {
      const rawRow = {
        po_id: 'PO-002',
        line_id: '1',
        supplier_name: 'Test Supplier',
        description: 'Pipe 50mm diameter x 2m length',
        line_open: true, // Open line
        order_qty: 50,
        due_date: '2024-04-10',
        receipt_date: '2024-04-12', // Receipt posted
      }

      const normalized = normalizeRow(rawRow)
      const exceptions = deriveExceptions([normalized], today)

      // Should have exactly one exception
      expect(exceptions.length).toBe(1)
      
      // Should be PARTIAL_OPEN (higher priority than UOM_AMBIGUITY)
      expect(exceptions[0].exception_type).toBe('PARTIAL_OPEN')
      
      // But should still have Interpretation risk (checked via detectUoMAmbiguity)
      const hasUoMRisk = detectUoMAmbiguity(exceptions[0].rowData.description)
      expect(hasUoMRisk).toBe(true)
    })
  })

  describe('Closed line without dimensional description', () => {
    it('should NOT get any exceptions', () => {
      const rawRow = {
        po_id: 'PO-003',
        line_id: '1',
        supplier_name: 'Test Supplier',
        description: 'Standard widget',
        line_open: false, // Closed line
        order_qty: 100,
        due_date: '2024-04-15',
        receipt_date: '2024-04-18',
      }

      const normalized = normalizeRow(rawRow)
      const exceptions = deriveExceptions([normalized], today)

      // Should have no exceptions
      expect(exceptions.length).toBe(0)
    })
  })

  describe('Open line with late delivery', () => {
    it('should get LATE_PO, not UOM_AMBIGUITY, even if description has dimensions', () => {
      const rawRow = {
        po_id: 'PO-004',
        line_id: '1',
        supplier_name: 'Test Supplier',
        description: 'Steel plate 10x20x5mm',
        line_open: true, // Open line
        order_qty: 100,
        due_date: '2024-04-15', // Past due
        receipt_date: '', // No receipt
      }

      const normalized = normalizeRow(rawRow)
      const exceptions = deriveExceptions([normalized], today)

      // Should have exactly one exception
      expect(exceptions.length).toBe(1)
      
      // Should be LATE_PO (highest priority)
      expect(exceptions[0].exception_type).toBe('LATE_PO')
      
      // But should still have Interpretation risk (checked via detectUoMAmbiguity)
      const hasUoMRisk = detectUoMAmbiguity(exceptions[0].rowData.description)
      expect(hasUoMRisk).toBe(true)
    })
  })

  describe('Closed line with empty description', () => {
    it('should NOT get UOM_AMBIGUITY', () => {
      const rawRow = {
        po_id: 'PO-005',
        line_id: '1',
        supplier_name: 'Test Supplier',
        description: '', // Empty description
        line_open: false,
        order_qty: 100,
      }

      const normalized = normalizeRow(rawRow)
      const exceptions = deriveExceptions([normalized], today)

      // Should have no exceptions
      expect(exceptions.length).toBe(0)
    })
  })
})
