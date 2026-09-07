/** Phase 2 source-boundary verification. Portable: no Electron, browser, DB, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { LegacyBrowserSourceAdapter } = require(path.join(DIST, 'sources/legacy-browser-source-adapter.js'));
const { MonitoringEngine } = require(path.join(DIST, 'services/monitoring-engine.js'));

const filter = { id: 'fixture', name: 'Payment Fixture', enabled: true, priority: 1, agent: 'Agent A', depositType: 'Bank' };
const raw = { userName: 'fixture', bank: '', accountName: '', accountNumber: '100', amount: 25,
  status: 'Approved', done: 'Yes', depositType: 'Bank', agent: 'Agent A', processDate: '2026-01-01', createdAt: '2026-01-01' };
const result = (reason = 'END_OF_PAGINATION', navigationFailure = false) => ({
  transactions: [raw],
  perPage: [{ pageNumber: 1, rowsDetected: 1, rowsParsed: 1, rowsRejected: 0, duplicate: 0, buffered: 0, exported: 0 }],
  navigationFailure, terminationReason: reason, lastPageScanned: 1, configuredMaxPage: 7,
});

async function adapterFixture(overrides = {}) {
  const calls = { apply: [], stop: [], duplicate: [], scan: [] };
  const events = [];
  const expected = overrides.result || result();
  const scanner = {
    setShouldStop(fn) { events.push('setShouldStop'); calls.stop.push(fn); },
    setDuplicateCheck(fn) { events.push('setDuplicateCheck'); calls.duplicate.push(fn); },
    async scanPages(f, max) { events.push('scanPages'); calls.scan.push([f, max]); return expected; },
  };
  const page = {};
  const service = {
    getPage: () => { events.push('getPage'); return overrides.page === null ? null : page; },
    async applyFilter(...args) {
      events.push('applyFilter');
      calls.apply.push(args);
      if (overrides.applyError) throw overrides.applyError;
    },
  };
  const adapter = new LegacyBrowserSourceAdapter(service, () => scanner);
  const duplicateCheck = () => false;
  const shouldStop = () => false;
  return { adapter, calls, events, expected, duplicateCheck, shouldStop, request: {
    filter, manualDateMode: overrides.manualDateMode ?? true, maxPages: 7,
    initialSyncMode: overrides.initialSyncMode ?? false, duplicateCheck, shouldStop,
  }};
}

(async () => {
  // A/B/C/E/F: exact filter and date forwarding, callback identity, and result identity.
  for (const manualDateMode of [true, false]) {
    const f = await adapterFixture({ manualDateMode });
    const actual = await f.adapter.scan(f.request);
    assert.deepStrictEqual(f.calls.apply, [[
      { name: filter.name, agent: filter.agent, depositType: filter.depositType },
      { manualDateMode },
    ]]);
    assert.strictEqual(f.calls.stop[0], f.shouldStop);
    assert.strictEqual(f.calls.duplicate[0], f.duplicateCheck);
    assert.deepStrictEqual(f.calls.scan, [[filter, 7]]);
    assert.strictEqual(actual, f.expected);
  }

  // D: Initial Sync explicitly disables scanner duplicate-page checks.
  let f = await adapterFixture({ initialSyncMode: true });
  let predicateCalls = 0;
  f.request.duplicateCheck = () => { predicateCalls++; return true; };
  await f.adapter.scan(f.request);
  assert.strictEqual(f.calls.duplicate[0], null);
  assert.strictEqual(predicateCalls, 0);

  // G: missing page is a clear failure and cannot manufacture an empty success.
  f = await adapterFixture({ page: null });
  await assert.rejects(() => f.adapter.scan(f.request), /Browser page not available/);
  assert.strictEqual(f.calls.apply.length, 0);
  assert.strictEqual(f.calls.scan.length, 0);

  // H: profile-unavailable errors retain object identity and marker; no fallback.
  const unavailable = Object.assign(new Error('fixture unavailable'), { isProfileUnavailable: true });
  f = await adapterFixture({ applyError: unavailable });
  try { await f.adapter.scan(f.request); assert.fail('expected unavailable error'); }
  catch (error) { assert.strictEqual(error, unavailable); assert.strictEqual(error.isProfileUnavailable, true); }
  assert.strictEqual(f.calls.apply.length, 1);
  assert.strictEqual(f.calls.scan.length, 0);

  // I/J: all benign reasons and fatal metadata pass through without classification.
  for (const reason of ['END_OF_PAGINATION', 'MAX_SCAN_REACHED', 'FULL_DUPLICATE_PAGE', 'STOP_REQUESTED']) {
    const expected = result(reason, false);
    f = await adapterFixture({ result: expected });
    assert.strictEqual(await f.adapter.scan(f.request), expected);
  }
  const fatal = result('NAVIGATION_FAILURE', true);
  f = await adapterFixture({ result: fatal });
  assert.strictEqual(await f.adapter.scan(f.request), fatal);

  // K: MonitoringEngine consumes an injected source and runs downstream validation.
  let sourceRequest;
  let validations = 0;
  const fakeSource = { async scan(request) { sourceRequest = request; return result(); } };
  const engine = new MonitoringEngine(
    {}, {}, { validate(value) { validations++; assert.strictEqual(value, raw); return { valid: true, errors: [] }; } },
    { generate: () => 'FINGERPRINT' },
    { getPendingExports: async () => [], isReady: () => true },
    { isConnected: () => false }, {}, fakeSource,
  );
  engine.isRunning = true;
  engine.config = { features: { manualDateMode: false, initialSyncMode: false }, monitoring: { maxPageScan: 7, batchSize: 1000 } };
  await engine.processFilter(filter);
  assert.strictEqual(sourceRequest.filter, filter);
  assert.strictEqual(sourceRequest.manualDateMode, false);
  assert.strictEqual(sourceRequest.maxPages, 7);
  assert.strictEqual(validations, 1);

  // L: source preparation completes before scan-start; failures never fire it.
  f = await adapterFixture();
  f.request.onScanStart = () => f.events.push('onScanStart');
  await f.adapter.scan(f.request);
  assert.deepStrictEqual(f.events, [
    'getPage', 'applyFilter', 'onScanStart', 'setShouldStop', 'setDuplicateCheck', 'scanPages',
  ]);

  f = await adapterFixture({ page: null });
  f.request.onScanStart = () => f.events.push('onScanStart');
  await assert.rejects(() => f.adapter.scan(f.request), /Browser page not available/);
  assert.deepStrictEqual(f.events, ['getPage']);

  f = await adapterFixture({ applyError: unavailable });
  f.request.onScanStart = () => f.events.push('onScanStart');
  await assert.rejects(() => f.adapter.scan(f.request), error => error === unavailable);
  assert.deepStrictEqual(f.events, ['getPage', 'applyFilter']);

  // M: a fatal source result is handed through the pipeline before cycle-fatal rejection.
  const fatalEvents = [];
  const fatalSource = { async scan() { return result('NAVIGATION_FAILURE', true); } };
  const fatalEngine = new MonitoringEngine(
    {}, {}, { validate(value) { fatalEvents.push('validated'); assert.strictEqual(value, raw); return { valid: true, errors: [] }; } },
    { generate: () => 'FATAL-FINGERPRINT' },
    { getPendingExports: async () => [], isReady: () => true },
    { isConnected: () => false }, {}, fatalSource,
  );
  fatalEngine.isRunning = true;
  fatalEngine.config = { features: { manualDateMode: true, initialSyncMode: false }, monitoring: { maxPageScan: 7, batchSize: 1000 } };
  let fatalError;
  try { await fatalEngine.processFilter(filter); }
  catch (error) { fatalEvents.push('thrown'); fatalError = error; }
  assert.deepStrictEqual(fatalEvents, ['validated', 'thrown']);
  assert.strictEqual(fatalError.isCycleFatal, true);
  assert.strictEqual(fatalEngine.buffer.length, 1, 'collected fatal-result row must reach downstream buffer');

  // Narrow structural guard complements the executable injection test.
  const engineSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  assert.ok(!engineSource.includes('new PageScanner('), 'MonitoringEngine must not construct PageScanner');

  console.log('PASS: Phase 2 source adapter cases A-M and MonitoringEngine structural boundary.');
})().catch(error => { console.error(error); process.exitCode = 1; });
