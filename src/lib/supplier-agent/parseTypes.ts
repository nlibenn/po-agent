/**
 * Parsed confirmation field shapes persisted to SQLite.
 *
 * These are stored as JSON strings in:
 * - attachments.parsed_fields_json (TEXT)
 * - attachments.parse_confidence_json (TEXT)
 */

export type Confidence = 'low' | 'med' | 'high'

export type ParsedConfirmationFields = {
  po_number?: string
  supplier_order_number?: string
  ship_date?: string // ISO date if possible
  delivery_date?: string // ISO date if possible
  confirmation_date?: string
}

export type ParsedConfirmationConfidence = {
  po_number?: { confidence: Confidence; snippet?: string }
  supplier_order_number?: { confidence: Confidence; snippet?: string }
  ship_date?: { confidence: Confidence; snippet?: string }
  delivery_date?: { confidence: Confidence; snippet?: string }
  confirmation_date?: { confidence: Confidence; snippet?: string }
}

// Minimal JSON Schemas (draft-07 compatible shape).
export const ConfidenceSchema = {
  type: 'string',
  enum: ['low', 'med', 'high'],
} as const

export const ParsedConfirmationFieldsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    po_number: { type: 'string' },
    supplier_order_number: { type: 'string' },
    ship_date: { type: 'string', description: 'ISO date if possible' },
    delivery_date: { type: 'string', description: 'ISO date if possible' },
    confirmation_date: { type: 'string' },
  },
} as const

export const ParsedConfirmationConfidenceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    po_number: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confidence: ConfidenceSchema,
        snippet: { type: 'string' },
      },
      required: ['confidence'],
    },
    supplier_order_number: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confidence: ConfidenceSchema,
        snippet: { type: 'string' },
      },
      required: ['confidence'],
    },
    ship_date: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confidence: ConfidenceSchema,
        snippet: { type: 'string' },
      },
      required: ['confidence'],
    },
    delivery_date: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confidence: ConfidenceSchema,
        snippet: { type: 'string' },
      },
      required: ['confidence'],
    },
    confirmation_date: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confidence: ConfidenceSchema,
        snippet: { type: 'string' },
      },
      required: ['confidence'],
    },
  },
} as const

