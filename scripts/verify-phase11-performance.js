/** Phase 11 deterministic performance verification. No browser, network, Electron, or persistent DB. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const dist = (...parts) => path.join(ROOT, 'dist/main/main', ...parts);
const loggerModule = require(dist('services/logger-service.js'));
const logCalls = [];
loggerModule.getLogger = () => ({
  info: message => logCalls.push(['info', message]), debug: message => logCalls.push(['debug', message]),
  diag: message => logCalls.push(['diag', message]), warn(){}, error(){}, success(){}, isDiagEnabled(){ return false; },
});
const { PlaywrightFilterRuntimeProvider } = require(dist('sources/filter-runtime-provider.js'));
const { SELECTORS } = require(path.join(ROOT, 'dist/main/utils/selector-repository.js'));
const { SQLiteService } = require(dist('services/sqlite-service.js'));
const { PendingExportRecovery } = require(dist('services/pending-export-recovery.js'));
const { MonitoringEngine } = require(dist('services/monitoring-engine.js'));
const { FingerprintGenerator } = require(dist('services/fingerprint-generator.js'));

const evaluatePage = elements => {
  const calls = { evaluate: 0, $eval: 0, inputValue: 0 };
  return { calls, page: {
    async evaluate(callback, argument) {
      calls.evaluate++;
      const previous = global.document;
      global.document = { querySelector: selector => elements[selector] || null };
      try { return callback(argument); } finally { global.document = previous; }
    },
    async $eval(){ calls.$eval++; }, async inputValue(){ calls.inputValue++; },
  }};
};
const input = (type, value = '') => ({ tagName: 'INPUT', value, getAttribute: name => name === 'type' ? type : null });
const txn = fp => ({ userName:'User', bank:'', accountName:'', accountNumber:'123', amount:10, status:'Approved', done:'Yes', depositType:'', agent:'', processDate:'2026-09-08 00:00:00', createdAt:'', transactionFingerprint:fp, filterProfile:'P', exportStatus:'pending' });

function fakeDb() {
  const metrics = { claimPrepares: 0, claimRuns: 0, countPrepares: 0, countGets: 0, closed: false };
  return { metrics, prepare(sql) {
    if (/ON CONFLICT\(transaction_fingerprint\) DO NOTHING/.test(sql)) {
      metrics.claimPrepares++; return { run(){ metrics.claimRuns++; return { changes: metrics.claimRuns === 1 ? 1 : 0 }; } };
    }
    if (/COUNT\(\*\).*export_status = 'pending'/s.test(sql)) {
      metrics.countPrepares++; return { get(){ metrics.countGets++; return { count: 17 }; } };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, close(){ metrics.closed = true; } };
}

function recoverySqlite(rows, metrics) {
  return {
    async getPendingExports(){ metrics.rowLoads++; return rows.filter(row => row.exportStatus === 'pending'); },
    async getPendingExportCount(){ metrics.counts++; return rows.filter(row => row.exportStatus === 'pending').length; },
    async updateExportStatus(fps){ metrics.events.push(`mark:${fps.join(',')}`); rows.forEach(row => { if (fps.includes(row.transactionFingerprint)) row.exportStatus='exported'; }); },
    async saveResumeMarker(key){ metrics.events.push(`marker:${key}`); },
  };
}

(async () => {
  // A-J: execute the production evaluate callback against a minimal DOM model.
  const elements = {
    [SELECTORS.FILTER.DEPOSIT_TYPE]: { tagName:'SELECT', options:[{ value:' 286 ', textContent:' Manual Deposit ' }] },
    [SELECTORS.FILTER.DEPOSIT_STATUS]: { tagName:'SELECT', options:[{ value:' Approve ', textContent:' Approved ' }] },
    [SELECTORS.FILTER.AGENT_INPUT]: input('search'),
    [SELECTORS.FILTER.DATE_FROM]: input('date', ' 2026-09-08 '),
  };
  const runtime = evaluatePage(elements);
  const snapshot = await new PlaywrightFilterRuntimeProvider(runtime.page).readSnapshot();
  assert.deepStrictEqual(snapshot.payment, { kind:'SELECT', options:[{ value:'286', label:'Manual Deposit' }] });
  assert.deepStrictEqual(snapshot.status, { kind:'SELECT', options:[{ value:'Approve', label:'Approved' }] });
  assert.deepStrictEqual(snapshot.agent, { kind:'FREE_TEXT' });
  assert.deepStrictEqual(snapshot.dateFrom, { available:true, value:' 2026-09-08 ' });
  assert.deepStrictEqual(snapshot.dateTo, { available:false, value:'' });
  assert.deepStrictEqual(runtime.calls, { evaluate:1, $eval:0, inputValue:0 });
  for (const type of ['hidden','checkbox','radio']) {
    const fixture = evaluatePage({ ...elements, [SELECTORS.FILTER.AGENT_INPUT]: input(type) });
    assert.strictEqual((await new PlaywrightFilterRuntimeProvider(fixture.page).readSnapshot()).agent.kind, 'UNAVAILABLE');
  }
  const missing = evaluatePage({ ...elements, [SELECTORS.FILTER.AGENT_INPUT]: undefined });
  assert.strictEqual((await new PlaywrightFilterRuntimeProvider(missing.page).readSnapshot()).agent.kind, 'UNAVAILABLE');

  // K-Q: one prepared claim statement per connection lifecycle, N runs, conflict result unchanged.
  const sqlite = new SQLiteService({ getDatabasePath(){ return ':memory:'; } });
  const db1 = fakeDb(); sqlite.db = db1;
  assert.strictEqual(await sqlite.claimTransaction(txn('a'.repeat(40))), true);
  for (let i=1; i<1000; i++) assert.strictEqual(await sqlite.claimTransaction(txn(String(i).padStart(40,'0'))), false);
  assert.strictEqual(db1.metrics.claimPrepares, 1); assert.strictEqual(db1.metrics.claimRuns, 1000);
  assert.strictEqual(await sqlite.getPendingExportCount(), 17);
  assert.strictEqual(db1.metrics.countPrepares, 1); assert.strictEqual(db1.metrics.countGets, 1);
  sqlite.close(); assert.strictEqual(sqlite.claimTransactionStatement, null);
  const db2 = fakeDb(); sqlite.db = db2;
  assert.strictEqual(await sqlite.claimTransaction(txn('b'.repeat(40))), true);
  assert.strictEqual(db2.metrics.claimPrepares, 1);

  // T-U: startup and stats count-only paths never request durable rows.
  const engineMetrics = { counts:0, rowLoads:0 };
  const engineSqlite = {
    async loadFingerprints(){ return new Set(); }, async getPendingExportCount(){ engineMetrics.counts++; return 4; },
    async getPendingExports(){ engineMetrics.rowLoads++; throw new Error('must not materialize'); }, async getResumeMarker(){ return null; },
    async getStoredTransactionCount(){ return 0; }, async getTodayExportCount(){ return 0; }, isReady(){ return true; },
    async claimTransaction(){ return true; },
  };
  const config = { monitoring:{ batchSize:1000 }, features:{ manualDateMode:true, initialSyncMode:false } };
  const engine = new MonitoringEngine({}, { async loadProfiles(){}, getEnabledProfiles(){ return []; } }, {}, {}, engineSqlite, { isConnected(){ return false; } }, { async loadAppConfig(){ return config; } }, { maxConcurrentScans:1 });
  await engine.initialize(); await engine.updateExportStats();
  assert.strictEqual(engineMetrics.rowLoads, 0); assert.strictEqual(engineMetrics.counts, 2);

  // V-Z: skipped paths count scalars; a real drain loads once and preserves writer/finalization ordering.
  let metrics = { rowLoads:0, counts:0, events:[] }; let rows = [txn('1'.repeat(40)), txn('2'.repeat(40))];
  let recovery = new PendingExportRecovery(recoverySqlite(rows, metrics), { isConnected(){ return false; } });
  let result = await recovery.recover();
  assert.strictEqual(result.skipped, 'SHEETS_UNAVAILABLE'); assert.strictEqual(result.remaining, 2); assert.strictEqual(metrics.rowLoads, 0);

  metrics = { rowLoads:0, counts:0, events:[] }; rows = [txn('3'.repeat(40))]; let now = 100;
  const failingSheets = { isConnected(){ return true; }, async getExportedKeyIdState(){ throw new Error('offline'); } };
  recovery = new PendingExportRecovery(recoverySqlite(rows, metrics), failingSheets, () => false, () => now);
  await recovery.recover(); metrics.rowLoads = 0; const countsBeforeBackoff = metrics.counts;
  result = await recovery.recover(); assert.strictEqual(result.skipped, 'BACKOFF'); assert.strictEqual(metrics.rowLoads, 0); assert.strictEqual(metrics.counts, countsBeforeBackoff + 1);

  metrics = { rowLoads:0, counts:0, events:[] }; rows = [txn('4'.repeat(40))];
  recovery = new PendingExportRecovery(recoverySqlite(rows, metrics), { isConnected(){ return true; } }, () => true);
  result = await recovery.recover(); assert.strictEqual(result.skipped, 'STOPPED'); assert.strictEqual(metrics.rowLoads, 0); assert.strictEqual(result.remaining, 1);

  metrics = { rowLoads:0, counts:0, events:[] }; rows = [txn('a1234567'.padEnd(40,'a')), txn('b1234567'.padEnd(40,'b'))]; let stateReads=0;
  const sheets = { isConnected(){ return true; }, async getExportedKeyIdState(){ stateReads++; return { keyIds:new Set(['A1234567']), latestKeyId:'A1234567' }; }, async appendTransactions(items){ metrics.events.push(`append:${items.map(x=>x.transactionFingerprint).join(',')}`); } };
  recovery = new PendingExportRecovery(recoverySqlite(rows, metrics), sheets);
  result = await recovery.recover({ batchSize:10 });
  assert.strictEqual(metrics.rowLoads, 1); assert.strictEqual(metrics.counts, 1); assert.strictEqual(stateReads, 1);
  assert.strictEqual(result.alreadyRemote, 1); assert.strictEqual(result.appended, 1); assert.strictEqual(result.remaining, 0);
  assert.ok(metrics.events.findIndex(x=>x.startsWith('append:')) < metrics.events.findLastIndex(x=>x.startsWith('mark:')));

  // AA-AD: hot row details use diag while identity vectors and summary logging remain intact.
  logCalls.length = 0;
  const generator = new FingerprintGenerator();
  const fp = generator.generate({ userName:' Alice   Example ', accountNumber:'0012-345 678', amount:1000.6, processDate:' 2026-08-01 10:20:30 ' });
  assert.strictEqual(generator.getShortFingerprint(fp), '2ED37DA2');
  assert.ok(logCalls.some(([level,message]) => level === 'diag' && message.startsWith('Fingerprint:')));
  assert.ok(!logCalls.some(([level]) => level === 'debug' || level === 'info'));
  const monitoringSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  for (const detail of ['Transaction validated:', 'SQLite-confirmed duplicate:', 'Buffered new transaction']) assert.ok(monitoringSource.includes(`diag(\`${detail}`));
  for (const summary of ['PAGINATION SUMMARY', 'PIPELINE AUDIT']) assert.ok(monitoringSource.includes(summary));
  assert.ok(fs.readFileSync(path.join(ROOT, 'src/main/services/pending-export-recovery.ts'), 'utf8').includes('[PENDING RECOVERY] complete'));

  console.log('[PHASE 11 PERFORMANCE]');
  console.log('FAST runtime snapshot page calls : 5 baseline -> 1');
  console.log('SQLite claim prepares / 1000     : 1000 baseline -> 1');
  console.log('Sheets-unavailable row loads      : full baseline -> 0 full-row loads');
  console.log('Backoff row loads                 : full baseline -> 0 full-row loads');
  console.log('Post-drain count full reload      : 1 baseline -> 0');
  console.log('Default row-level normal logs     : suppressed behind diagnostic mode');
  console.log('PASS: Phase 11 deterministic operation-count and frozen-behavior gates.');
})().catch(error => { console.error(error); process.exitCode = 1; });
