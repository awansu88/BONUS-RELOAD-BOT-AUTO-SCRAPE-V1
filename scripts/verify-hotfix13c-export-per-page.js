/** Hotfix 13C verifier. Portable: no live browser, database, Electron, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const loggerSvc = require(path.join(ROOT, 'dist/main/main/services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){} });
const strategy = require(path.join(ROOT, 'dist/main/types/export-strategy.js'));
const constants = require(path.join(ROOT, 'dist/main/utils/constants.js'));
const { PageScanner } = require(path.join(ROOT, 'dist/main/main/services/page-scanner.js'));

assert.strictEqual(strategy.normalizeExportStrategy(undefined), 'BATCHED');
assert.strictEqual(strategy.normalizeExportStrategy('invalid'), 'BATCHED');
assert.strictEqual(strategy.normalizeExportStrategy('PER_PAGE'), 'PER_PAGE');
assert.strictEqual(constants.DEFAULT_CONFIG.monitoring.exportStrategy, 'BATCHED');

const settings = read('src/renderer/pages/SettingsPage.tsx');
assert.match(settings, /data-testid="export-strategy-select"/);
assert.match(settings, /value="BATCHED"/); assert.match(settings, /value="PER_PAGE"/);
assert.match(settings, /exportStrategy: 'BATCHED'/); assert.match(settings, /saveAppConfig\(config\)/);
assert.match(settings, /normalizeExportStrategy\(config\.monitoring\.exportStrategy\)/);
assert.match(settings, /SQLite and the safe writer queue/);

const contract = read('src/main/sources/source-adapter.ts');
assert.match(contract, /onPage\?: \(page: SourcePageBatch\) => Promise<void>/);
const legacy = read('src/main/sources/legacy-browser-source-adapter.ts');
assert.match(legacy, /scanner\.scanPages\(request\.filter, request\.maxPages, request\.onPage\)/);
const fast = read('src/main/sources/fast-http-source-adapter.ts');
assert.ok(fast.indexOf('await request.onPage?.') < fast.indexOf("return result('FULL_DUPLICATE_PAGE')"));
assert.ok(fast.indexOf('await request.onPage?.') < fast.indexOf('nextUrl = candidate'));
assert.match(fast, /http\.get\(nextUrl\.toString\(\)\)/);
assert.doesNotMatch(fast, /http\.(?:post|put|patch|delete|fetch)\s*\(/);

const engine = read('src/main/services/monitoring-engine.ts');
assert.match(engine, /onPage: perPage \?/);
assert.match(engine, /if \(!perPage\) \{\s*for \(const raw of result\.transactions\)/);
assert.match(engine, /processTransaction\(raw, filter, true\)/);
assert.match(engine, /!suppressBatchTrigger && this\.buffer\.length >= batchSize/);
assert.match(engine, /if \(accepted > 0\) await this\.drainDurablePending\(\)/);
assert.match(engine, /drainDurablePending[\s\S]*?recoverPendingExports\(\)/);
assert.match(engine, /this\.exportWriterQueue\.enqueue/);
assert.doesNotMatch(engine, /appendTransactions\s*\(/);
assert.doesNotMatch(fast + legacy + read('src/main/services/page-scanner.ts'), /appendTransactions\s*\(/);
assert.match(read('src/main/sources/fast-http-source-pool.ts'), /maxConcurrentScans = 2/);
assert.match(engine, /return advertised === 2 \? 2 : 1/);

const raw = { userName: 'u', accountNumber: 'a', amount: 1, processDate: '2026-01-01' };
function scannerFor(duplicateCheck) {
  const events = [];
  const page = { url: () => 'https://example.invalid/deposit/transactions?page=1' };
  const scanner = new PageScanner(page);
  scanner.htmlMapper = { parseCurrentPage: async () => ({ transactions: [raw], rowsDetected: 1, rejections: [] }) };
  scanner.getActivePageFromDom = async () => 1;
  scanner.hasNextPage = async () => { events.push('navigation-check'); return false; };
  scanner.setShouldStop(() => false); scanner.setDuplicateCheck(duplicateCheck);
  return { scanner, events };
}

(async () => {
  const withCallback = scannerFor(() => false);
  let calls = 0;
  const result = await withCallback.scanner.scanPages({ name: 'safe' }, 10, async page => {
    calls++; withCallback.events.push('callback'); assert.strictEqual(page.stats.duplicate, 0);
  });
  assert.strictEqual(calls, 1); assert.deepStrictEqual(withCallback.events, ['callback', 'navigation-check']);
  assert.strictEqual(result.transactions.length, 1);

  const duplicate = scannerFor(() => true);
  let duplicateCalls = 0;
  const duplicateResult = await duplicate.scanner.scanPages({ name: 'safe' }, 10, async page => {
    duplicateCalls++; assert.strictEqual(page.stats.duplicate, 1);
  });
  assert.strictEqual(duplicateCalls, 1);
  assert.strictEqual(duplicateResult.terminationReason, 'FULL_DUPLICATE_PAGE');
  assert.deepStrictEqual(duplicate.events, []);

  const omitted = scannerFor(() => false);
  const omittedResult = await omitted.scanner.scanPages({ name: 'safe' }, 1);
  assert.strictEqual(omittedResult.transactions.length, 1);

  const migration = read('src/main/services/database-migration.ts');
  assert.deepStrictEqual([...migration.matchAll(/version:\s*(\d+)/g)].map(match => Number(match[1])), [1]);
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'package-lock.json')), true);
  console.log('PASS: Hotfix 13C export strategy, page handoff, durable writer, and frozen-contract checks.');
})().catch(error => { console.error(error); process.exitCode = 1; });
