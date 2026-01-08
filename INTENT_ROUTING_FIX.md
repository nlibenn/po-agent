# Intent Routing Fix for Chat Assistant

## Problem
The assistant was always responding with the highest-priority operational exception, even when users asked about interpretation risk (UoM/measurement issues). For example:
- User asks: "What's the unit of measure issue?"
- Assistant responds: "Line remains open after receipt posted" (operational exception)
- Missing: Description evidence and measurement analysis

## Solution
Added intent detection and routing to answer the user's actual question.

## Changes Made

### 1. Intent Detection Function
**File**: `app/api/resolve/route.ts`

Added `detectIntent()` function that analyzes user message keywords:

**INTERPRETATION_RISK keywords:**
- 'uom', 'unit of measure', 'unit', 'measurement', 'dimension', 'dimensions'
- 'spec', 'description', 'x', 'inch', 'in', 'ft', 'feet', '"'

**OPERATIONAL_EXCEPTION keywords:**
- 'open', 'close', 'receipt', 'received', 'overdue', 'late', 'due'

**Priority**: If both keyword sets are present, interpretation risk takes priority.

### 2. Intent-Specific System Prompts

#### INTERPRETATION_RISK Prompt:
- First line MUST be: "PO-[po_id] L[line_id]: Possible interpretation risk from description measurements."
- Evidence MUST include description field (truncated to ~80 chars)
- Optionally include: order_qty, unit_price, or explicit UoM fields
- Do NOT mention operational status (open/close/receipt) unless user explicitly asked

#### OPERATIONAL_EXCEPTION Prompt:
- Keeps current behavior
- Focuses on operational issues (line open, late delivery, receipt status)
- Includes dates, quantities, and status fields

### 3. Response Format (Both Intents)

Maintains strict contract:
- ≤90 words total
- Max 4 bullet points
- Format: Diagnosis → Evidence → Next step

## Example Responses

### INTERPRETATION_RISK Intent:
**User asks**: "What's the unit of measure issue?"

**Response**:
```
PO-907162 L1: Possible interpretation risk from description measurements.
• description: Steel plate 10x20x5mm - unclear if quantity is per piece or per dimension
• order_qty: 500
Confirm unit basis (per piece vs per square foot) before release.
```

### OPERATIONAL_EXCEPTION Intent:
**User asks**: "Why is this line still open?"

**Response**:
```
PO-907162 L1: Line remains open after receipt posted.
• Receipt date: 4/17/24
• Order quantity: 500
Confirm remaining quantity with supplier and close line if complete.
```

## Key Features

✅ **Intent-aware routing**: Detects what the user is actually asking about
✅ **Focused responses**: Answers the question, not just the highest-priority exception
✅ **Description evidence**: Always includes description field for interpretation risk questions
✅ **No false claims**: Doesn't mention operational status when asked about measurements
✅ **Maintains contract**: Still ≤90 words, max 4 bullets

## Testing

To verify:
1. Ask about UoM/measurements → Should focus on description, not operational status
2. Ask about open/receipt → Should focus on operational status
3. Ask ambiguous question → Defaults to operational exception
4. Verify responses are ≤90 words and cite specific fields
