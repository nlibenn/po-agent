# INTERPRETATION_RISK Final Polish

## Changes Made

Updated the INTERPRETATION_RISK template in `/app/api/resolve/route.ts` with final polish:

### 1. Standardized First Line

**Before**: First line could vary with explanation embedded.

**After**: First line always uses exact standard title:
```
PO-[po_id] L[line_id]: Possible interpretation risk from description measurements.
```

### 2. Fixed order_qty Explanation

**Before**: Claimed "order_qty is a count" (incorrect for fractional quantities).

**After**: Uses accurate wording:
```
...while order_qty isn't explicitly tied to a unit (piece vs length vs weight).
```

This correctly handles both integer and fractional quantities.

## Response Format

The response now follows this exact structure:

1. **First line** (standard title): `PO-[po_id] L[line_id]: Possible interpretation risk from description measurements.`
2. **Explanation sentence**: Explains that dimensional notation could be interpreted as per-piece vs per-length vs per-weight, while order_qty isn't explicitly tied to a unit.
3. **Evidence bullets** (2-3 max): Description field (truncated to ~80 chars), optionally order_qty, unit_price, or explicit UoM fields.
4. **Next step** (single sentence): Confirm which unit unit_price applies to and how supplier interprets quantity.

## Example Response

**User asks**: "What's the unit of measure issue?"

**Response**:
```
PO-907162 L1: Possible interpretation risk from description measurements.
Dimensional notation in description could be interpreted as per-piece vs per-length vs per-weight, while order_qty isn't explicitly tied to a unit (piece vs length vs weight).
• description: Steel plate 10x20x5mm
• order_qty: 500
• unit_price: $25.00
Confirm which unit unit_price applies to (per piece vs per length/weight) and how supplier interprets quantity.
```

## Key Improvements

✅ **Standardized title**: First line always uses exact standard format
✅ **Accurate order_qty language**: Handles both integer and fractional quantities correctly
✅ **Maintains contract**: Still ≤90 words, max 4 bullet points
✅ **Clear structure**: Title → Explanation → Evidence → Next step
