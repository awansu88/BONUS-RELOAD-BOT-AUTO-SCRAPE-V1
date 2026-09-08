/** Phase 8 portable export-writer queue tests. No native runtime or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const { ExportWriterQueue } = require(path.join(DIST, 'services/export-writer-queue.js'));

const result = (appended = 0, skipped = null) => ({
  pendingFound: appended,
  alreadyRemote: 0,
  appended,
  reconciled: appended,
  remaining: 0,
  skipped,
  failureClass: null,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

(async () => {
  // A: one signal invokes recovery once.
  let calls = 0;
  let queue = new ExportWriterQueue({ recover: async () => { calls++; return result(); } });
  assert.deepEqual(await queue.enqueue(), result());
  assert.equal(calls, 1);

  // B/C/D: concurrent and blocked requests remain FIFO, single-active, exactly once.
  const gate = deferred();
  const started = [];
  const finished = [];
  let active = 0;
  let maxActive = 0;
  queue = new ExportWriterQueue({
    recover: async options => {
      const id = options.batchSize;
      started.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      if (id === 1) await gate.promise;
      await Promise.resolve();
      active--;
      finished.push(id);
      return result(id);
    },
  });
  const requests = Array.from({ length: 20 }, (_, index) => queue.enqueue({ batchSize: index + 1 }));
  await Promise.resolve();
  assert.deepEqual(started, [1], 'a request arriving behind a blocked drain must wait');
  gate.resolve();
  const results = await Promise.all(requests);
  assert.equal(maxActive, 1);
  assert.deepEqual(started, Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(finished, started);
  assert.deepEqual(results.map(item => item.appended), started);

  // E: a rejection reaches only its caller and cannot poison the tail.
  calls = 0;
  queue = new ExportWriterQueue({
    recover: async () => {
      calls++;
      if (calls === 1) throw new Error('unexpected fixture failure');
      return result(2);
    },
  });
  const failed = queue.enqueue();
  const survived = queue.enqueue();
  await assert.rejects(failed, /unexpected fixture failure/);
  assert.equal((await survived).appended, 2);
  assert.equal(calls, 2);

  // F/G: every request retains its own options without coalescing.
  const seenOptions = [];
  queue = new ExportWriterQueue({
    recover: async options => { seenOptions.push(options); return result(); },
  });
  await Promise.all([
    queue.enqueue({ force: false, batchSize: 7 }),
    queue.enqueue({ force: true, batchSize: 23 }),
  ]);
  assert.deepEqual(seenOptions, [
    { force: false, batchSize: 7 },
    { force: true, batchSize: 23 },
  ]);

  // H/I: recovery-owned skip/backoff results pass through unchanged.
  const backoff = { ...result(), skipped: 'BACKOFF', remaining: 4 };
  const unavailable = { ...result(), skipped: 'SHEETS_UNAVAILABLE', remaining: 5 };
  const passThrough = [backoff, unavailable];
  queue = new ExportWriterQueue({ recover: async () => passThrough.shift() });
  assert.strictEqual(await queue.enqueue(), backoff);
  assert.strictEqual(await queue.enqueue(), unavailable);

  // J: callers receive the result from their own invocation, never a shared result.
  const ownResults = [result(10), result(0)];
  queue = new ExportWriterQueue({ recover: async () => ownResults.shift() });
  const [first, second] = await Promise.all([queue.enqueue(), queue.enqueue()]);
  assert.equal(first.appended, 10);
  assert.equal(second.appended, 0);
  assert.notStrictEqual(first, second);

  const queueSource = fs.readFileSync(path.join(ROOT, 'src/main/services/export-writer-queue.ts'), 'utf8');
  const engineSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  const recoverySource = fs.readFileSync(path.join(ROOT, 'src/main/services/pending-export-recovery.ts'), 'utf8');
  const productionFiles = [];
  const collect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target);
      else if (entry.name.endsWith('.ts')) productionFiles.push(target);
    }
  };
  collect(path.join(ROOT, 'src/main'));

  // K: the queue API is drain-signal-only and has no transaction payload contract.
  for (const forbidden of ['Transaction[]', 'RawTransaction[]', 'fingerprints[]']) {
    assert.ok(!queueSource.includes(forbidden), `queue must not accept ${forbidden}`);
  }
  assert.match(queueSource, /enqueue\(options: ExportDrainOptions/);
  assert.ok(!queueSource.includes('setInterval'));

  // L-P: one owner pair and all MonitoringEngine triggers route through the queue.
  assert.equal((engineSource.match(/new PendingExportRecovery\(/g) || []).length, 1);
  assert.equal((engineSource.match(/new ExportWriterQueue\(/g) || []).length, 1);
  assert.match(engineSource, /new ExportWriterQueue\(this\.pendingExportRecovery\)/);
  const hookBody = engineSource.slice(engineSource.indexOf('async recoverPendingExports'), engineSource.indexOf('private setState'));
  assert.match(hookBody, /this\.exportWriterQueue\.enqueue/);
  assert.ok(!hookBody.includes('pendingExportRecovery.recover'));
  assert.match(engineSource, /recoverPendingExports\(\{ force: true \}\)/);
  const cycleBody = engineSource.slice(engineSource.indexOf('private async runMonitoringCycle'), engineSource.indexOf('private async processFilter'));
  assert.match(cycleBody, /await this\.recoverPendingExports\(\)/);
  const exportBody = engineSource.slice(engineSource.indexOf('private async exportBuffer'), engineSource.indexOf('private async updateExportStats'));
  assert.match(exportBody, /await this\.recoverPendingExports\(\)/);
  assert.ok(!exportBody.includes('insertTransactions'));

  // R: PendingExportRecovery remains the only production append caller.
  const appendCallers = productionFiles.filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return /\.appendTransactions\s*\(/.test(source) && !file.endsWith('google-sheets-service.ts');
  });
  assert.deepEqual(appendCallers.map(file => path.relative(ROOT, file)), ['src/main/services/pending-export-recovery.ts']);
  assert.match(recoverySource, /googleSheetsService\.appendTransactions\(missing\)/);

  // S-V: Legacy stays default, FAST stays dormant, and Phase 9 is not started.
  assert.match(engineSource, /sourceAdapter \?\? new LegacyBrowserSourceAdapter/);
  assert.ok(!engineSource.includes('FastHttpSourceAdapter'));
  assert.match(engineSource, /for \(const filter of filters\)/);
  assert.ok(!cycleBody.includes('Promise.all'));
  assert.ok(!/filter.{0,30}(worker|concurr)/i.test(cycleBody));

  console.log('PASS: Phase 8 export writer queue A-V (FIFO, isolation, options, wiring, and structural guards).');
})().catch(error => { console.error(error); process.exitCode = 1; });
