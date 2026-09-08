/** Phase 7 native SQLite atomic-claim tests. Runs under Electron. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DIST = path.resolve(__dirname, '..', 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { SQLiteService } = require(path.join(DIST, 'services/sqlite-service.js'));
const transaction = (fingerprint, filter = 'First', overrides = {}) => ({
  userName: 'first-user', bank: '', accountName: '', accountNumber: '001-002', amount: 125,
  status: 'Approved', done: 'Yes', depositType: '', agent: '', processDate: '2026-08-01 10:20:30', createdAt: '2026-08-01 10:20:00',
  transactionFingerprint: fingerprint, filterProfile: filter, exportStatus: 'pending', ...overrides
});
(async () => {
  assert.equal(String(process.versions.electron || '').split('.')[0], '28', 'requires Electron 28');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-sqlite-')); const dbPath = path.join(dir, 'phase7.db');
  let sqlite = new SQLiteService({ getDatabasePath: () => dbPath });
  try {
    await sqlite.initialize(); const fp = 'a'.repeat(40);
    assert.equal(await sqlite.claimTransaction(transaction(fp)), true);
    assert.equal(await sqlite.claimTransaction(transaction(fp, 'Second', { userName: 'overwriter', amount: 999 })), false);
    let db = sqlite.getDb(); let row = db.prepare('SELECT * FROM transactions WHERE transaction_fingerprint=?').get(fp);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM transactions').get().count, 1);
    assert.equal(row.export_status, 'pending'); assert.equal(row.filter_profile, 'First'); assert.equal(row.user_id, 'first-user'); assert.equal(row.amount, 125);
    const same = await Promise.all(Array.from({ length: 25 }, () => sqlite.claimTransaction(transaction('b'.repeat(40)))));
    assert.equal(same.filter(Boolean).length, 1);
    assert.deepEqual(await Promise.all(['c', 'd', 'e'].map(x => sqlite.claimTransaction(transaction(x.repeat(40))))), [true, true, true]);
    await sqlite.updateExportStatus([fp], 'exported'); assert.equal(await sqlite.claimTransaction(transaction(fp, 'Third')), false);
    assert.equal(db.prepare('SELECT export_status FROM transactions WHERE transaction_fingerprint=?').get(fp).export_status, 'exported');
    const failedFp = 'f'.repeat(40); assert.equal(await sqlite.claimTransaction(transaction(failedFp)), true); await sqlite.updateExportStatus([failedFp], 'failed');
    assert.equal(await sqlite.claimTransaction(transaction(failedFp, 'Other')), false);
    assert.equal(db.prepare('SELECT export_status FROM transactions WHERE transaction_fingerprint=?').get(failedFp).export_status, 'failed');
    const pendingFp = '9'.repeat(40); assert.equal(await sqlite.claimTransaction(transaction(pendingFp, 'Across Filters')), true);
    assert.equal(await sqlite.claimTransaction(transaction(pendingFp, 'Other Filter')), false);
    assert.equal(db.prepare('SELECT filter_profile FROM transactions WHERE transaction_fingerprint=?').get(pendingFp).filter_profile, 'Across Filters');
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 1);
    sqlite.close(); sqlite = new SQLiteService({ getDatabasePath: () => dbPath }); await sqlite.initialize();
    assert.ok((await sqlite.getPendingExports()).some(row => row.transactionFingerprint === pendingFp));
    db = sqlite.getDb(); db.exec('DROP TABLE transactions');
    await assert.rejects(() => sqlite.claimTransaction(transaction('0'.repeat(40))), /no such table/);
    console.log('PASS: Phase 7 native SQLite Q-AB (atomic claim, first-writer wins, status, restart, schema and errors).');
  } finally { sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
