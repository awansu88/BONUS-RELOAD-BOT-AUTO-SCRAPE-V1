/** Phase 9 portable concurrency tests. No browser, Electron, network, or Google API. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { FastHttpSourcePool } = require(path.join(DIST, 'sources/fast-http-source-pool.js'));
const { MonitoringEngine } = require(path.join(DIST, 'services/monitoring-engine.js'));
const { TransactionValidator } = require(path.join(DIST, 'services/transaction-validator.js'));
const { FingerprintGenerator } = require(path.join(DIST, 'services/fingerprint-generator.js'));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scanResult = (transactions = [], overrides = {}) => ({
  transactions, perPage: [{ pageNumber: 1, rowsDetected: transactions.length, rowsParsed: transactions.length,
    rowsRejected: 0, duplicate: 0, buffered: 0, exported: 0 }], navigationFailure: false,
  terminationReason: 'END_OF_PAGINATION', lastPageScanned: 1, configuredMaxPage: 10, ...overrides,
});
const profile = (name, index) => ({ id: String(index), name, enabled: true, priority: index });
const raw = (name = 'Alice') => ({ userName: name, bank: 'BCA', accountName: name,
  accountNumber: `ACC-${name}`, amount: 1000, status: 'Approved', done: 'Yes', depositType: 'Bank',
  agent: 'Agent', processDate: '2026-09-08 10:00:00', createdAt: '2026-09-08 09:59:00' });

function makeEngine(source, profiles, claimTransaction = async () => true) {
  const config = { version: '2', monitoring: { pollingInterval: 2, maxPageScan: 10, retryCount: 0,
    requestTimeout: 1, browserTimeout: 1, batchSize: 1000, maxCache: 100 }, browser: {}, database: {},
    logging: {}, features: { manualDateMode: true, initialSyncMode: false } };
  const sqlite = { claimTransaction, getPendingExports: async () => [], getPendingExportCount: async () => 0, getTodayExportCount: async () => 0,
    getStoredTransactionCount: async () => 0, isReady: () => true, getResumeMarker: async () => null };
  const sheets = { isConnected: () => false };
  const engine = new MonitoringEngine({}, { getEnabledProfiles: () => profiles }, new TransactionValidator(),
    new FingerprintGenerator(), sqlite, sheets, { loadAppConfig: async () => config }, source);
  engine.isRunning = true;
  engine.config = config;
  engine.recoverPendingExports = async () => ({ pendingFound: 0, alreadyRemote: 0, appended: 0,
    reconciled: 0, remaining: 0, skipped: null, failureClass: null });
  return engine;
}

(async () => {
  // A-I: exactly two FIFO-assigned, single-active adapters share one session owner.
  const session = { getPage(){ return null; }, getRequestContext(){ return null; } };
  const receivedSessions = [];
  const workerActive = [0, 0];
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const gates = [null, null, null].map(() => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; });
  const pool = new FastHttpSourcePool(session, (owner, worker) => {
    receivedSessions.push(owner);
    return { scan: async request => {
      assert.equal(workerActive[worker], 0, 'one adapter must never receive overlapping scans');
      workerActive[worker]++; active++; maxActive = Math.max(maxActive, active);
      const id = Number(request.filter.id); calls.push({ id, worker });
      await gates[id].promise;
      active--; workerActive[worker]--;
      return scanResult();
    } };
  });
  assert.equal(pool.maxConcurrentScans, 2);
  assert.equal(receivedSessions.length, 2);
  assert.ok(receivedSessions.every(owner => owner === session));
  const poolRequests = [0, 1, 2].map(id => pool.scan({ filter: profile(`P${id}`, id), manualDateMode: true,
    maxPages: 1, initialSyncMode: false, shouldStop: () => false, duplicateCheck: () => false }));
  await delay(0);
  assert.deepEqual(calls.map(call => call.id), [0, 1], 'third scan must wait');
  gates[0].resolve(); await delay(0);
  assert.deepEqual(calls.map(call => call.id), [0, 1, 2]);
  gates[1].resolve(); gates[2].resolve(); await Promise.all(poolRequests);
  assert.equal(maxActive, 2); assert.equal(calls.length, 3);

  // J-M: capability enables two bounded filters; ordinary/Legacy capability stays ordered at one.
  const starts = []; active = 0; maxActive = 0;
  const concurrentSource = { maxConcurrentScans: 2, scan: async request => {
    starts.push(request.filter.name); active++; maxActive = Math.max(maxActive, active); await delay(10); active--;
    if (request.filter.name === 'Unavailable') { const error = new Error('missing'); error.isProfileUnavailable = true; throw error; }
    return scanResult();
  } };
  let engine = makeEngine(concurrentSource, [profile('One', 1), profile('Unavailable', 2), profile('Three', 3)]);
  await engine.runMonitoringCycle();
  assert.equal(maxActive, 2); assert.deepEqual(starts, ['One', 'Unavailable', 'Three']);
  assert.deepEqual(engine.getExportStats().unavailableProfiles, ['Unavailable']);
  starts.length = 0; active = 0; maxActive = 0;
  const sequentialSource = { scan: async request => { starts.push(request.filter.name); active++; maxActive = Math.max(maxActive, active); await delay(2); active--; return scanResult(); } };
  engine = makeEngine(sequentialSource, [profile('First', 1), profile('Second', 2), profile('Third', 3)]);
  await engine.runMonitoringCycle(); assert.equal(maxActive, 1); assert.deepEqual(starts, ['First', 'Second', 'Third']);

  // N-Q: fatal rows ingest first, peer sees cooperative stop, queued filter never starts, peers settle.
  const fatalStarts = []; let siblingSettled = false; let siblingObservedStop = false; const claimed = [];
  const fatalSource = { maxConcurrentScans: 2, scan: async request => {
    fatalStarts.push(request.filter.name);
    if (request.filter.name === 'Fatal') return scanResult([raw('Trusted')], { navigationFailure: true, terminationReason: 'HTTP_FAILURE' });
    if (request.filter.name === 'Sibling') {
      for (let page = 0; page < 20; page++) { await delay(1); if (request.shouldStop()) { siblingObservedStop = true; break; } }
      siblingSettled = true; return scanResult();
    }
    throw new Error('queued filter unexpectedly started');
  } };
  engine = makeEngine(fatalSource, [profile('Fatal', 1), profile('Sibling', 2), profile('Queued', 3)], async tx => { claimed.push(tx); return true; });
  await assert.rejects(() => engine.runMonitoringCycle(), /Source scan failed \(/);
  assert.deepEqual(fatalStarts, ['Fatal', 'Sibling']); assert.ok(siblingObservedStop); assert.ok(siblingSettled);
  assert.equal(claimed.length, 1); assert.equal(claimed[0].userName, 'Trusted');

  // R-T: concurrent same fingerprint uses atomic claim; counters and local outcomes stay exact.
  const fingerprints = new Set();
  const atomicClaim = async tx => { await delay(1); if (fingerprints.has(tx.transactionFingerprint)) return false; fingerprints.add(tx.transactionFingerprint); return true; };
  const duplicateSource = { maxConcurrentScans: 2, scan: async () => scanResult([raw('Same')]) };
  engine = makeEngine(duplicateSource, [profile('A', 1), profile('B', 2)], atomicClaim);
  await engine.runMonitoringCycle();
  assert.equal(fingerprints.size, 1); assert.equal(engine.cycleCounters.parsed, 2);
  assert.equal(engine.cycleCounters.sqliteInserted, 1); assert.equal(engine.cycleCounters.duplicates, 1);
  assert.equal(engine.cycleCounters.rejected, 0);
  assert.equal(engine.cycleCounters.parsed, engine.cycleCounters.sqliteInserted + engine.cycleCounters.duplicates + engine.cycleCounters.rejected);

  // U-AD: structural frozen-boundary checks.
  const engineSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  const poolSource = fs.readFileSync(path.join(ROOT, 'src/main/sources/fast-http-source-pool.ts'), 'utf8');
  const fastSource = fs.readFileSync(path.join(ROOT, 'src/main/sources/fast-http-source-adapter.ts'), 'utf8');
  const productionFiles = [];
  (function collect(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) collect(file); else if (entry.name.endsWith('.ts')) productionFiles.push(file);
  } })(path.join(ROOT, 'src/main'));
  assert.match(fastSource, /if \(this\.active\) throw new FastWorkerBusyError\(\)/);
  assert.match(engineSource, /new LegacyBrowserSourceAdapter\(playwrightService\)/);
  assert.match(engineSource, /new FastHttpSourcePool\(playwrightService\)/);
  assert.ok(!/Promise\.all\s*\(\s*filters\.map/.test(engineSource));
  assert.ok(!poolSource.includes('newContext')); assert.ok(!poolSource.includes('cookies'));
  assert.equal((poolSource.match(/new FastHttpSourceAdapter/g) || []).length, 1);
  const appendCallers = productionFiles.filter(file => !file.endsWith('google-sheets-service.ts') && /\.appendTransactions\s*\(/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(appendCallers.map(file => path.relative(ROOT, file).split(path.sep).join('/')), ['src/main/services/pending-export-recovery.ts']);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'src/main/services/export-writer-queue.ts'), 'utf8').includes('Transaction[]'));
  assert.ok(require(path.join(ROOT, 'package.json')).scripts['test:phase10:source-mode']);
  console.log('PASS: Phase 9 FAST concurrency A-AD (pool, scheduler, cancellation, ingest, accounting, and writer boundaries).');
})().catch(error => { console.error(error); process.exitCode = 1; });
