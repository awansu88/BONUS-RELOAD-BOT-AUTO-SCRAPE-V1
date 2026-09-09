/** Hotfix 13B trust verifier, corrected by Hotfix 13D live POST evidence. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { FastHttpSourceAdapter } = require(path.join(ROOT, 'dist/main/main/sources/fast-http-source-adapter.js'));
const { DepositRequestPreparationError } = require(path.join(ROOT, 'dist/main/main/sources/deposit-request-runtime-provider.js'));
const adapter = new FastHttpSourceAdapter({ getPage: () => null, getRequestContext: () => null });
const browser = pathname => new URL(`https://current.invalid${pathname}`);
const names = overrides => ({ status: 'state', payment: 'pay_code', agent: 'agent_code', dateFrom: 'from_date', dateTo: 'to_date', ...overrides });
const descriptor = overrides => ({ method: 'GET', action: '/deposit/transactions', names: names(), formEntries: [['_token','SYNTHETIC'],['blank','']], ...overrides });
const resolved = overrides => ({ status: { value: 'approved', source: 'VALUE' }, dateFrom: '2026-09-08', dateTo: '2026-09-09', manualDateMode: true, ...overrides });
const prepare = (d = descriptor(), r = resolved(), url = browser('/deposit/transactions')) => adapter.prepareFirstRequest(url, d, r);
const expect = (code, fn) => assert.throws(fn, e => e instanceof DepositRequestPreparationError && e.code === code);

let plan = prepare();
assert.strictEqual(plan.method, 'GET'); assert.deepStrictEqual([...plan.url.searchParams.entries()], [['state','approved'],['from_date','2026-09-08'],['to_date','2026-09-09']]);
plan = prepare(descriptor({ method: 'POST' }));
assert.strictEqual(plan.method, 'POST'); assert.deepStrictEqual(plan.form, { _token: 'SYNTHETIC', blank: '', state: 'approved', from_date: '2026-09-08', to_date: '2026-09-09' });
expect('REQUEST_ORIGIN_UNSAFE', () => prepare(descriptor({ action: 'https://evil.invalid/deposit/transactions' })));
expect('REQUEST_URL_INVALID', () => prepare(descriptor({ action: '/unrelated', method: 'POST' })));
expect('REQUEST_URL_INVALID', () => prepare(descriptor({ action: '' }), resolved(), browser('/unrelated')));
for (const method of ['PUT','DELETE','HEAD','OPTIONS']) expect('REQUEST_METHOD_UNSUPPORTED', () => prepare(descriptor({ method })));
for (const field of ['status','dateFrom','dateTo']) expect('REQUEST_PARAMETER_MISSING', () => prepare(descriptor({ names: names({ [field]: '' }) })));
plan = prepare(descriptor({ action: '/deposit/transactions?token=secret&keep=yes&page=9' }));
assert.strictEqual(plan.url.searchParams.has('token'), false); assert.strictEqual(plan.url.searchParams.get('keep'), 'yes'); assert.strictEqual(plan.url.searchParams.get('page'), '1');
plan = prepare(descriptor(), resolved({ payment: { value: '2787', source: 'LABEL' }, agent: { value: 'A-7', source: 'LITERAL' } }));
assert.strictEqual(plan.url.searchParams.get('pay_code'), '2787'); assert.strictEqual(plan.url.searchParams.get('agent_code'), 'A-7');

const source = fs.readFileSync(path.join(ROOT, 'src/main/sources/fast-http-source-adapter.ts'), 'utf8');
assert.match(source, /get\(url: string\)/); assert.match(source, /post\(url: string, options:/);
assert.doesNotMatch(source, /\b(?:fetch|put|patch|delete)\(url: string/);
assert.match(source, /status === 401/); assert.match(source, /finalUrl\.origin !== browserUrl\.origin/);
assert.match(source, /TRUSTED_DEPOSIT_PATH/); assert.match(source, /FULL_DUPLICATE_PAGE/);
assert.doesNotMatch(source, /Cookie|Authorization|localStorage|sessionStorage/);
// Superseded by Hotfix 13D live POST evidence: POST metadata now uses the authenticated POST transport.
console.log('PASS: Updated Hotfix 13B trust contract; GET supported, trusted endpoint/origin enforced, unsupported methods closed.');
