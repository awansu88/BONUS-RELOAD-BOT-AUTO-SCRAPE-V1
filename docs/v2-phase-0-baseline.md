# V2 Phase 0 — Legacy production baseline

This document records the implementation present at Phase 0. It is a characterization, not a proposed V2 design. No live credentials or customer records were used.

## Existing Production Data Flow

`MonitoringEngine.initialize()` loads application configuration and JSON filter profiles, caches SQLite fingerprints whose `process_date` is within the previous 30 days, loads pending rows into its in-memory `retryQueue`, and loads `app_state.resume_marker`. At start, it connects Sheets and reconciles that marker with the latest non-empty KEY_ID in Sheets column D (Sheets wins).

Each polling cycle reloads configuration, obtains enabled profiles in ascending priority order, and starts every profile search at page 1. `PlaywrightService.applyFilter()` resets browser fields, applies the profile's agent and `depositType`, forces status `Approve`, applies the date-mode rule, clicks Search, and waits for the rendered table. `PageScanner` and `HTMLMapper` traverse the rendered Playwright DOM up to `maxPageScan`. The mapper accepts only explicit 17-header/15-body, 16/16, and 16/15 layouts and emits `RawTransaction` values.

For every returned row, the engine performs the essential-field validation, generates the frozen fingerprint, checks the in-cycle and cached fingerprint sets, then buffers a `pending` `Transaction`. Export is write-ahead: insert into SQLite, write B:E to Sheets, mark SQLite rows `exported`, and finally save the short fingerprint of the batch's last transaction as the resume marker. Stop requests set `isRunning=false`; the filter loop and scanner check this between filters/pages and before pagination. A currently executing DOM/API operation is not forcibly aborted.

## Frozen Contracts

### Fingerprint

`FingerprintGenerator` joins exactly four normalized values with `|` and SHA-1 hashes their UTF-8 bytes:

1. `userName`: trim outer whitespace and collapse internal whitespace to one space; **case is preserved**.
2. `accountNumber`: remove whitespace/hyphens, then remove every non-digit.
3. `amount`: round a number to the nearest integer; string support removes commas, parses with `parseFloat`, then rounds. The `RawTransaction` path supplies a number.
4. `processDate`: trim outer whitespace only; no date parsing/reformatting.

No bank, domain, profile, payment, agent, source ID, worker, or mode participates. KEY_ID is the first eight SHA-1 characters, upper-cased. The generator's existing debug log includes the normalized input; this can disclose transaction identifiers and is a later security-hardening concern.

### RawTransaction and validation

The scraper emits required TypeScript fields: `userName`, `bank`, `accountName`, `accountNumber`, `status`, `done`, `depositType`, `agent`, `processDate`, and `createdAt` as strings, plus numeric `amount`. Cell text is trimmed and internal whitespace collapsed; amount text has commas removed and is parsed with `parseFloat`. The validator requires nonblank username/account number/process date and a numeric, non-NaN amount. Browser filtering—not the validator—owns business rules.

The persisted/exportable `Transaction` adds `transactionFingerprint`, `filterProfile`, and `exportStatus` (`pending`, `exported`, or `failed`).

### Filter profiles

Profiles are plain JSON arrays loaded without schema transformation. Supported fields are `id`, `name`, `enabled`, `priority`, and optional `agent`, `bank`, `status`, `payment`, legacy-compatible `depositType`, `done`, `verified`, `firstDeposit`, `username`, `accountName`, `accountNumber`, `dateFrom`, `dateTo`, `includeKeyword`, `excludeKeyword`, and `description`. Enabled profiles sort by ascending numeric priority. The engine currently passes only name, agent, and `depositType` to Playwright; stored profile dates are intentionally ignored.

### Google Sheets

The fixed worksheet is `MASTER`. Headers are validated/initialized only in `B1:E1` as USER ID, AMOUNT, KEY_ID, TIME STAMP. New rows start at the first empty cell found by scanning raw `B2:B`; if packed, insertion is row `2 + returnedValues.length`. A batch uses one `values.update`, `USER_ENTERED`, over exact range `MASTER!B{start}:E{end}`. Columns map to username, numeric amount, uppercase eight-character KEY_ID, and `createdAt` (falling back to `processDate` for restart-restored legacy rows). Columns A, F, and I are formula-owned and never written.

A fulfilled update is success; an error is rethrown. SQLite is marked exported and the marker advances only after success. Deduplication happens before Sheets and Sheets itself is not queried per row for duplicates.

### Duplicate stop, Initial Sync, and maxPageScan

Incremental mode installs the engine's fingerprint predicate in `PageScanner`. A non-empty parsed page with zero new rows terminates as `FULL_DUPLICATE_PAGE`; any page containing at least one new row continues. An empty/all-rejected page does not count as fully duplicate. Initial Sync is `features.initialSyncMode === true`; it passes a null duplicate predicate, disabling this stop and walking until end pagination, stop request, failure, or the maximum.

The loop starts with page 1 and runs while scanned count is less than `maxPageScan`. After parsing the configured final page it returns `MAX_SCAN_REACHED` without clicking Next. The configured value is read at each cycle; the engine's `|| 10` fallback means zero also becomes 10.

### Manual Date Mode

Manual mode is enabled unless `features.manualDateMode === false` (default true). Before resetting other fields, Playwright reads From/To directly from the live browser inputs. Manual mode leaves both unchanged and makes either blank value cycle-fatal. Auto mode ignores profile dates and fills/verifies both browser fields with the current local day on every profile application. Thus the browser values are authoritative in manual mode and today's local date is authoritative in auto mode.

### SQLite

Migration version 1 uses `schema_version`. `transactions.transaction_fingerprint` is `NOT NULL UNIQUE`, with indexes on fingerprint, process date, export status, and created-at. Rows include user ID, account number, amount, process date, filter profile, status, exported timestamp, and insertion timestamp. `app_state` is a key/value table holding `resume_marker`. There is no separate retry table: `export_status='pending'` is durable retry representation. Inserts use `INSERT OR IGNORE`; no schema change was introduced in Phase 0. The dedicated `test:phase0:sqlite` gate runs under Electron, creates and opens a sanitized version-1 fixture through `SQLiteService`, and verifies fingerprint, pending row, and marker access. An unavailable Electron/native binding makes that command fail; static checks are not accepted as a substitute.

## Retry Queue Findings

`MonitoringEngine.retryQueue` is a private in-memory array. Producers are startup restoration (`getPendingExports()`), a SQLite insertion exception, a disconnected Sheets branch, and the Sheets/mark-exported catch. **There is no consumer:** no code shifts, drains, exports, or merges this array into `buffer`. It is only counted and displayed.

Consequently pending rows survive restart in SQLite and are loaded, but remain stranded. Their fingerprints are also loaded into the dedupe cache when within the 30-day threshold, so a later browser scan rejects them as duplicates and cannot recreate an export attempt. Rows older than the fingerprint cache threshold may be reconsidered, but `INSERT OR IGNORE` retains the old row and a Sheets attempt from the new buffer can occur; this is accidental rather than a retry mechanism.

The marker normally advances only after Sheets update and `updateExportStatus`. However, if Sheets succeeds and marking exported fails, the common catch queues the batch while Sheets already contains it, so a future real retry risks duplicating Sheets rows. If marking succeeds and saving the marker fails, the catch also queues already-exported rows. Startup reconciliation can later derive a marker from Sheets, but it does not repair local export statuses.

### PHASE 1 REQUIRED FIX 1 — no retry consumer

- **Root cause:** `retryQueue` has producers and observability only; no drain operation exists.
- **Impact:** disconnected/failed exports remain pending indefinitely, including after restart.
- **Reproduction:** persist a pending row by disconnecting or failing Sheets, restart, initialize, observe queue count increase, then observe no call exports it; browser rediscovery is suppressed by its cached fingerprint.
- **Recommendation boundary:** Phase 1 should implement one idempotent pending-export recovery owner that loads SQLite pending rows and drains them independently of scrape dedupe, with explicit lifecycle/backoff.

### PHASE 1 REQUIRED FIX 2 — ambiguous partial success

- **Root cause:** Sheets append, local mark-exported, and marker save are separate operations inside one catch; the retry representation does not record which sub-step succeeded.
- **Impact:** a Sheets-success/local-failure can lead to duplicate remote rows if retry is later enabled, while local status/marker may disagree.
- **Reproduction:** make `appendTransactions()` succeed and `updateExportStatus()` or `saveResumeMarker()` throw.
- **Recommendation boundary:** Phase 1 must define idempotency/reconciliation for partial success and separate append failures from post-append local-state failures.

### PHASE 1 REQUIRED FIX 3 — failed SQLite insert queued only in memory

- **Root cause:** on insertion failure, the batch is pushed to RAM, then the error escapes; by definition it is not durable.
- **Impact:** an app exit after local persistence failure loses that retry candidate.
- **Reproduction:** force `insertTransactions()` to throw after transactions enter the buffer, then restart.
- **Recommendation boundary:** Phase 1 should distinguish local persistence failure from durable pending work and must not claim restart recovery until durable storage succeeds.

## Legacy Performance Measurement

Existing INFO telemetry includes total cycle milliseconds and pipeline counts for parsed, validated/rejected, fingerprints, duplicates, buffered, SQLite inserts, Sheets appends, marks exported, and retry depth. Phase 0 enriches each pagination summary with pages scanned, parsed/rejected rows, new/duplicate rows, termination reason, and total filter milliseconds. Sheets success now includes batch size, destination range, and append latency. The dashboard already exposes queue/connectivity and transaction counters. No per-row INFO logging or timing delay was added.

## Known Risks / Technical Debt

- Retry recovery defects above require Phase 1.
- Fingerprints are cached only for rows whose textual `process_date` is in the previous 30 days, despite the database unique constraint covering all history.
- The fingerprint debug message includes normalized username/account/date input. Diagnostic policy should redact personal identifiers in a later isolated hardening change.
- Raw rejected-row diagnostics may include full cell text and raw HTML, potentially exposing customer data when diagnostic logging is enabled. No auth cookies or headers are logged by the Phase 0 changes.
- Stop is cooperative and cannot interrupt an already-running Playwright or Sheets operation.

## Phase 1 Inputs

1. Design and test an idempotent durable pending-export consumer, independent of scrape duplicate detection.
2. Define recovery for Sheets-success/local-state-failure boundaries before enabling retries.
3. Specify retry ordering, batching, backoff, cancellation, and shutdown semantics.
4. Add safe redaction for fingerprint and rejected-DOM diagnostics as a separately reviewed security change.

Phase 0 deliberately adds no HTTP scraper, worker concurrency, mode selector, adapter/resolver, schema migration, dedupe redesign, domain migration, or UI redesign.
