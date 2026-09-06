/**
 * Phase 0 native SQLite compatibility gate.
 *
 * Must run through Electron 28 (`npm run test:phase0:sqlite`) so
 * better-sqlite3 uses the same native ABI as the production application.
 * An unavailable Electron binary or native binding is a hard failure.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '..', 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({
  info() {}, warn() {}, error() {}, debug() {}, success() {}, diag() {},
  isDiagEnabled() { return false; }
});
const { SQLiteService } = require(path.join(DIST, 'services/sqlite-service.js'));

const FINGERPRINT = '2ed37da2610fac3a1ca8fce5c28f5f838b40a623';
const RESUME_MARKER = '2ED37DA2';

(async () => {
  assert.strictEqual(String(process.versions.electron || '').split('.')[0], '28',
    `SQLite gate requires Electron 28; received ${process.versions.electron || 'plain Node'}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-sqlite-'));
  const dbPath = path.join(tempDir, 'monitoring-v1.db');
  let sqlite;

  try {
    const fixture = new Database(dbPath);
    fixture.exec(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_fingerprint TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        amount REAL NOT NULL,
        process_date TEXT NOT NULL,
        filter_profile TEXT NOT NULL,
        export_status TEXT NOT NULL DEFAULT 'pending',
        exported_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_fingerprint ON transactions(transaction_fingerprint);
      CREATE INDEX idx_process_date ON transactions(process_date);
      CREATE INDEX idx_export_status ON transactions(export_status);
      CREATE INDEX idx_created_at ON transactions(created_at);
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_version(version) VALUES (1);
    `);
    fixture.prepare(`
      INSERT INTO transactions (
        transaction_fingerprint, user_id, account_number, amount,
        process_date, filter_profile, export_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(FINGERPRINT, 'fixture-user', '000111222', 125000,
      '2026-08-01 10:20:30', 'Sanitized legacy profile', 'pending');
    fixture.prepare(`INSERT INTO app_state(key, value) VALUES('resume_marker', ?)`)
      .run(RESUME_MARKER);
    fixture.close();

    sqlite = new SQLiteService({ getDatabasePath: () => dbPath });
    await sqlite.initialize();
    assert.strictEqual(sqlite.isReady(), true, 'existing version-1 database opens');
    assert.strictEqual((await sqlite.loadFingerprints()).has(FINGERPRINT), true,
      'existing fingerprint is recognized');
    const pending = await sqlite.getPendingExports();
    assert.strictEqual(pending.length, 1, 'existing pending transaction is loaded');
    assert.strictEqual(pending[0].transactionFingerprint, FINGERPRINT);
    assert.strictEqual(pending[0].exportStatus, 'pending');
    assert.strictEqual(pending[0].userName, 'fixture-user');
    assert.strictEqual(await sqlite.getResumeMarker(), RESUME_MARKER,
      'existing resume marker is readable');
    sqlite.close();
    sqlite = undefined;

    console.log('PASS: Electron 28 SQLite runtime compatibility (V1 open, fingerprint, pending row, resume marker, clean close).');
  } finally {
    if (sqlite) sqlite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('FAIL: Electron 28 SQLite runtime compatibility did not execute successfully.');
  console.error(error);
  process.exitCode = 1;
});
