/** Phase 10 portable runtime tests. No browser, Electron, network, database, or Google API. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main');
const loggerSvc = require(path.join(DIST, 'main/services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { normalizeSourceMode } = require(path.join(DIST, 'types/source-mode.js'));
const { SourceModeSelector, evaluateFastReadiness } = require(path.join(DIST, 'main/sources/source-mode-selector.js'));
const { MonitoringEngine } = require(path.join(DIST, 'main/services/monitoring-engine.js'));
const { TransactionValidator } = require(path.join(DIST, 'main/services/transaction-validator.js'));
const { FingerprintGenerator } = require(path.join(DIST, 'main/services/fingerprint-generator.js'));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = (name, index) => ({ id: String(index), name, enabled: true, priority: index });
const scanResult = (transactions = [], overrides = {}) => ({
  transactions,
  perPage: [{ pageNumber: 1, rowsDetected: transactions.length, rowsParsed: transactions.length,
    rowsRejected: 0, duplicate: 0, buffered: 0, exported: 0 }],
  navigationFailure: false, terminationReason: 'END_OF_PAGINATION', lastPageScanned: 1,
  configuredMaxPage: 10, ...overrides,
});
const raw = (name = 'Trusted') => ({ userName: name, bank: 'BCA', accountName: name,
  accountNumber: `ACC-${name}`, amount: 1000, status: 'Approved', done: 'Yes', depositType: 'Bank',
  agent: 'Agent', processDate: '2026-09-08 10:00:00', createdAt: '2026-09-08 09:59:00' });
const recoveryResult = () => ({ pendingFound: 0, alreadyRemote: 0, appended: 0,
  reconciled: 0, remaining: 0, skipped: null, failureClass: null });

function config(sourceMode) {
  return { version: '2', monitoring: { sourceMode, pollingInterval: 2, maxPageScan: 10, retryCount: 0,
    requestTimeout: 1, browserTimeout: 1, batchSize: 1000, maxCache: 100 }, browser: {}, database: {},
    logging: {}, features: { manualDateMode: true, initialSyncMode: false } };
}
function dependencies(sourceMode, profiles, options = {}) {
  const cfg = config(sourceMode);
  const page = { isClosed: () => false, url: () => 'https://panel.example/deposits' };
  const playwright = options.playwright || { isReady: () => true, validateSession: async () => ({ ok: true }),
    getPage: () => page, getRequestContext: () => null };
  const sqlite = { claimTransaction: options.claimTransaction || (async () => true), getPendingExports: async () => [],
    getTodayExportCount: async () => 0, getStoredTransactionCount: async () => 0, isReady: () => true,
    getResumeMarker: async () => null };
  const sheets = { isConnected: () => true };
  const filters = { getEnabledProfiles: () => profiles, loadProfiles: async () => {} };
  const configManager = { loadAppConfig: async () => cfg, loadGoogleSheetsConfig: async () => ({
    credentialJsonPath: '/fake/credential.json', isConnected: true, worksheetName: 'MASTER', headersValidated: true,
  }) };
  return { cfg, playwright, sqlite, sheets, filters, configManager };
}
function makeEngine(sourceMode, profiles, options = {}) {
  const d = dependencies(sourceMode, profiles, options);
  const engine = new MonitoringEngine(d.playwright, d.filters, new TransactionValidator(),
    new FingerprintGenerator(), d.sqlite, d.sheets, d.configManager, options.injectedSource);
  engine.isRunning = true;
  engine.config = d.cfg;
  engine.recoverPendingExports = async () => recoveryResult();
  return { engine, ...d };
}
function installSelection(engine, requestedMode, effectiveMode, source) {
  let calls = 0;
  engine.sourceModeSelector = { selectForCycle(value) {
    calls++;
    assert.equal(value, requestedMode);
    return { requestedMode, effectiveMode, source, reason: effectiveMode === requestedMode ? 'EXPLICIT' : 'FAST_READY' };
  } };
  return () => calls;
}
async function exerciseConcurrency(requestedMode, effectiveMode, maxConcurrentScans) {
  const profiles = [profile('One', 1), profile('Two', 2), profile('Three', 3)];
  let active = 0, maxActive = 0;
  const starts = [];
  const source = { ...(maxConcurrentScans === 2 ? { maxConcurrentScans: 2 } : {}), async scan(request) {
    starts.push(request.filter.name); active++; maxActive = Math.max(maxActive, active);
    await delay(8); active--; return scanResult();
  } };
  const { engine } = makeEngine(requestedMode, profiles);
  const selectorCalls = installSelection(engine, requestedMode, effectiveMode, source);
  await engine.runMonitoringCycle();
  assert.equal(selectorCalls(), 1);
  assert.deepEqual(starts, ['One', 'Two', 'Three']);
  assert.equal(maxActive, maxConcurrentScans);
  return { engine, source, starts, maxActive };
}

(async () => {
  // A-M — exact contract, exact source identity, and side-effect-free readiness.
  assert.equal(normalizeSourceMode('AUTO'), 'AUTO');
  assert.equal(normalizeSourceMode('FAST'), 'FAST');
  assert.equal(normalizeSourceMode('LEGACY'), 'LEGACY');
  for (const value of [undefined, null, 'bad', 'fast', 'HTTP', 'browser']) assert.equal(normalizeSourceMode(value), 'LEGACY');
  const legacy = { scan() { throw new Error('not invoked'); } };
  const fast = { maxConcurrentScans: 2, scan() { throw new Error('not invoked'); } };
  const page = { isClosed: () => false, url: () => 'https://panel.example/deposits' };
  let pageReads = 0, contextReads = 0;
  const readySession = { getPage() { pageReads++; return page; }, getRequestContext() {
    contextReads++; return { get() { throw new Error('readiness made a network request'); } }; } };
  let selector = new SourceModeSelector(legacy, fast, readySession);
  let selected = selector.selectForCycle('LEGACY'); assert.strictEqual(selected.source, legacy);
  selected = selector.selectForCycle('FAST'); assert.strictEqual(selected.source, fast); assert.equal(selected.effectiveMode, 'FAST');
  selected = selector.selectForCycle('AUTO'); assert.strictEqual(selected.source, fast); assert.equal(selected.reason, 'FAST_READY');
  assert.equal(pageReads, 2); assert.equal(contextReads, 2);
  selector = new SourceModeSelector(legacy, fast, { getPage: () => page, getRequestContext: () => null });
  selected = selector.selectForCycle('AUTO'); assert.strictEqual(selected.source, legacy);
  selected = selector.selectForCycle('FAST'); assert.strictEqual(selected.source, fast); assert.equal(selected.effectiveMode, 'FAST');
  assert.equal(selected.reason, 'REQUEST_CONTEXT_UNAVAILABLE');
  assert.equal(evaluateFastReadiness({ getPage: () => ({ isClosed: () => true, url: () => 'https://x' }), getRequestContext: () => ({}) }).reason, 'BROWSER_PAGE_CLOSED');
  assert.equal(evaluateFastReadiness({ getPage: () => ({ isClosed: () => false, url: () => 'about:blank' }), getRequestContext: () => ({}) }).reason, 'INVALID_BROWSER_ORIGIN');

  // N-P — real production MonitoringEngine pre-run behavior.
  for (const mode of ['FAST', 'AUTO', 'LEGACY']) {
    let pageCalls = 0;
    const unavailablePlaywright = { isReady: () => true, validateSession: async () => ({ ok: true }),
      getPage: () => { pageCalls++; return page; }, getRequestContext: () => null };
    const { engine } = makeEngine(mode, [profile('Ready', 1)], { playwright: unavailablePlaywright });
    const validation = await engine.validatePreRunChecks();
    const fastCheck = validation.checks.find(check => check.name === 'FAST Transport Ready');
    if (mode === 'FAST') { assert.ok(fastCheck); assert.equal(fastCheck.status, false); assert.equal(validation.canStartMonitoring, false); assert.equal(pageCalls, 1); }
    else { assert.equal(fastCheck, undefined); assert.equal(validation.canStartMonitoring, true); assert.equal(pageCalls, 0); }
  }

  // Q-V — the real scheduler selects once, uses one exact source, and derives 2/1 from it.
  await exerciseConcurrency('AUTO', 'FAST', 2);
  await exerciseConcurrency('AUTO', 'LEGACY', 1);
  await exerciseConcurrency('FAST', 'FAST', 2);
  await exerciseConcurrency('LEGACY', 'LEGACY', 1);

  // W — injected adapter stays independent of production selection and retains Phase 9 concurrency.
  let playwrightAcquisition = 0, injectedActive = 0, injectedMax = 0;
  const injectedStarts = [];
  const injected = { maxConcurrentScans: 2, async scan(request) { injectedStarts.push(request.filter.name);
    injectedActive++; injectedMax = Math.max(injectedMax, injectedActive); await delay(8); injectedActive--; return scanResult(); } };
  const throwingPlaywright = { getPage() { playwrightAcquisition++; throw new Error('production acquisition used'); },
    getRequestContext() { playwrightAcquisition++; throw new Error('production acquisition used'); } };
  let fixture = makeEngine('AUTO', [profile('I1', 1), profile('I2', 2), profile('I3', 3)],
    { injectedSource: injected, playwright: throwingPlaywright });
  assert.equal(fixture.engine.sourceModeSelector, undefined);
  await fixture.engine.runMonitoringCycle();
  assert.deepEqual(injectedStarts, ['I1', 'I2', 'I3']); assert.equal(injectedMax, 2); assert.equal(playwrightAcquisition, 0);

  // AF — profile unavailability is isolated and cannot trigger reselection or alternate acquisition.
  const profileStarts = [];
  const profileSource = { maxConcurrentScans: 2, async scan(request) { profileStarts.push(request.filter.name);
    if (request.filter.name === 'Unavailable') { const error = new Error('missing'); error.isProfileUnavailable = true; throw error; }
    await delay(3); return scanResult(); } };
  fixture = makeEngine('AUTO', [profile('Unavailable', 1), profile('Healthy', 2), profile('Later', 3)]);
  let selectorCalls = installSelection(fixture.engine, 'AUTO', 'FAST', profileSource);
  await fixture.engine.runMonitoringCycle();
  assert.equal(selectorCalls(), 1); assert.deepEqual(profileStarts, ['Unavailable', 'Healthy', 'Later']);
  assert.deepEqual(fixture.engine.getExportStats().unavailableProfiles, ['Unavailable']);

  // AG-AO — fatal FAST-like results preserve trusted rows, settle peers, and never reselect/fallback/retry.
  for (const terminationReason of ['SESSION_EXPIRED', 'UNSAFE_RESPONSE', 'HTTP_FAILURE']) {
    const starts = [], claimed = [];
    let siblingSettled = false, siblingSawStop = false;
    const fatalSource = { maxConcurrentScans: 2, async scan(request) {
      starts.push(request.filter.name);
      if (request.filter.name === 'Fatal') return scanResult([raw(terminationReason)], { navigationFailure: true, terminationReason });
      if (request.filter.name === 'Sibling') {
        for (let i = 0; i < 20; i++) { await delay(1); if (request.shouldStop()) { siblingSawStop = true; break; } }
        siblingSettled = true; return scanResult();
      }
      throw new Error('queued filter started or source fallback occurred');
    } };
    fixture = makeEngine('AUTO', [profile('Fatal', 1), profile('Sibling', 2), profile('Queued', 3)],
      { claimTransaction: async tx => { claimed.push(tx); return true; } });
    selectorCalls = installSelection(fixture.engine, 'AUTO', 'FAST', fatalSource);
    await assert.rejects(() => fixture.engine.runMonitoringCycle(), /Navigation verification failed/);
    assert.equal(selectorCalls(), 1); assert.deepEqual(starts, ['Fatal', 'Sibling']);
    assert.equal(siblingSettled, true); assert.equal(siblingSawStop, true);
    assert.equal(claimed.length, 1); assert.equal(claimed[0].userName, terminationReason);
  }

  // Remaining structural frozen-boundary supplements.
  const engineSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/SettingsPage.tsx'), 'utf8');
  const constants = fs.readFileSync(path.join(ROOT, 'src/utils/constants.ts'), 'utf8');
  const pool = fs.readFileSync(path.join(ROOT, 'src/main/sources/fast-http-source-pool.ts'), 'utf8');
  const selectorSource = fs.readFileSync(path.join(ROOT, 'src/main/sources/source-mode-selector.ts'), 'utf8');
  assert.match(settings, /data-testid="source-mode-select"/);
  for (const mode of ['AUTO', 'FAST', 'LEGACY']) assert.equal((settings.match(new RegExp(`<option value="${mode}">`, 'g')) || []).length, 1);
  assert.match(settings, /disabled=\{isMonitoring\}/); assert.match(settings, /sourceMode: 'LEGACY'/);
  assert.match(constants, /sourceMode: 'LEGACY'/);
  assert.equal(require(path.join(ROOT, 'resources/default-config.json')).monitoring.sourceMode, 'LEGACY');
  assert.match(pool, /readonly maxConcurrentScans = 2/); assert.equal((pool.match(/new FastHttpSourceAdapter/g) || []).length, 1);
  for (const forbidden of ['newContext', 'launch(', 'cookies', 'storageState']) assert.ok(!selectorSource.includes(forbidden));
  assert.ok(!engineSource.includes('claimTransaction(')); assert.ok(!engineSource.includes('appendTransactions('));
  assert.ok(!engineSource.includes('setResumeMarker(null)'));
  const packageDiff = require('child_process').execFileSync('git', ['diff', 'HEAD', '--', 'package.json', 'package-lock.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(packageDiff, '');
  console.log('PASS: Phase 10 source mode A-AO (contract, readiness, selector, immutable cycle source, UI, and frozen boundaries).');
})().catch(error => { console.error(error); process.exitCode = 1; });
