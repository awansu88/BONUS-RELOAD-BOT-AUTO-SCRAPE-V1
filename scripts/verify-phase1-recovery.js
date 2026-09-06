/** Phase 1 durable pending-export recovery tests. No network or customer data. */
const assert = require('assert');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { PendingExportRecovery } = require(path.join(DIST, 'services/pending-export-recovery.js'));
const { MonitoringEngine } = require(path.join(DIST, 'services/monitoring-engine.js'));

const tx = (key, date = '2026-08-01 10:00:00') => ({
  userName: 'fixture', bank: '', accountName: '', accountNumber: '100', amount: 100,
  status: 'Approved', done: 'Yes', depositType: '', agent: '', processDate: date,
  createdAt: date, transactionFingerprint: key.padEnd(40, '0').toLowerCase(),
  filterProfile: 'fixture', exportStatus: 'pending',
});

function fixture(initial, remote = []) {
  const store = { rows: initial.map(t => ({ ...t })), marker: null };
  const calls = { append: 0, marker: 0, mark: 0 };
  const sqlite = {
    getPendingExports: async () => store.rows.filter(t => t.exportStatus === 'pending'),
    updateExportStatus: async (fps, status) => {
      calls.mark++;
      store.rows.filter(t => fps.includes(t.transactionFingerprint)).forEach(t => t.exportStatus = status);
    },
    saveResumeMarker: async key => { calls.marker++; store.marker = key; },
  };
  const remoteIds = new Set(remote);
  const sheets = {
    isConnected: () => true,
    getExportedKeyIds: async () => new Set(remoteIds),
    appendTransactions: async rows => {
      calls.append++;
      rows.forEach(t => remoteIds.add(t.transactionFingerprint.slice(0, 8).toUpperCase()));
      return {};
    },
  };
  return { store, calls, sqlite, sheets, remoteIds };
}

(async () => {
  // A: startup-style pending recovery; B: already remote reconciliation.
  let f = fixture([tx('AAAAAAAA')]);
  let r = await new PendingExportRecovery(f.sqlite, f.sheets).recover({ force: true });
  assert.equal(f.calls.append, 1); assert.equal(r.remaining, 0); assert.equal(f.store.rows[0].exportStatus, 'exported');
  f = fixture([tx('BBBBBBBB')], ['BBBBBBBB']);
  r = await new PendingExportRecovery(f.sqlite, f.sheets).recover({ force: true });
  assert.equal(f.calls.append, 0); assert.equal(r.alreadyRemote, 1); assert.equal(r.remaining, 0);

  // C: append failure leaves pending and marker untouched; a later drain succeeds.
  f = fixture([tx('CCCCCCCC')]);
  const realAppend = f.sheets.appendTransactions; let failAppend = true;
  f.sheets.appendTransactions = async rows => { if (failAppend) throw new Error('fixture'); return realAppend(rows); };
  const recoveryC = new PendingExportRecovery(f.sqlite, f.sheets);
  r = await recoveryC.recover({ force: true });
  assert.equal(r.failureClass, 'SHEETS_APPEND'); assert.equal(f.store.rows[0].exportStatus, 'pending'); assert.equal(f.calls.marker, 0);
  failAppend = false; r = await recoveryC.recover({ force: true }); assert.equal(r.remaining, 0);

  // D: append success + mark failure reconciles on the next attempt without duplicate append.
  f = fixture([tx('DDDDDDDD')]); let failMark = true;
  const markD = f.sqlite.updateExportStatus;
  f.sqlite.updateExportStatus = async (...args) => { if (failMark) throw new Error('fixture'); return markD(...args); };
  const recoveryD = new PendingExportRecovery(f.sqlite, f.sheets);
  r = await recoveryD.recover({ force: true }); assert.equal(r.failureClass, 'LOCAL_FINALIZATION'); assert.equal(f.calls.append, 1);
  failMark = false; r = await recoveryD.recover({ force: true }); assert.equal(f.calls.append, 1); assert.equal(r.remaining, 0);

  // E: marker failure occurs after exported status and therefore cannot re-append.
  f = fixture([tx('EEEEEEEE')]); let failMarker = true;
  const markerE = f.sqlite.saveResumeMarker;
  f.sqlite.saveResumeMarker = async key => { if (failMarker) throw new Error('fixture'); return markerE(key); };
  const recoveryE = new PendingExportRecovery(f.sqlite, f.sheets);
  r = await recoveryE.recover({ force: true }); assert.equal(r.failureClass, 'LOCAL_FINALIZATION'); assert.equal(f.store.rows[0].exportStatus, 'exported');
  failMarker = false; await recoveryE.recover({ force: true }); assert.equal(f.calls.append, 1);

  // F: concurrent trigger is rejected by the single-drain guard.
  f = fixture([tx('FFFFFFFF')]); let release;
  f.sheets.getExportedKeyIds = () => new Promise(resolve => { release = () => resolve(new Set()); });
  const recoveryF = new PendingExportRecovery(f.sqlite, f.sheets);
  const first = recoveryF.recover({ force: true });
  await Promise.resolve();
  const second = await recoveryF.recover({ force: true }); assert.equal(second.skipped, 'RUNNING');
  release(); await first; assert.equal(f.calls.append, 1);

  // G: a recreated owner recovers the same durable store without browser activity.
  f = fixture([tx('99999999')]);
  const stoppedProcessOwner = new PendingExportRecovery(f.sqlite, f.sheets);
  assert.ok(stoppedProcessOwner); // process exits before it gets a recovery opportunity
  await new PendingExportRecovery(f.sqlite, f.sheets).recover({ force: true });
  assert.equal(f.store.rows[0].exportStatus, 'exported'); assert.equal(f.calls.append, 1);

  // H: write-ahead failure is surfaced and Sheets is never invoked.
  let sheetsCalls = 0;
  const engine = new MonitoringEngine({}, {}, {}, {}, {
    insertTransactions: async () => { throw new Error('fixture local persistence failure'); },
  }, { isConnected: () => true, appendTransactions: async () => { sheetsCalls++; } }, {});
  engine.isRunning = true; engine.buffer = [tx('12121212')];
  await assert.rejects(() => engine.exportBuffer(), /local persistence failure/);
  assert.equal(sheetsCalls, 0); assert.equal(engine.buffer.length, 1);

  // I: one remote row plus two missing rows is one safe missing-only batch.
  f = fixture([tx('A1A1A1A1', '2026-01-01'), tx('B2B2B2B2', '2026-01-02'), tx('C3C3C3C3', '2026-01-03')], ['A1A1A1A1']);
  r = await new PendingExportRecovery(f.sqlite, f.sheets).recover({ force: true, batchSize: 100 });
  assert.equal(r.alreadyRemote, 1); assert.equal(r.appended, 2); assert.equal(f.calls.append, 1); assert.equal(r.remaining, 0);

  console.log('PASS: Phase 1 recovery matrix A-I (durability, reconciliation, failures, guard, restart, batching).');
})().catch(error => { console.error(error); process.exitCode = 1; });
