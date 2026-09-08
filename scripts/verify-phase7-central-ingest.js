/** Phase 7 portable central-ingest tests. No native runtime or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { TransactionValidator } = require(path.join(DIST, 'services/transaction-validator.js'));
const { FingerprintGenerator } = require(path.join(DIST, 'services/fingerprint-generator.js'));
const { CentralIngestService } = require(path.join(DIST, 'services/central-ingest-service.js'));
const { MonitoringEngine } = require(path.join(DIST, 'services/monitoring-engine.js'));
const raw = {
  userName: ' Alice   Example ', bank: 'BCA', accountName: 'Alice Example',
  accountNumber: '0012-345 678', amount: 1000.6, status: 'Approved', done: 'Yes',
  depositType: 'SANITIZED', agent: 'Test Agent', processDate: ' 2026-08-01 10:20:30 ',
  createdAt: '2026-08-01 10:20:00'
};
const makeIngest = claimTransaction => new CentralIngestService(
  new TransactionValidator(), new FingerprintGenerator(), { claimTransaction });

(async () => {
  let claimed;
  let service = makeIngest(async transaction => { claimed = transaction; return true; });
  const accepted = await service.ingest(raw, 'Profile A');
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(accepted.fingerprint, '2ed37da2610fac3a1ca8fce5c28f5f838b40a623');
  assert.deepEqual(accepted.transaction, claimed);
  assert.deepEqual(Object.keys(accepted.transaction).sort(), [...Object.keys(raw), 'transactionFingerprint', 'filterProfile', 'exportStatus'].sort());
  assert.equal(accepted.transaction.exportStatus, 'pending');
  let claims = 0;
  service = makeIngest(async () => { claims++; return true; });
  const rejected = await service.ingest({ ...raw, accountNumber: '' }, 'Profile A');
  assert.equal(rejected.status, 'REJECTED'); assert.ok(rejected.errors.length); assert.equal(claims, 0);
  const duplicate = await makeIngest(async () => false).ingest(raw, 'Profile A');
  assert.deepEqual(duplicate, { status: 'DUPLICATE', fingerprint: accepted.fingerprint });
  await assert.rejects(() => makeIngest(async () => { throw new Error('sqlite unavailable'); }).ingest(raw, 'Profile A'), /sqlite unavailable/);
  const fp = new FingerprintGenerator();
  assert.equal(fp.generate(raw), '2ed37da2610fac3a1ca8fce5c28f5f838b40a623');
  assert.equal(fp.generate({ ...raw, accountNumber: '0012 345-678' }), fp.generate(raw));
  assert.equal((await makeIngest(async () => true).ingest(raw, 'Other Profile')).fingerprint, accepted.fingerprint);

  const centralSource = fs.readFileSync(path.join(ROOT, 'src/main/services/central-ingest-service.ts'), 'utf8');
  const engineSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  for (const forbidden of ['SourceAdapter', 'LegacyBrowserSourceAdapter', 'FastHttpSourceAdapter', 'PageScanner', 'HTMLMapper', 'RawHttpHtmlParser', 'GoogleSheetsService', 'PendingExportRecovery']) assert.ok(!centralSource.includes(forbidden), `central ingest must not reference ${forbidden}`);
  assert.match(engineSource, /new CentralIngestService\(validator, fingerprintGen, sqliteService\)/);
  const processBody = engineSource.slice(engineSource.indexOf('private async processTransaction'), engineSource.indexOf('private isDuplicate'));
  assert.match(processBody, /centralIngestService\.ingest/); assert.ok(!processBody.includes('this.isDuplicate(')); assert.ok(!processBody.includes('.has('));
  const exportBody = engineSource.slice(engineSource.indexOf('private async exportBuffer'), engineSource.indexOf('private async updateExportStats'));
  assert.ok(!exportBody.includes('insertTransactions')); assert.match(exportBody, /recoverPendingExports/);
  assert.match(engineSource, /new LegacyBrowserSourceAdapter\(playwrightService\)/);
  assert.match(engineSource, /new FastHttpSourcePool\(playwrightService\)/);

  const claimResults = [true, false];
  const sqlite = { claimTransaction: async () => claimResults.shift(), getPendingExports: async () => [] };
  const engine = new MonitoringEngine({}, {}, new TransactionValidator(), new FingerprintGenerator(), sqlite, { isConnected: () => false }, {});
  engine.config = { monitoring: { batchSize: 1000 } };
  await engine.processTransaction(raw, { name: 'Profile A' });
  await engine.processTransaction(raw, { name: 'Profile B' });
  await engine.processTransaction({ ...raw, userName: '' }, { name: 'Profile A' });
  assert.deepEqual(engine.cycleCounters, { parsed: 3, validated: 2, duplicates: 1, rejected: 1, fingerprintsCreated: 2, buffered: 1, sqliteInserted: 1, sheetsAppended: 0, markedExported: 0 });
  assert.equal(engine.buffer.length, 1); assert.equal(engine.getExportStats().newTransactions, 1);
  console.log('PASS: Phase 7 portable central ingest A-P (real validation/fingerprint, delegation, cache, export and counters).');
})().catch(error => { console.error(error); process.exitCode = 1; });
