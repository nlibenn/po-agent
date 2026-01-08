# INTERPRETATION_RISK Response Template Polish

## Changes Made

Updated the INTERPRETATION_RISK system prompt in `/app/api/resolve/route.ts` to be more steel/procurement-relevant and avoid vague language.

### 1. Concrete Interpretation-Risk Explanation

**Before**: Generic "Possible interpretation risk from description measurements."

**After**: First line now includes concrete explanation:
- Mentions that dimensional notation (inches/quotes/dimensions) in the description **could** be interpreted as per-piece vs per-length vs per-weight
- Notes that order_qty is a count
- Uses "could" or "may" - does not claim certainty
- Avoids vague terms like "intended application"

**Example first line**:
```
PO-907162 L1: Dimensional notation in description could be interpreted as per-piece vs per-length vs per-weight, while order_qty is a count.
```

### 2. More Specific Next Step

**Before**: Generic "One actionable next step"

**After**: Specific instruction to:
- Confirm which unit the unit_price applies to (per piece vs per length/weight)
- Confirm how the supplier interprets the quantity

**Example next step**:
```
Confirm which unit unit_price applies to (per piece vs per length/weight) and how supplier interprets quantity.
```

### 3. Maintained Response Contract

- ≤90 words total
- Max 4 bullet points
- Format: Diagnosis → Evidence → Next step

## Example Response

**User asks**: "What's the unit of measure issue?"

**Response**:
```
PO-907162 L1: Dimensional notation in description could be interpreted as per-piece vs per-length vs per-weight, while order_qty is a count.
• description: Steel plate 10x20x5mm
• order_qty: 500
• unit_price: $25.00
Confirm which unit unit_price applies to (per piece vs per length/weight) and how supplier interprets quantity.
```

## Key Improvements

✅ **Concrete language**: Explains specific interpretation ambiguity (per-piece vs per-length vs per-weight)
✅ **Procurement-relevant**: Focuses on unit_price unit basis and quantity interpretation
✅ **No vague terms**: Removed "intended application" and similar vague language
✅ **Uncertainty language**: Uses "could" or "may" instead of claiming certainty
✅ **Specific next step**: Asks for confirmation of unit_price unit and quantity interpretation
