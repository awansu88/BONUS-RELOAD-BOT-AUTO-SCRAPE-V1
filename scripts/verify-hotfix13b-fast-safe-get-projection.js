/** Hotfix 13B verifier. Portable: no browser, Electron, database, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sourcePath = path.join(ROOT, 'src/main/sources/fast-http-source-adapter.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const { FastHttpSourceAdapter } = require(path.join(ROOT, 'dist/main/main/sources/fast-http-source-adapter.js'));
const { DepositRequestPreparationError } = require(path.join(ROOT, 'dist/main/main/sources/deposit-request-runtime-provider.js'));

const adapter = new FastHttpSourceAdapter({ getPage: () => null, getRequestContext: () => null });
const browser = pathname => new URL(`https://current.invalid${pathname}`);
const names = overrides => ({ status: 'state', payment: 'pay_code', agent: 'agent_code',
  dateFrom: 'from_date', dateTo: 'to_date', ...overrides });
const descriptor = overrides => ({ method: 'POST', action: '/deposit/transactions', names: names(), ...overrides });
const resolved = overrides => ({ status: { value: 'approved', source: 'VALUE' }, dateFrom: '2026-09-08',
  dateTo: '2026-09-09', manualDateMode: true, ...overrides });
const project = (d = descriptor(), r = resolved(), url = browser('/deposit/transactions')) =>
  adapter.firstRequestUrl(url, d, r);
const expectPreparation = (code, operation) => assert.throws(operation, error =>
  error instanceof DepositRequestPreparationError && error.code === code);

// A-Q: method policy, strict target trust, resolved runtime names/values, and query hygiene.
for (const method of ['GET', 'POST', ' post ']) {
  const target = project(descriptor({ method }));
  assert.strictEqual(target.pathname, '/deposit/transactions');
  assert.deepStrictEqual([...target.searchParams.entries()], [
    ['state', 'approved'], ['from_date', '2026-09-08'], ['to_date', '2026-09-09'],
  ]);
}
assert.strictEqual(project(descriptor({ action: '' })).pathname, '/deposit/transactions');
expectPreparation('REQUEST_URL_INVALID', () => project(descriptor({ action: '' }), resolved(), browser('/unrelated')));
expectPreparation('REQUEST_ORIGIN_UNSAFE', () => project(descriptor({ action: 'https://evil.invalid/deposit/transactions' })));
expectPreparation('REQUEST_ORIGIN_UNSAFE', () => project(descriptor({ action: 'javascript:alert(1)' })));
expectPreparation('REQUEST_URL_INVALID', () => project(descriptor({ action: '/unrelated' })));
for (const method of ['PUT', 'DELETE', 'HEAD', 'OPTIONS', 'arbitrary'])
  expectPreparation('REQUEST_METHOD_UNSUPPORTED', () => project(descriptor({ method })));
for (const field of ['status', 'dateFrom', 'dateTo'])
  expectPreparation('REQUEST_PARAMETER_MISSING', () => project(descriptor({ names: names({ [field]: '' }) })));
expectPreparation('REQUEST_PARAMETER_MISSING', () => project(
  descriptor({ names: names({ payment: '' }) }), resolved({ payment: { value: '2787', source: 'LABEL' } })));
expectPreparation('REQUEST_PARAMETER_MISSING', () => project(
  descriptor({ names: names({ agent: '' }) }), resolved({ agent: { value: 'A-7', source: 'LITERAL' } })));
let target = project(descriptor({ action: '/deposit/transactions?token=secret&csrf=bad&keep=yes&page=9' }));
assert.strictEqual(target.searchParams.has('token'), false); assert.strictEqual(target.searchParams.has('csrf'), false);
assert.strictEqual(target.searchParams.get('keep'), 'yes'); assert.strictEqual(target.searchParams.get('page'), '1');
target = project(descriptor(), resolved({ payment: { value: '2787', source: 'LABEL' } }));
assert.strictEqual(target.searchParams.get('pay_code'), '2787');
target = project(descriptor(), resolved({ agent: { value: 'exact-agent', source: 'LITERAL' } }));
assert.strictEqual(target.searchParams.get('agent_code'), 'exact-agent');

// B/AA: execute the compiled POST path and prove its only transport capability/call is GET.
const html = fs.readFileSync(path.join(__dirname, 'fixtures/phase4/empty.html'), 'utf8');
const form = { getAttribute: key => key === 'method' ? 'POST' : key === 'action' ? '/deposit/transactions' : null };
const elements = {};
const SELECTORS = require(path.join(ROOT, 'dist/main/utils/selector-repository.js')).SELECTORS.FILTER;
const element = (tagName, name, value, options) => ({ tagName, value, options,
  closest: key => key === 'form' ? form : null,
  getAttribute: key => key === 'name' ? name : key === 'type' ? 'text' : null });
elements[SELECTORS.DEPOSIT_STATUS] = element('SELECT', 'state', '', [{ value: 'approved', textContent: 'Approve' }]);
elements[SELECTORS.DATE_FROM] = element('INPUT', 'from_date', '2026-09-08');
elements[SELECTORS.DATE_TO] = element('INPUT', 'to_date', '2026-09-09');
const page = { url: () => 'https://current.invalid/deposit/transactions', async evaluate(callback, argument) {
  const previous = global.document; global.document = { querySelector: selector => elements[selector] || null };
  try { return callback(argument); } finally { if (previous === undefined) delete global.document; else global.document = previous; }
} };
let getCalls = 0;
const http = { async get(url) { getCalls++; return { status: () => 200, url: () => url, text: async () => html }; } };
assert.strictEqual(Object.prototype.hasOwnProperty.call(http, 'post'), false);
const scanRequest = { filter: { id: 'p', name: 'P', enabled: true, priority: 1 }, manualDateMode: true,
  maxPages: 1, initialSyncMode: false, shouldStop: () => false, duplicateCheck: () => false };

(async () => {
  const result = await new FastHttpSourceAdapter({ getPage: () => page, getRequestContext: () => http }).scan(scanRequest);
  assert.strictEqual(getCalls, 1); assert.strictEqual(result.terminationReason, 'MAX_SCAN_REACHED');

  // R-AE: frozen response, pagination, duplicate, source-mode, concurrency, and Legacy contracts
  // remain covered by their dedicated executable verifiers; guard their production shapes here too.
  assert.match(source, /status === 401\) return result\('SESSION_EXPIRED'/);
  assert.match(source, /finalUrl\.origin !== browserUrl\.origin/);
  assert.match(source, /FULL_DUPLICATE_PAGE/); assert.match(source, /!request\.initialSyncMode/);
  assert.match(source, /parsed\.pagination\.nextPageNumber !== pageNumber \+ 1/);
  assert.match(source, /candidate\.origin !== browserUrl\.origin/);
  assert.match(source, /http\.get\(nextUrl\.toString\(\)\)/);
  assert.doesNotMatch(source, /http\.(?:post|put|patch|delete|fetch)\s*\(/);
  assert.match(source, /interface FastHttpRequestContext \{ get\(/);
  assert.doesNotMatch(source.match(/interface FastHttpRequestContext[^\n]*/)[0], /post|put|fetch/);
  const pool = fs.readFileSync(path.join(ROOT, 'src/main/sources/fast-http-source-pool.ts'), 'utf8');
  assert.match(pool, /maxConcurrentScans = 2/);
  const monitoring = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  assert.match(monitoring, /return advertised === 2 \? 2 : 1/);
  assert.doesNotMatch(monitoring, /FastHttpSourceAdapter/);
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'package-lock.json')), true);
  console.log('PASS: Hotfix 13B cases A-AE; POST metadata safely projects to the compiled GET-only transport.');
})().catch(error => { console.error(error); process.exitCode = 1; });
