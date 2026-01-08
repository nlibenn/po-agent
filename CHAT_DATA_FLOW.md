# Current Chat Data Flow Analysis

## 1. React Chat Component
**File**: `components/CompanionChat.tsx`
- Sends messages via `sendMessage()` function
- Two modes:
  - **Case-scoped** (line 156-234): Calls `/api/resolve` with context
  - **Global** (line 236-260): Uses deterministic `getGlobalAnswer()` - NO API call

## 2. API Route
**File**: `app/api/resolve/route.ts`
- Only handles case-scoped questions
- Receives: `case`, `supplier_history`, `part_history`, `similar_lines`, `user_message`
- Does NOT receive full CSV dataset
- Does NOT handle global questions

## 3. CSV Upload & Storage
**File**: `app/page.tsx` (lines 34-80)
- Parses CSV using PapaParse
- Stores in `sessionStorage`:
  - Key: `'po_rows'` - JSON string of parsed rows
  - Key: `'po_filename'` - filename string
- Data structure: `Record<string, any>[]` (raw CSV rows as objects)

## 4. Current Access to CSV Data

### Case-Scoped Mode:
✅ **HAS ACCESS**: 
- Reads from `sessionStorage.getItem('po_rows')`
- Normalizes rows using `normalizeRow()`
- Sends filtered context (supplier_history, part_history, similar_lines) to API
- API receives context but NOT full dataset

### Global Mode:
❌ **NO API ACCESS**:
- Reads from `sessionStorage.getItem('po_rows')`
- Uses deterministic `getGlobalAnswer()` function
- Does NOT call API
- Cannot answer questions grounded in full dataset

## Why Chat Doesn't Have Full Dataset Access:

1. **Global mode doesn't call API** - uses hardcoded deterministic answers
2. **API is server-side** - cannot access client's sessionStorage
3. **Case-scoped mode** only sends filtered context, not full dataset
4. **No API route exists** for global questions with full dataset

## Required Changes:

1. Create `/api/chat` route for global questions OR extend `/api/resolve`
2. Update global mode to call API with:
   - Small datasets (< 100 rows): send all normalized rows
   - Large datasets: send exceptions + schema summary
3. Add system prompt requiring citations (po_id/line_id)
4. Update existing `/api/resolve` prompt to require citations
