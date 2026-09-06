/**
 * Phase 1 native restart-recovery gate. Runs through Electron 28 so the real
 * SQLiteService and production better-sqlite3 ABI are exercised. Sheets is a
 * sanitized in-memory boundary; this test performs no network access.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({
  info() {}, warn() {}, error() {}, debug() {}, success() {}, diag() {},
  isDiagEnabled() { return false; },
});
const { SQLiteService } = require(path.join(DIST, 'services/sqlite-service.js'));
const { PendingExportRecovery } = require(path.join(DIST, 'services/pending-export-recovery.js'));

const FINGERPRINT = 'abcdef1234567890abcdef1234567890abcdef12';
const KEY_ID = 'ABCDEF12';
const transaction = {
  userName: 'sanitized-fixture', bank: '', accountName: '', accountNumber: '000000',
  amount: 125000, status: 'Approved', done: 'Yes', depositType: '', agent: '',
  processDate: '2026-08-01 10:20:30', createdAt: '2026-08-01 10:20:00',
  transactionFingerprint: FINGERPRINT, filterProfile: 'Sanitized profile',
  exportStatus: 'pending',
};

(async () => {
  assert.strictEqual(String(process.versions.electron || '').split('.')[0], '28',
    `SQLite recovery gate requires Electron 28; received ${process.versions.electron || 'plain Node'}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-sqlite-recovery-'));
  const dbPath = path.join(tempDir, 'monitoring-v1.db');
  const appDirs = { getDatabasePath: () => dbPath };
  let sqlite;

  try {
    sqlite = new SQLiteService(appDirs);
    await sqlite.initialize();
    await sqlite.insertTransactions([transaction]);
    assert.strictEqual((await sqlite.getPendingExports()).length, 1);
    sqlite.close();
    sqlite = undefined;

    // Simulate a process restart with entirely new service and recovery owners.
    sqlite = new SQLiteService(appDirs);
    await sqlite.initialize();
    assert.strictEqual((await sqlite.getPendingExports()).length, 1,
      'pending row survives a complete SQLiteService close/reopen');

    const remoteRows = [];
    let appendCalls = 0;
    const sheets = {
      isConnected: () => true,
      getExportedKeyIdState: async () => ({
        keyIds: new Set(remoteRows),
        latestKeyId: remoteRows.length ? remoteRows[remoteRows.length - 1] : null,
      }),
      appendTransactions: async rows => {
        appendCalls++;
        rows.forEach(row => remoteRows.push(row.transactionFingerprint.slice(0, 8).toUpperCase()));
        return {};
      },
    };
    const recovery = new PendingExportRecovery(sqlite, sheets);
    const result = await recovery.recover({ force: true });
    assert.strictEqual(result.remaining, 0);
    assert.strictEqual(appendCalls, 1, 'restart recovery performs exactly one Sheets batch append');
    assert.deepStrictEqual(remoteRows, [KEY_ID]);
    assert.strictEqual((await sqlite.getPendingExports()).length, 0);
    assert.strictEqual(await sqlite.getResumeMarker(), KEY_ID);
    sqlite.close();
    sqlite = undefined;

    // A second reopen proves exported state is durable and not eligible again.
    sqlite = new SQLiteService(appDirs);
    await sqlite.initialize();
    assert.strictEqual((await sqlite.getPendingExports()).length, 0);
    sqlite.close();
    sqlite = undefined;

    console.log('PASS: Electron 28 Phase 1 SQLite restart recovery (close/reopen, one append, durable exported state).');
  } finally {
    if (sqlite) sqlite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('FAIL: Electron 28 Phase 1 SQLite restart recovery did not execute successfully.');
  console.error(error);
  process.exitCode = 1;
});
