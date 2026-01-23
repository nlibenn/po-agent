# Supplier Confirmations Agent Workflow - Complete Snapshot

## 1) TL;DR

**What works end-to-end:**
- ✅ Case creation/upsert for PO/line combinations
- ✅ Gmail inbox search for existing supplier confirmations with classification (FOUND_CONFIRMED, FOUND_INCOMPLETE, NOT_FOUND)
- ✅ Email draft generation for initial outreach and follow-ups
- ✅ Email send (new thread or reply) via Gmail API with demo recipient override
- ✅ PDF attachment retrieval from Gmail threads with content-based deduplication
- ✅ PDF text extraction using pdfjs-dist
- ✅ Field parsing from PDF text and email bodies (v1 heuristics)
- ✅ Manual field application UI (apply-updates endpoint)
- ✅ Case state tracking and event logging
- ✅ Confirmation records canonical store (confirmation_records table)
- ✅ UI workbench showing unconfirmed POs with last action status

**What's broken (compile/runtime):**
- ⚠️ No compile errors found (linter shows clean)
- ⚠️ No runtime blockers identified from code inspection

**What's missing:**
- ❌ No automated agent orchestration trigger (agentAckOrchestrator exists but no scheduled/cron integration)
- ❌ No webhook/email push handler for incoming supplier replies (manual inbox search only)
- ❌ No automated field extraction confidence scoring UI integration (parsing exists but UI may not show confidence)
- ❌ No bulk case creation API (only single case creation)
- ❌ No case archival/cleanup workflow for resolved cases

---

## 2) Current User Story + Definition of Done

**User Story:**
As a buyer, I need to confirm missing delivery information (delivery date, supplier order number, quantity) from suppliers for unconfirmed PO lines, so that I can track order fulfillment accurately.

**Definition of Done (inferred from code):**
1. ✅ Case exists for PO/line combination (auto-created or manual via `/api/confirmations/case/upsert`)
2. ✅ System searches Gmail inbox for existing supplier correspondence
3. ✅ If found confirmed → case marked CONFIRMED, no outreach sent (NO_OP)
4. ✅ If found incomplete → system replies in existing thread asking for remaining missing fields
5. ✅ If not found → system sends new email asking for all missing fields
6. ✅ Email sent persists as OUTBOUND message in DB
7. ✅ Supplier replies ingested as INBOUND messages (via Gmail API when thread retrieved)
8. ✅ PDF attachments from supplier replies extracted and text-extracted
9. ✅ Fields parsed from PDF text or email body (v1 heuristics)
10. ✅ Parsed fields can be manually applied via UI (`/api/confirmations/case/[caseId]/apply-updates`)
11. ✅ When `supplier_order_number` + `confirmed_ship_or_delivery_date` present → case marked CONFIRMED, status = RESOLVED
12. ✅ Confirmation data persists in `confirmation_records` table (canonical store)
13. ✅ UI shows last action status for each PO/line via `/api/confirmations/last-action`

**Acceptance Criteria (from code behavior):**
- Missing fields tracked as array: `["delivery_date", "supplier_reference", "quantity"]`
- Case state transitions: INBOX_LOOKUP → OUTREACH_SENT → WAITING → PARSED → RESOLVED
- Case status: STILL_AMBIGUOUS → CONFIRMED (when fully confirmed)
- Thread persistence: `thread_id` stored in `case.meta.thread_id`
- All email sends redirected to `supplierbart@gmail.com` in demo mode (hardcoded)

---

## 3) End-to-End Flow Diagram

```
UI ENTRYPOINTS:
├── /unconfirmed-pos (page.tsx)
│   ├── User clicks "Request Confirmation" button
│   │   └── Opens SupplierConfirmationDrawer component
│   │       ├── Calls GET /api/confirmations/last-action?poNumber=X&lineId=Y
│   │       ├── Calls POST /api/confirmations/case/upsert (creates case if missing)
│   │       ├── User clicks "Send" → POST /api/confirmations/send
│   │       └── User clicks "Draft Follow-up" → POST /api/confirmations/followup/draft
│   │
│   └── User views attachment/parsed fields
│       ├── Calls GET /api/confirmations/case/[caseId]
│       ├── Calls GET /api/confirmations/attachments/list?caseId=X
│       ├── Calls POST /api/confirmations/attachments/extract-text
│       ├── Calls POST /api/confirmations/parse-fields?caseId=X
│       └── Calls POST /api/confirmations/case/[caseId]/apply-updates

API ROUTES → DB WRITES/READS → GMAIL ACTIONS:
├── POST /api/confirmations/case/upsert
│   ├── DB: findCaseByPoLine(poNumber, lineId)
│   ├── DB: createCase() if not exists → INSERT INTO cases
│   └── Response: { caseId, case }
│
├── POST /api/confirmations/inbox-search
│   ├── DB: getCase(caseId)
│   ├── Gmail: searchInboxForConfirmation() → Gmail API messages.list + threads.get
│   ├── DB: addEvent(caseId, { event_type: 'INBOX_SEARCH_STARTED' })
│   ├── DB: updateCase(caseId, { meta: { thread_id } }) if found
│   └── Response: { classification, matchedThreadId, missingFields, topCandidates }
│
├── POST /api/confirmations/send
│   ├── DB: getCase(caseId)
│   ├── Conditional: If runInboxSearch → POST /api/confirmations/inbox-search (inline)
│   ├── Email generation: generateConfirmationEmail() (client-safe pure function)
│   ├── Gmail: sendNewEmail() OR sendReplyInThread() → Gmail API messages.send
│   │   └── DEMO OVERRIDE: all emails sent to supplierbart@gmail.com (hardcoded)
│   ├── DB: addMessage(caseId, { direction: 'OUTBOUND', ... }) → INSERT INTO messages
│   ├── DB: addEvent(caseId, { event_type: 'EMAIL_SENT' })
│   ├── DB: updateCase(caseId, { state: OUTREACH_SENT, meta: { thread_id, last_sent_at } })
│   └── Response: { ok: true, action: 'sent'|'REPLY_IN_THREAD'|'NO_OP', gmailMessageId, threadId }
│
├── POST /api/confirmations/attachments/retrieve
│   ├── Gmail: retrievePdfAttachmentsFromThread(threadId) → Gmail API attachments.get
│   ├── DB: addAttachment(message_id, { binary_data_base64, content_sha256, ... })
│   │   └── Idempotent: content_sha256 deduplication, ON CONFLICT handling
│   └── Response: { attachments: [...], inserted, reused, skipped }
│
├── POST /api/confirmations/attachments/extract-text
│   ├── DB: SELECT binary_data_base64 FROM attachments WHERE attachment_id IN (...)
│   ├── PDF: extractTextFromPdfBase64() → pdfjs-dist
│   ├── DB: UPDATE attachments SET text_extract = ? WHERE attachment_id = ?
│   └── Response: { results: [{ attachmentId, ok, extracted_length, scanned_like }] }
│
├── POST /api/confirmations/parse-fields
│   ├── DB: SELECT * FROM cases WHERE case_id = ?
│   ├── DB: SELECT text_extract FROM attachments WHERE message_id IN (SELECT message_id FROM messages WHERE case_id = ?)
│   ├── Parse: parseConfirmationFieldsV1() → heuristics (supplier_order_number, confirmed_delivery_date, confirmed_quantity)
│   ├── DB: INSERT OR UPDATE confirmation_extractions
│   ├── DB: UPDATE cases SET meta = { parsed_best_fields_v1: { ... } }
│   ├── DB: UPDATE attachments SET parsed_fields_json = ?, parse_confidence_json = ?
│   ├── DB: addEvent(caseId, { event_type: 'PARSE_RESULT' })
│   └── Response: { caseId, parsed: { supplier_order_number, confirmed_delivery_date, confirmed_quantity, evidence_source } }
│
├── POST /api/confirmations/case/[caseId]/apply-updates
│   ├── DB: getCase(caseId)
│   ├── Validation: checks manual_overrides in case.meta (prevents overwriting manually edited fields)
│   ├── DB: UPDATE cases SET missing_fields = [...], meta = { confirmation_fields_applied: { fields: {...}, signature } }
│   ├── DB: INSERT OR REPLACE INTO confirmation_records (canonical store update)
│   ├── DB: If hasSupplierOrder && hasShipOrDelivery → UPDATE cases SET status = CONFIRMED, state = RESOLVED
│   ├── DB: addEvent(caseId, { event_type: 'APPLY_UPDATES' })
│   └── Response: { ok: true, case: {...} }
│
├── GET /api/confirmations/case/[caseId]
│   ├── DB: getCase(caseId)
│   ├── DB: listEvents(caseId)
│   ├── DB: listMessages(caseId)
│   ├── DB: listAttachmentsForCase(caseId)
│   ├── DB: SELECT * FROM confirmation_extractions WHERE case_id = ?
│   └── Response: { case, events, messages, attachments, parsed_best_fields, parsed_best_fields_v1 }
│
└── GET /api/confirmations/last-action?poNumber=X&lineId=Y
    ├── DB: findCaseByPoLine(poNumber, lineId)
    ├── DB: listEvents(caseId)
    ├── Logic: getLastAction(events, poNumber) → analyzes event types to determine last action
    └── Response: { lastAction: { type, timestamp, ... }, formatted: "Sent email 2 days ago" }

UI UPDATES:
└── SupplierConfirmationDrawer component
    ├── Polls last-action status (periodic refresh)
    ├── Shows parsed fields from case.meta.parsed_best_fields_v1
    ├── Allows manual field edits (triggers apply-updates)
    └── Shows attachment list with extraction status
```

---

## 4) API Inventory Table

| Route | Method | Request Schema | Response Schema | Side Effects | Failure Modes |
|-------|--------|----------------|-----------------|--------------|---------------|
| `/api/confirmations/cases` | POST | `{ po_number: string, line_id: string, supplier_email?: string, supplier_domain?: string, supplier_name?: string, missing_fields: string[] }` | `{ success: boolean, caseId: string }` | DB: INSERT INTO cases | 400: Missing required fields; 500: SQL error |
| `/api/confirmations/case/upsert` | POST | `{ poNumber: string, lineId: string, supplierEmail: string, supplierName?: string, missingFields?: string[] }` | `{ caseId: string, case: SupplierChaseCase }` | DB: SELECT then INSERT INTO cases if not exists | 400: Missing poNumber/lineId/supplierEmail; 500: DB error |
| `/api/confirmations/case/[caseId]` | GET | `{ caseId: string }` (path param) | `{ case: SupplierChaseCase, events: SupplierChaseEvent[], messages: SupplierChaseMessage[], attachments: SupplierChaseAttachment[], parsed_best_fields: {...}, parsed_best_fields_v1: {...} }` | None (read-only) | 400: Missing caseId; 404: Case not found; 500: DB error |
| `/api/confirmations/case/[caseId]/apply-updates` | POST | `{ source: 'pdf' \| 'email', fields: { supplier_order_number?: { value: string, confidence?: number, attachment_id?: string }, confirmed_ship_or_delivery_date?: { value: string, ... }, confirmed_quantity?: { value: number, ... } } }` | `{ ok: boolean, case: SupplierChaseCase, skipped?: boolean, deduped?: boolean }` | DB: UPDATE cases (missing_fields, meta), INSERT OR REPLACE confirmation_records, addEvent('APPLY_UPDATES'); May transition to RESOLVED if fully confirmed | 400: Invalid source or missing caseId; 404: Case not found; 500: DB error |
| `/api/confirmations/inbox-search` | POST | `{ caseId: string, optionalKeywords?: string[], lookbackDays?: number }` | `{ classification: 'FOUND_CONFIRMED' \| 'FOUND_INCOMPLETE' \| 'NOT_FOUND', matchedThreadId?: string, matchedMessageIds: string[], extractedFields: {...}, missingFields: string[], topCandidates: Array<{ messageId, threadId, subject, from, to, date, score }> }` | Gmail: messages.list, threads.get; DB: updateCase(meta.thread_id), addEvent('INBOX_SEARCH_*') | 400: Missing caseId; 404: Case not found; 500: Gmail API error or DB error |
| `/api/confirmations/followup/draft` | POST | `{ caseId: string, threadId?: string, missingFields?: string[], poNumber?: string, lineId?: string, supplierName?: string, supplierEmail?: string }` | `{ ok: boolean, subject: string, body: string, missingFields: string[], contextSnippet?: string }` | None (pure function, no side effects) | 400: Missing/invalid caseId; 404: Case not found; 500: Internal error |
| `/api/confirmations/send` | POST | `{ caseId: string, poNumber?: string, lineId?: string, supplierEmail?: string, missingFields?: string[], supplierName?: string, optionalKeywords?: string[], runInboxSearch?: boolean, subject?: string, body?: string, intent?: string, forceSend?: boolean, threadId?: string }` | `{ ok: boolean, action: 'sent' \| 'REPLY_IN_THREAD' \| 'SEND_NEW' \| 'NO_OP', gmailMessageId?: string, threadId?: string, missingFieldsAsked: string[], searchResult?: {...} }` | Gmail: messages.send (new or reply); DB: addMessage(OUTBOUND), addEvent('EMAIL_SENT'), updateCase(state=OUTREACH_SENT, meta.thread_id) | 400: Missing required fields; 404: Case not found; 500: Gmail API error, DB error |
| `/api/confirmations/parse-fields` | POST | `{ caseId: string }` | `{ caseId: string, parsed: { supplier_order_number: { value: string \| null, confidence: number, source: 'email' \| 'pdf', ... }, confirmed_delivery_date: {...}, confirmed_quantity: {...}, evidence_source: 'email' \| 'pdf' \| 'mixed' \| 'none' } }` | DB: INSERT OR UPDATE confirmation_extractions, UPDATE cases.meta.parsed_best_fields_v1, UPDATE attachments.parsed_fields_json, addEvent('PARSE_RESULT') | 400: Missing caseId; 404: Case not found; 500: Parse error, DB error |
| `/api/confirmations/last-action` | GET | `?poNumber=string&lineId=string` | `{ lastAction: { type: string, timestamp: number, ... } \| null, formatted: string }` | None (read-only) | 400: Missing poNumber/lineId; 500: DB error |
| `/api/confirmations/attachments/list` | GET | `?caseId=string \| ?threadId=string` | `{ attachments: Array<{ attachment_id, message_id, thread_id, filename, mime_type, size_bytes, received_at, created_at, text_extract, extracted_length, scanned_like }> }` | None (read-only) | 400: Missing caseId or threadId; 500: DB error |
| `/api/confirmations/attachments/retrieve` | POST | `{ caseId: string, threadId?: string }` | `{ attachments: Array<{ attachment_id, message_id, thread_id, filename, mime_type, size_bytes, received_at, created_at, text_extract, extracted_length, scanned_like }>, inserted: number, reused: number, skipped: number }` | Gmail: messages.get, attachments.get; DB: addMessage(INBOUND), addAttachment() with content_sha256 dedup | 400: Missing caseId/threadId; 500: Gmail API error, DB error |
| `/api/confirmations/attachments/extract-text` | POST | `{ attachmentIds: string[] }` | `{ results: Array<{ attachmentId, ok: boolean, extracted_length: number, scanned_like: boolean, skipped: boolean, error?: string }> }` | DB: UPDATE attachments SET text_extract = ? WHERE attachment_id = ? | 400: Missing/invalid attachmentIds array; 500: PDF extraction error (per-attachment, doesn't abort whole request) |
| `/api/confirmations/attachments/parse` | POST | `{ threadId: string, poNumber?: string }` | `{ best: { supplier_order_number, confirmed_ship_date, confirmed_quantity, confirmed_uom, source_attachment_id, score, matched } \| null, tried: number, skipped_scanned: number, errors?: string[] }` | None (read-only, parses existing text_extract) | 400: Missing threadId; 500: Parse error |
| `/api/confirmations/attachments/[attachmentId]/download` | GET | `{ attachmentId: string }` (path param) | PDF binary (application/pdf) | None (read-only) | 400: Missing attachmentId; 404: Attachment not found or no binary data; 500: DB error |
| `/api/confirmations/records` | GET | `?poIds=string,string,...` | `Array<{ po_id, line_id, supplier_order_number, confirmed_ship_date, confirmed_quantity, confirmed_uom, source_type, source_message_id, source_attachment_id, updated_at }>` | None (read-only) | 400: Missing poIds; 500: DB error |
| `/api/confirmations/records/upsert` | POST | `{ po_id: string, line_id: string, supplier_order_number?: string, confirmed_ship_date?: string (ISO), confirmed_quantity?: number, confirmed_uom?: string, source_type: 'email_body' \| 'sales_order_confirmation' \| 'shipment_notice' \| 'invoice' \| 'manual', source_message_id?: string, source_attachment_id?: string }` | `{ ok: boolean, record: {...} }` | DB: INSERT OR REPLACE INTO confirmation_records | 400: Missing po_id/line_id/source_type or invalid source_type; 500: DB error |
| `/api/confirmations/records/bulk` | POST | `{ po_ids?: string[] } \| { keys?: Array<{ po_id: string, line_id: string }> }` | `{ records: Array<{...}>, recordsMap: Record<string, {...}> }` | None (read-only) | 400: Missing po_ids or keys; 500: DB error |
| `/api/confirmations/reset` | POST | `{ poNumber: string, lineId?: string }` | `{ ok: boolean, message: string, deletedCases: number }` | DB: DELETE FROM cases WHERE po_number = ? [AND line_id = ?] (CASCADE deletes events/messages/attachments) | 403: Not in demo mode or production; 400: Missing poNumber; 500: DB error |

---

## 5) Data Model

| Table | Source DDL | TS Type | Mismatches/Notes |
|-------|------------|---------|------------------|
| **cases** | `schema.sql:5-20` | `SupplierChaseCase` (types.ts:51-66) | ✅ Match: missing_fields stored as JSON string, parsed as array in TS; meta stored as JSON string, parsed as Record<string, any> |
| **events** | `schema.sql:23-32` | `SupplierChaseEvent` (types.ts:95-106) | ✅ Match: evidence_refs_json and meta_json stored as JSON strings, parsed as objects in TS |
| **messages** | `schema.sql:35-48` | `SupplierChaseMessage` (types.ts:68-80) | ✅ Match |
| **attachments** | `schema.sql:51-65` | `SupplierChaseAttachment` (types.ts:82-93) | ✅ Match: parsed_fields_json and parse_confidence_json stored as JSON strings, parsed as Record<string, any> in TS. Note: content_sha256, size_bytes added via migration (hasColumn checks in store.ts) |
| **confirmation_records** | `schema.sql:102-114` | None (inline types in route handlers) | ⚠️ No dedicated TS type; type inferred from DB queries in routes |
| **confirmation_extractions** | `schema.sql:122-138` | None (inline types in route handlers) | ⚠️ No dedicated TS type; type inferred from DB queries |
| **gmail_tokens** | `schema.sql:90-99` | None (used in gmail/tokenStore.ts) | ⚠️ Not part of supplier-agent types |

**Key Columns:**
- `cases.missing_fields`: JSON array of strings (e.g., `["delivery_date", "supplier_reference", "quantity"]`)
- `cases.state`: `CaseState` enum: INBOX_LOOKUP, OUTREACH_SENT, WAITING, PARSED, FOLLOWUP_SENT, RESOLVED, ESCALATED
- `cases.status`: `CaseStatus` enum: CONFIRMED, CONFIRMED_WITH_RISK, UNRESPONSIVE, NEEDS_BUYER, STILL_AMBIGUOUS
- `cases.meta`: JSON object containing `thread_id`, `parsed_best_fields_v1`, `confirmation_fields_applied`, `manual_overrides`, `last_sent_message_id`, etc.
- `attachments.content_sha256`: Used for content-based deduplication (global unique index)
- `attachments.size_bytes`: Computed from binary_data_base64 length (approximate)
- `confirmation_records`: Primary key on (po_id, line_id) - canonical store for confirmation data
- `confirmation_extractions`: One row per case_id (UNIQUE constraint) - stores parsed fields from evidence

---

## 6) State Machine

**Case States (CaseState enum):**
1. `INBOX_LOOKUP` → Initial state when case created
2. `OUTREACH_SENT` → Email sent (new or reply)
3. `WAITING` → Waiting for supplier response
4. `PARSED` → Evidence parsed (PDF text extracted, fields parsed)
5. `FOLLOWUP_SENT` → Follow-up email sent
6. `RESOLVED` → Case fully confirmed (supplier_order_number + delivery_date present)
7. `ESCALATED` → Manual escalation (not currently auto-triggered)

**Case Status (CaseStatus enum):**
1. `STILL_AMBIGUOUS` → Default, missing fields remain
2. `CONFIRMED` → All required fields present (supplier_order_number + delivery_date)
3. `CONFIRMED_WITH_RISK` → Confirmed but low confidence/risk indicators
4. `UNRESPONSIVE` → Supplier not responding (not auto-set)
5. `NEEDS_BUYER` → Requires human intervention (not auto-set)

**State Transitions (who/what triggers):**
- `INBOX_LOOKUP` → `OUTREACH_SENT`: `/api/confirmations/send` (POST) sets state on email send
- `OUTREACH_SENT` → `WAITING`: Implicit (no explicit transition, inferred from time)
- `WAITING` → `PARSED`: `/api/confirmations/parse-fields` could set state (not currently enforced)
- `PARSED` → `RESOLVED`: `/api/confirmations/case/[caseId]/apply-updates` sets state=RESOLVED, status=CONFIRMED when fully confirmed
- `OUTREACH_SENT` → `FOLLOWUP_SENT`: `/api/confirmations/send` with intent='followup' and forceSend=true
- Any state → `RESOLVED`: `/api/confirmations/case/[caseId]/apply-updates` when `hasSupplierOrder && hasShipOrDelivery` is true

**Status Transitions:**
- `STILL_AMBIGUOUS` → `CONFIRMED`: `/api/confirmations/case/[caseId]/apply-updates` when fully confirmed
- `STILL_AMBIGUOUS` → `CONFIRMED_WITH_RISK`: Not currently auto-set (manual only)

**Event Types (EventType):**
- `CASE_CREATED`, `INBOX_SEARCH_STARTED`, `INBOX_SEARCH_FOUND_CONFIRMED`, `INBOX_SEARCH_FOUND_INCOMPLETE`, `INBOX_SEARCH_NOT_FOUND`
- `EMAIL_DRAFTED`, `EMAIL_SENT`, `REPLY_RECEIVED`, `ATTACHMENT_INGESTED`, `PDF_TEXT_EXTRACTED`, `PDF_PARSED`
- `PARSE_RESULT`, `APPLY_UPDATES`, `MANUAL_EDIT`, `EMAIL_RECEIVED`, `CASE_RESOLVED`
- `AGENT_ORCHESTRATE_STARTED`, `AGENT_EVIDENCE_COLLECTED`, `AGENT_FIELDS_EXTRACTED`, `AGENT_DECISION`, `AGENT_EMAIL_SENT`, `AGENT_EMAIL_SKIPPED`

---

## 7) Guardrails + Human-in-Loop

**Demo Recipient Override:**
- **Location**: `app/api/confirmations/send/route.ts:12` (constant), `src/lib/supplier-agent/agentAckOrchestrator.ts:22`
- **Enforcement**: All `sendNewEmail()` and `sendReplyInThread()` calls use `DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'` instead of actual supplier email
- **Scope**: ALL outgoing emails redirected (hardcoded, no env var toggle)

**Auto-Send Gating:**
- **Location**: `src/lib/supplier-agent/agentAckOrchestrator.ts:502-527` (`checkAutoSendGuardrails()`)
- **Checks**:
  1. Supplier email must be present
  2. Missing fields count <= 3
  3. Drafted body length <= 1200 chars
  4. Last email sent >= 24h ago (enforced via NO_OP decision in orchestrator)
- **Enforcement**: Called before auto-send in orchestrator; returns guardrail name if blocked, null if allowed

**Manual Override Protection:**
- **Location**: `app/api/confirmations/case/[caseId]/apply-updates/route.ts:67-109`
- **Mechanism**: Checks `case.meta.manual_overrides.{fieldName}` boolean flags
- **Enforcement**: If `manualOverrides.supplier_order_number === true`, skips applying parsed `supplier_order_number` value

**Approval Points (Human-in-Loop):**
- **Email Send**: UI triggers `/api/confirmations/send` - requires user click "Send" button (no auto-send in production)
- **Field Application**: UI triggers `/api/confirmations/case/[caseId]/apply-updates` - user reviews parsed fields and clicks "Apply"
- **Follow-up Draft**: UI triggers `/api/confirmations/followup/draft` - user reviews draft before sending

**Reset Protection:**
- **Location**: `app/api/confirmations/reset/route.ts:15-23`
- **Enforcement**: Only allowed if `DEMO_MODE=true` OR `NODE_ENV !== 'production'`
- **Returns**: 403 Forbidden if in production without DEMO_MODE

**NO_OP Decision:**
- **Location**: `app/api/confirmations/send/route.ts:297-338`
- **Trigger**: When `runInboxSearch=true` and `searchResult.classification === 'FOUND_CONFIRMED'` and `!requestHasMissingFields`
- **Effect**: Returns `{ action: 'NO_OP', reason: 'FOUND_CONFIRMED' }` without sending email

**Idempotency Guards:**
- **Event Deduplication**: `store.ts:219-262` - prevents duplicate events within 5 seconds (same case_id, event_type, summary)
- **Message Deduplication**: `store.ts:310-363` - uses ON CONFLICT(message_id) DO UPDATE
- **Attachment Deduplication**: `store.ts:399-564` - uses content_sha256 global unique index
- **Apply Updates Deduplication**: `apply-updates/route.ts:120-124` - uses signature comparison to skip if same state already applied

---

## 8) Compile Blockers

**Status**: ✅ No compile errors found (linter shows clean)

**Note**: TypeScript type-check was attempted but failed due to sandbox permissions. However, `read_lints` tool returned no errors for `app/api/confirmations` directory, indicating no current compile-time issues.

---

## 9) Key Constants/Env

**Environment Variables:**
- `GMAIL_SENDER_EMAIL` (used in: `outreach.ts:53`, `send/route.ts:207,449`) - Buyer email address for Gmail API
- `DEMO_MODE` (used in: `reset/route.ts:15`) - Enables reset endpoint in production
- `NODE_ENV` (used in: `reset/route.ts:16`) - Checks if production environment

**Hardcoded Constants:**
- `DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'` (used in: `send/route.ts:12`, `agentAckOrchestrator.ts:22`) - All outgoing emails redirected here
- `POLICY_VERSION` (used in: `agentAckOrchestrator.ts`, not found in search results - likely a constant string)

**Feature Flags (implied, not explicit env vars):**
- `runInboxSearch` (default: `true` in send/route.ts:110) - Controls whether inbox search runs before send
- `forceSend` (default: `false` in send/route.ts:114) - Bypasses NO_OP logic

**Demo Emails/Domains:**
- Demo recipient: `supplierbart@gmail.com` (hardcoded override)
- Buyer email: Read from `GMAIL_SENDER_EMAIL` env var (expected: `lisa.acmebuyer@gmail.com` per send/route.ts comments)

---

## 10) If We Wrapped This in MCP Tools

**Proposed MCP Tool List (1:1 mapping to existing endpoints):**

| Tool Name | Input JSON | Output JSON | Maps To Endpoint |
|-----------|------------|-------------|------------------|
| `confirmations_create_case` | `{ po_number: string, line_id: string, supplier_email?: string, supplier_domain?: string, supplier_name?: string, missing_fields: string[] }` | `{ success: boolean, caseId: string }` | POST /api/confirmations/cases |
| `confirmations_upsert_case` | `{ poNumber: string, lineId: string, supplierEmail: string, supplierName?: string, missingFields?: string[] }` | `{ caseId: string, case: {...} }` | POST /api/confirmations/case/upsert |
| `confirmations_get_case` | `{ caseId: string }` | `{ case: {...}, events: [...], messages: [...], attachments: [...], parsed_best_fields: {...} }` | GET /api/confirmations/case/[caseId] |
| `confirmations_apply_field_updates` | `{ caseId: string, source: 'pdf' \| 'email', fields: { supplier_order_number?: {...}, confirmed_ship_or_delivery_date?: {...}, confirmed_quantity?: {...} } }` | `{ ok: boolean, case: {...} }` | POST /api/confirmations/case/[caseId]/apply-updates |
| `confirmations_search_inbox` | `{ caseId: string, optionalKeywords?: string[], lookbackDays?: number }` | `{ classification: string, matchedThreadId?: string, missingFields: string[], topCandidates: [...] }` | POST /api/confirmations/inbox-search |
| `confirmations_draft_followup` | `{ caseId: string, threadId?: string, missingFields?: string[] }` | `{ ok: boolean, subject: string, body: string, missingFields: string[] }` | POST /api/confirmations/followup/draft |
| `confirmations_send_email` | `{ caseId: string, poNumber?: string, lineId?: string, supplierEmail?: string, missingFields?: string[], runInboxSearch?: boolean, subject?: string, body?: string, intent?: string, forceSend?: boolean }` | `{ ok: boolean, action: string, gmailMessageId?: string, threadId?: string }` | POST /api/confirmations/send |
| `confirmations_parse_fields` | `{ caseId: string }` | `{ caseId: string, parsed: {...} }` | POST /api/confirmations/parse-fields |
| `confirmations_get_last_action` | `{ poNumber: string, lineId: string }` | `{ lastAction: {...} \| null, formatted: string }` | GET /api/confirmations/last-action |
| `confirmations_list_attachments` | `{ caseId?: string, threadId?: string }` | `{ attachments: [...] }` | GET /api/confirmations/attachments/list |
| `confirmations_retrieve_attachments` | `{ caseId: string, threadId?: string }` | `{ attachments: [...], inserted: number, reused: number, skipped: number }` | POST /api/confirmations/attachments/retrieve |
| `confirmations_extract_attachment_text` | `{ attachmentIds: string[] }` | `{ results: [...] }` | POST /api/confirmations/attachments/extract-text |
| `confirmations_parse_attachments` | `{ threadId: string, poNumber?: string }` | `{ best: {...} \| null, tried: number, skipped_scanned: number }` | POST /api/confirmations/attachments/parse |
| `confirmations_download_attachment` | `{ attachmentId: string }` | Binary PDF (base64 encoded in MCP response) | GET /api/confirmations/attachments/[attachmentId]/download |
| `confirmations_get_records` | `{ poIds: string[] }` | `{ records: [...] }` | GET /api/confirmations/records |
| `confirmations_upsert_record` | `{ po_id: string, line_id: string, supplier_order_number?: string, confirmed_ship_date?: string, confirmed_quantity?: number, source_type: string, ... }` | `{ ok: boolean, record: {...} }` | POST /api/confirmations/records/upsert |
| `confirmations_bulk_get_records` | `{ po_ids?: string[], keys?: Array<{ po_id: string, line_id: string }> }` | `{ records: [...], recordsMap: {...} }` | POST /api/confirmations/records/bulk |
| `confirmations_reset_case` | `{ poNumber: string, lineId?: string }` | `{ ok: boolean, message: string, deletedCases: number }` | POST /api/confirmations/reset |

**Notes for MCP Implementation:**
- Tools should preserve all existing side effects (DB writes, Gmail API calls)
- Error responses should map 1:1 (400/404/500 status codes → MCP error responses)
- Binary attachments (download) should be base64-encoded in MCP response
- Demo recipient override (`supplierbart@gmail.com`) should remain unless env var configured
- Idempotency guarantees (content_sha256 dedup, event dedup) should be preserved

---

## Additional Notes

**Missing Endpoints (not exposed but used internally):**
- `agentAckOrchestrator.ts` - Orchestrator function exists but no API endpoint exposed (used by `/api/agent/ack-orchestrate` per project layout, but not in confirmations namespace)
- Gmail OAuth token refresh - handled in `gmail/tokenStore.ts` (not in confirmations namespace)

**Key Dependencies:**
- `better-sqlite3` - SQLite DB
- `googleapis` - Gmail API client
- `pdfjs-dist` - PDF text extraction
- `server-only` - Prevents client-side imports of server modules

**Threading Model:**
- `thread_id` stored in `case.meta.thread_id` (not in cases table directly)
- Messages linked via `messages.thread_id` column
- Gmail thread ID used for reply anchoring

**Evidence Priority (for parsing):**
- PDF attachments (text_extract) - PREFERRED
- Email body text - FALLBACK (only if no PDF text available)
