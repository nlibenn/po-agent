# Chat Grounding Implementation Summary

## Changes Made

### 1. Created New API Route for Global Chat
**File**: `app/api/chat/route.ts` (NEW)
- Handles global questions about the full CSV dataset
- Accepts either:
  - Small datasets (< 100 rows): receives all normalized rows
  - Large datasets (≥ 100 rows): receives exceptions + schema summary
- System prompt requires citing specific `po_id` and `line_id` when referencing data
- Uses GPT-4o-mini with temperature 0.2 for consistent, grounded responses

### 2. Updated Existing API Route
**File**: `app/api/resolve/route.ts`
- Added citation requirement to system prompt
- Now requires citing specific `po_id`/`line_id` when referencing context data
- Maintains existing functionality for case-scoped questions

### 3. Updated Chat Component
**File**: `components/CompanionChat.tsx`
- **Global mode** now calls `/api/chat` instead of using deterministic `getGlobalAnswer()`
- Implements smart data selection:
  - Small datasets (< 100 rows): sends all normalized rows
  - Large datasets (≥ 100 rows): sends only exceptions + schema summary
- Removed unused `getGlobalAnswer()` function
- Maintains case-scoped mode (calls `/api/resolve` as before)

## Data Flow After Changes

### Global Mode (New):
1. User asks question in global chat
2. Component reads `sessionStorage.getItem('po_rows')`
3. Normalizes rows using `normalizeRow()`
4. If < 100 rows: sends all rows to `/api/chat`
5. If ≥ 100 rows: derives exceptions, sends exceptions + schema summary to `/api/chat`
6. API responds with grounded answer citing specific `po_id`/`line_id`

### Case-Scoped Mode (Unchanged):
1. User asks question on exception detail page
2. Component reads `sessionStorage.getItem('po_rows')`
3. Normalizes rows and filters context (supplier_history, part_history, similar_lines)
4. Sends filtered context to `/api/resolve`
5. API responds with grounded answer citing specific `po_id`/`line_id`

## Key Features

✅ **Grounded in CSV data**: All answers reference actual uploaded data
✅ **Citations required**: System prompts enforce citing `po_id`/`line_id`
✅ **Handles large datasets**: Sends only exceptions + summary for datasets ≥ 100 rows
✅ **No UI changes**: Existing chat interface works as before
✅ **Backward compatible**: Case-scoped mode unchanged

## System Prompt Requirements

Both API routes now require:
- Citing specific `po_id` and `line_id` when referencing data
- Not fabricating data or inventing po_id/line_id values
- Explicitly stating when information is missing
- Grounding all claims in provided data

## Testing

To test:
1. Upload a CSV file
2. Ask global questions like:
   - "How many exceptions are there?"
   - "Which suppliers have the most issues?"
   - "Show me all late POs"
3. Verify answers cite specific `po_id`/`line_id` from your data
4. Test with both small (< 100 rows) and large (≥ 100 rows) datasets
