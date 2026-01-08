# Exception Detection Logic Changes

## Summary
Refactored exception detection to allow "Interpretation risk" (UOM_AMBIGUITY) to work on both open and closed PO lines, while keeping in-flight exceptions (LATE_PO, PARTIAL_OPEN, ZOMBIE_PO) gated to open lines only.

## Files Changed

1. **src/lib/po.ts**
   - Modified `deriveExceptions()` function
   - Removed global `line_open` check that blocked all exception detection on closed lines
   - Added rule-specific `line_open` checks for LATE_PO, PARTIAL_OPEN, and ZOMBIE_PO
   - Removed `line_open` requirement from UOM_AMBIGUITY detection

2. **src/lib/po.test-runner.ts** (NEW)
   - Simple test harness to verify the behavior
   - Tests closed lines with dimensional descriptions
   - Tests open lines with multiple conditions
   - Verifies priority ordering

## Before/After Behavior

### Before:
- ❌ All exception detection was blocked for closed lines (`line_open == false`)
- ❌ Closed lines with dimensional descriptions never got UOM_AMBIGUITY exceptions
- ❌ Interpretation risk badge never appeared on closed lines

### After:
- ✅ Closed lines with dimensional descriptions now get UOM_AMBIGUITY exceptions
- ✅ Interpretation risk badge appears on closed lines when description has dimensional language
- ✅ In-flight exceptions (LATE_PO, PARTIAL_OPEN, ZOMBIE_PO) still only apply to open lines
- ✅ Priority ordering preserved: LATE_PO > PARTIAL_OPEN > ZOMBIE_PO > UOM_AMBIGUITY
- ✅ Interpretation risk badge works independently and can appear alongside any exception type

## Rule-Specific Eligibility

| Exception Type | Requires `line_open == true`? | Other Requirements |
|---------------|------------------------------|-------------------|
| LATE_PO | ✅ Yes | `due_date < today` AND `receipt_date` is empty |
| PARTIAL_OPEN | ✅ Yes | `receipt_date` exists and is non-empty |
| ZOMBIE_PO | ✅ Yes | `due_date < today - 60 days` |
| UOM_AMBIGUITY | ❌ No | `description` exists, is non-empty, and contains dimensional language |

## Testing

Run the test harness:
```bash
npx ts-node src/lib/po.test-runner.ts
```

Or compile and run:
```bash
tsc src/lib/po.test-runner.ts && node src/lib/po.test-runner.js
```

## Key Points

1. **No UI changes required** - The existing badge logic already works independently via `detectUoMAmbiguity()`
2. **Backward compatible** - Open lines behave exactly as before
3. **Pre-release use case** - Closed/draft lines can now be flagged for measurement notation issues before release
4. **Minimal code change** - Only modified the eligibility checks in `deriveExceptions()`
