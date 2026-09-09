/** Hotfix 13C Revision 1 verifier. Portable: no live browser, native DB, Electron, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const loggerSvc = require(path.join(DIST, 'main/services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });

const { normalizeExportStrategy } = require(path.join(DIST, 'types/export-strategy.js'));
const { DEFAULT_CONFIG } = require(path.join(DIST, 'utils/constants.js'));
const { MonitoringEngine } = require(path.join(DIST, 'main/services/monitoring-engine.js'));
const { PageScanner } = require(path.join(DIST, 'main/services/page-scanner.js'));
const { FastHttpSourceAdapter } = require(path.join(DIST, 'main/sources/fast-http-source-adapter.js'));
const { ExportWriterQueue } = require(path.join(DIST, 'main/services/export-writer-queue.js'));
const { SELECTORS } = require(path.join(DIST, 'utils/selector-repository.js'));

const profile = { id: 'p', name: 'Fixture', enabled: true, priority: 1 };
const raw = (id, overrides = {}) => ({ userName: `user-${id}`, bank: '', accountName: '', accountNumber: `account-${id}`,
  amount: 10, status: 'Approved', done: 'Yes', depositType: '', agent: '',
  processDate: '2026-01-01 01:00:00', createdAt: '2026-01-01 01:00:00', fixtureId: id, ...overrides });
const stats = (pageNumber, transactions) => ({ pageNumber, rowsDetected: transactions.length,
  rowsParsed: transactions.length, rowsRejected: 0, duplicate: 0, buffered: 0, exported: 0 });
const scanResult = (pages, terminationReason = 'END_OF_PAGINATION', navigationFailure = false) => ({
  transactions: pages.flat(), perPage: pages.map((rows, index) => stats(index + 1, rows)), navigationFailure,
  terminationReason, lastPageScanned: pages.length, configuredMaxPage: 10,
});
const recoveryResult = (count = 0, skipped = null, remaining = 0) => ({ pendingFound: count,
  alreadyRemote: 0, appended: skipped ? 0 : count, reconciled: skipped ? 0 : count,
  remaining, skipped, failureClass: skipped ? skipped : null });

function engineHarness({ strategy, pages, batchSize = 1000, statuses = {}, recovery } = {}) {
  const durable = new Set(); const ingestCalls = []; const requests = []; const recoveries = [];
  const source = { async scan(request) {
    requests.push(request);
    if (request.onPage) for (let index = 0; index < pages.length; index++) {
      await request.onPage({ pageNumber: index + 1, transactions: pages[index], stats: stats(index + 1, pages[index]) });
    }
    return scanResult(pages);
  }};
  const sqlite = { getPendingExports: async () => [], getPendingExportCount: async () => durable.size,
    getResumeMarker: async () => null, isReady: () => true };
  const engine = new MonitoringEngine({}, {}, {}, { generate: value => `fp-${value.fixtureId}` }, sqlite,
    { isConnected: () => true }, {}, source);
  engine.isRunning = true;
  engine.config = { features: { manualDateMode: true, initialSyncMode: false },
    monitoring: { maxPageScan: 10, batchSize, ...(strategy === undefined ? {} : { exportStrategy: strategy }) } };
  engine.centralIngestService = { async ingest(value) {
    ingestCalls.push(value.fixtureId);
    const status = statuses[value.fixtureId] || 'ACCEPTED';
    if (status === 'REJECTED') return { status, errors: ['fixture rejection'] };
    if (status === 'DUPLICATE') return { status, fingerprint: `fp-${value.fixtureId}` };
    durable.add(value.fixtureId);
    return { status, fingerprint: `fp-${value.fixtureId}`, transaction: {
      ...value, transactionFingerprint: `fp-${value.fixtureId}`, filterProfile: profile.name, exportStatus: 'pending' } };
  }};
  engine.recoverPendingExports = async () => {
    recoveries.push([...durable]);
    if (recovery) return recovery({ durable, call: recoveries.length });
    const count = durable.size; durable.clear(); return recoveryResult(count);
  };
  return { engine, source, durable, ingestCalls, requests, recoveries };
}

function scannerHarness(duplicateCheck, hasNext = false) {
  const events = [];
  const scanner = new PageScanner({ url: () => 'https://example.invalid/deposit/transactions?page=1' });
  scanner.htmlMapper = { parseCurrentPage: async () => { events.push('parse'); return {
    transactions: [raw('legacy')], rowsDetected: 1, rejections: [] }; } };
  scanner.getActivePageFromDom = async () => 1;
  scanner.hasNextPage = async () => { events.push('navigation-check'); return hasNext; };
  scanner.navigateAndVerify = async () => { events.push('navigation-click'); scanner.setShouldStop(() => true); };
  scanner.setShouldStop(() => false); scanner.setDuplicateCheck(duplicateCheck);
  return { scanner, events };
}

function fastPage() {
  const form = { getAttribute: key => key === 'method' ? 'GET' : key === 'action' ? '/deposit/transactions' : null };
  const element = (tagName, name, value, options) => ({ tagName, value, options,
    closest: key => key === 'form' ? form : null,
    getAttribute: key => key === 'name' ? name : key === 'type' ? 'text' : null });
  const elements = {};
  elements[SELECTORS.FILTER.DEPOSIT_STATUS] = element('SELECT', 'status', '', [{ value: 'approved', textContent: 'Approve' }]);
  elements[SELECTORS.FILTER.DATE_FROM] = element('INPUT', 'from', '2026-01-01');
  elements[SELECTORS.FILTER.DATE_TO] = element('INPUT', 'to', '2026-01-01');
  return { url: () => 'https://example.invalid/deposit/transactions', async evaluate(callback, argument) {
    const previous = global.document; global.document = { querySelector: selector => elements[selector] || null };
    try { return callback(argument); } finally { if (previous === undefined) delete global.document; else global.document = previous; }
  }};
}

async function executableCases() {
  // A/L: an old config is normalized without mutation; BATCHED omits onPage,
  // ingests the aggregate once, retains batch-size drains, and drains its tail at cycle end.
  const oldConfig = { monitoring: { batchSize: 2 } }; const snapshot = JSON.stringify(oldConfig);
  assert.strictEqual(normalizeExportStrategy(oldConfig.monitoring.exportStrategy), 'BATCHED');
  assert.strictEqual(JSON.stringify(oldConfig), snapshot);
  assert.strictEqual(normalizeExportStrategy('invalid'), 'BATCHED');
  assert.strictEqual(DEFAULT_CONFIG.monitoring.exportStrategy, 'BATCHED');
  const batched = engineHarness({ pages: [[raw('b1'), raw('b2')], [raw('b3'), raw('b4')], [raw('b5')]], batchSize: 2 });
  await batched.engine.processFilter(profile);
  assert.strictEqual(batched.requests[0].onPage, undefined);
  assert.deepStrictEqual(batched.ingestCalls, ['b1', 'b2', 'b3', 'b4', 'b5']);
  assert.strictEqual(batched.recoveries.length, 2, 'batchSize must trigger twice before the tail');
  await batched.engine.exportBuffer();
  assert.strictEqual(batched.recoveries.length, 3, 'cycle-end equivalent must drain the final row');
  assert.deepStrictEqual(batched.engine.cycleCounters, { parsed: 5, validated: 5, duplicates: 0, rejected: 0,
    fingerprintsCreated: 5, buffered: 5, sqliteInserted: 5, sheetsAppended: 5, markedExported: 5 });

  // B/C/I: PER_PAGE executes aggregate rows once, suppresses batchSize=1 within
  // a page, drains once per accepted page, ignores duplicate-only pages, and
  // remains signal-driven after volatile bookkeeping is deliberately cleared.
  const pages = [[raw('p1'), raw('p2')], [raw('p3'), raw('reject')], [raw('duplicate')]];
  const perPage = engineHarness({ strategy: 'PER_PAGE', pages, batchSize: 1,
    statuses: { reject: 'REJECTED', duplicate: 'DUPLICATE' } });
  const productionDrain = perPage.engine.drainDurablePending.bind(perPage.engine);
  perPage.engine.drainDurablePending = async () => {
    perPage.engine.buffer = []; // deterministic concurrent-worker/volatile-clear simulation
    return productionDrain();
  };
  await perPage.engine.processFilter(profile);
  assert.strictEqual(typeof perPage.requests[0].onPage, 'function');
  assert.deepStrictEqual(perPage.ingestCalls, ['p1', 'p2', 'p3', 'reject', 'duplicate']);
  assert.strictEqual(perPage.recoveries.length, 2, 'only the two accepted page boundaries signal');
  assert.deepStrictEqual(perPage.recoveries.map(rows => rows.length), [2, 1]);
  assert.strictEqual(perPage.durable.size, 0);
  assert.deepStrictEqual(perPage.engine.cycleCounters, { parsed: 5, validated: 4, duplicates: 1, rejected: 1,
    fingerprintsCreated: 4, buffered: 3, sqliteInserted: 3, sheetsAppended: 3, markedExported: 3 });

  // E/F/G: recovery skip outcomes never roll back durable claims.
  for (const skipped of ['SHEETS_UNAVAILABLE', 'BACKOFF', 'STOPPED']) {
    const retained = engineHarness({ strategy: 'PER_PAGE', pages: [[raw(skipped)]], batchSize: 1,
      recovery: ({ durable }) => recoveryResult(0, skipped, durable.size) });
    await retained.engine.processFilter(profile);
    assert.deepStrictEqual([...retained.durable], [skipped]);
    assert.strictEqual(retained.recoveries.length, 1);
    assert.strictEqual(retained.engine.cycleCounters.sqliteInserted, 1);
    assert.strictEqual(retained.engine.cycleCounters.sheetsAppended, 0);
  }

  // H: page 1 is durable and signalled before a later fatal navigation result;
  // its aggregate copy is never processed again.
  const failed = engineHarness({ strategy: 'PER_PAGE', pages: [[raw('before-failure')]],
    recovery: ({ durable }) => recoveryResult(0, 'SHEETS_UNAVAILABLE', durable.size) });
  failed.source.scan = async request => {
    failed.requests.push(request);
    await request.onPage({ pageNumber: 1, transactions: [raw('before-failure')], stats: stats(1, [raw('before-failure')]) });
    return scanResult([[raw('before-failure')]], 'NAVIGATION_FAILURE', true);
  };
  await assert.rejects(() => failed.engine.processFilter(profile), error =>
    error.isCycleFatal === true && error.terminationReason === 'NAVIGATION_FAILURE' && error.rowsHandedOff === 1);
  assert.deepStrictEqual(failed.ingestCalls, ['before-failure']);
  assert.deepStrictEqual([...failed.durable], ['before-failure']);

  // D: the actual compiled queue serializes two FAST-like page signals.
  let active = 0; let maxActive = 0; const order = [];
  const queue = new ExportWriterQueue({ recover: async options => {
    active++; maxActive = Math.max(maxActive, active); order.push(`start-${options.batchSize}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push(`end-${options.batchSize}`); active--; return recoveryResult(1);
  }});
  await Promise.all([queue.enqueue({ batchSize: 1 }), queue.enqueue({ batchSize: 2 })]);
  assert.strictEqual(maxActive, 1);
  assert.deepStrictEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);

  // K: actual PageScanner ordering and duplicate termination.
  let legacy = scannerHarness(() => false, true);
  const legacyResult = await legacy.scanner.scanPages(profile, 2, async () => legacy.events.push('onPage'));
  assert.deepStrictEqual(legacy.events, ['parse', 'onPage', 'navigation-check', 'navigation-click']);
  assert.strictEqual(legacyResult.terminationReason, 'STOP_REQUESTED');
  legacy = scannerHarness(() => true);
  const duplicateResult = await legacy.scanner.scanPages(profile, 10, async () => legacy.events.push('onPage'));
  assert.deepStrictEqual(legacy.events, ['parse', 'onPage']);
  assert.strictEqual(duplicateResult.terminationReason, 'FULL_DUPLICATE_PAGE');

  // J: execute trusted FAST pagination and prove callback-before-next-GET.
  const page1 = read('scripts/fixtures/phase4/pagination-page-1.html');
  const page2 = read('scripts/fixtures/phase4/pagination-final.html');
  const events = []; let responseIndex = 0;
  const http = { async get(url) { events.push(`get-${++responseIndex}`); return {
    status: () => 200, url: () => url, text: async () => responseIndex === 1 ? page1 : page2 }; } };
  const adapter = new FastHttpSourceAdapter({ getPage: fastPage, getRequestContext: () => http });
  const request = { filter: profile, manualDateMode: true, maxPages: 10, initialSyncMode: false,
    shouldStop: () => false, duplicateCheck: () => false,
    onPage: async page => events.push(`onPage-${page.pageNumber}`) };
  const fastResult = await adapter.scan(request);
  assert.deepStrictEqual(events, ['get-1', 'onPage-1', 'get-2', 'onPage-2']);
  assert.strictEqual(fastResult.transactions.length, 2);

  const duplicateEvents = []; let gets = 0;
  const duplicateHttp = { async get(url) { gets++; duplicateEvents.push('get-1'); return {
    status: () => 200, url: () => url, text: async () => page1 }; } };
  const duplicateAdapter = new FastHttpSourceAdapter({ getPage: fastPage, getRequestContext: () => duplicateHttp });
  const fastDuplicate = await duplicateAdapter.scan({ ...request, duplicateCheck: () => true,
    onPage: async () => duplicateEvents.push('onPage-1') });
  assert.deepStrictEqual(duplicateEvents, ['get-1', 'onPage-1']); assert.strictEqual(gets, 1);
  assert.strictEqual(fastDuplicate.terminationReason, 'FULL_DUPLICATE_PAGE');
  console.log('EXECUTABLE PASS: BATCHED/PER_PAGE engine, counters, durability outcomes, FIFO writer, Legacy and FAST ordering.');
}

function structuralGuards() {
  const settings = read('src/renderer/pages/SettingsPage.tsx');
  assert.match(settings, /data-testid="export-strategy-select"/); assert.match(settings, /value="BATCHED"/);
  assert.match(settings, /value="PER_PAGE"/); assert.match(settings, /disabled=\{isMonitoring\}/);
  assert.match(settings, /exportStrategy: 'BATCHED'/); assert.match(settings, /saveAppConfig\(config\)/);
  assert.match(settings, /normalizeExportStrategy\(config\.monitoring\.exportStrategy\)/);

  const engine = read('src/main/services/monitoring-engine.ts');
  const scanner = read('src/main/services/page-scanner.ts');
  const legacy = read('src/main/sources/legacy-browser-source-adapter.ts');
  const fast = read('src/main/sources/fast-http-source-adapter.ts');
  assert.match(fast, /interface FastHttpRequestContext \{ get\(/);
  assert.doesNotMatch(fast, /http\.(?:post|put|patch|delete|fetch)\s*\(/);
  assert.match(read('src/main/sources/fast-http-source-pool.ts'), /maxConcurrentScans = 2/);
  assert.match(engine, /return advertised === 2 \? 2 : 1/);
  assert.doesNotMatch(scanner + legacy + fast, /appendTransactions\s*\(/);
  assert.strictEqual((engine.match(/new ExportWriterQueue\(/g) || []).length, 1);
  assert.strictEqual((engine.match(/new PendingExportRecovery\(/g) || []).length, 1);
  const productionFiles = [];
  const collect = directory => fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
    const target = path.join(directory, entry.name); if (entry.isDirectory()) collect(target);
    else if (entry.name.endsWith('.ts')) productionFiles.push(target);
  });
  collect(path.join(ROOT, 'src/main'));
  assert.deepStrictEqual(productionFiles.filter(file => /\.appendTransactions\s*\(/.test(fs.readFileSync(file, 'utf8'))
    && !file.endsWith('google-sheets-service.ts')).map(file => path.relative(ROOT, file).replaceAll(path.sep, '/')),
  ['src/main/services/pending-export-recovery.ts']);
  assert.deepStrictEqual([...read('src/main/services/database-migration.ts').matchAll(/version:\s*(\d+)/g)]
    .map(match => Number(match[1])), [1]);
  const sheets = read('src/main/services/google-sheets-service.ts');
  assert.match(sheets, /const destinationRange = `\$\{WORKSHEET_NAME\}!\$\{COLUMN\.USER_ID\}/);
  assert.match(sheets, /return \[\s*t\.userName,\s*t\.amount,\s*t\.transactionFingerprint\.substring\(0, 8\)\.toUpperCase\(\),\s*t\.createdAt \|\| t\.processDate,\s*\]/);
  assert.match(read('src/main/services/fingerprint-generator.ts'), /substring\(0, 8\)\.toUpperCase\(\)/);
  const packageJson = JSON.parse(read('package.json')); const lock = JSON.parse(read('package-lock.json'));
  assert.deepStrictEqual(packageJson.dependencies, lock.packages[''].dependencies);
  assert.deepStrictEqual(packageJson.devDependencies, lock.packages[''].devDependencies);
  console.log('STRUCTURAL PASS: Settings and frozen ownership/transport/concurrency/schema/layout/dependency guards.');
}

(async () => {
  await executableCases();
  structuralGuards();
  console.log('PASS: Hotfix 13C executable engine/page/writer cases + structural frozen guards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
