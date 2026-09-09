/** Hotfix 13D verifier. Portable: sanitized fixtures only; no browser, DB, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const { FastHttpSourceAdapter } = require(path.join(DIST, 'sources/fast-http-source-adapter.js'));
const { DepositRequestPreparationError } = require(path.join(DIST, 'sources/deposit-request-runtime-provider.js'));
const { RawHttpHtmlParser } = require(path.join(DIST, 'sources/raw-http-html-parser.js'));
const { SELECTORS } = require(path.join(ROOT, 'dist/main/utils/selector-repository.js'));
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const page1 = read('scripts/fixtures/hotfix13d/live-post-page1-sanitized.html');
const page2 = read('scripts/fixtures/hotfix13d/live-post-page2-final-sanitized.html');
const empty = read('scripts/fixtures/phase4/empty.html');
const unknown = read('scripts/fixtures/phase4/unknown-layout.html');
const login = read('scripts/fixtures/phase4/login.html');
const TOKEN = 'TEST_CSRF_TOKEN';
const hotfixFixtures = `${page1}\n${page2}`;
assert.strictEqual((page1.match(/name="_token" value="([^"]+)"/) || [])[1], TOKEN);
assert.deepStrictEqual([...page1.matchAll(/name="_token" value="([^"]+)"/g)].map(match => match[1]), [TOKEN]);
assert(!/https?:\/\//i.test(hotfixFixtures), 'production hostname must be absent from sanitized fixtures');
assert(!/\b(?:cookie|authorization)\b/i.test(hotfixFixtures), 'credential fixtures are forbidden');
assert.deepStrictEqual([...hotfixFixtures.matchAll(/<td>(Synthetic User(?: Two)?)<\/td>/g)].map(match => match[1]),
  ['Synthetic User', 'Synthetic User Two']);
assert.deepStrictEqual([...hotfixFixtures.matchAll(/data-bank-number="([^"]+)"/g)].map(match => match[1]),
  ['0000000001', '0000000002']);
assert.deepStrictEqual([...hotfixFixtures.matchAll(/<td>(Synthetic Agent(?: Two)?)<\/td>/g)].map(match => match[1]),
  ['Synthetic Agent', 'Synthetic Agent Two']);

const profile = overrides => ({ id: 'p', name: 'Synthetic', enabled: true, priority: 1,
  payment: 'Canonical Payment', status: 'Rejected', agent: 'Resolved Agent', ...overrides });
const request = overrides => ({ filter: profile(), manualDateMode: true, maxPages: 10,
  initialSyncMode: false, shouldStop: () => false, duplicateCheck: () => false, ...overrides });
const response = (html, url = 'https://safe.invalid/deposit/transactions', status = 200) => ({
  status: () => status, url: () => url, text: async () => html,
});

const baseline = [
  ['deposit_user_name', ''], ['deposit_bank_dd', 'ALL'], ['deposit_account_name', ''],
  ['deposit_account_number', ''], ['deposit_agent_name', 'STALE_AGENT'],
  ['deposit_status', 'STALE_STATUS'], ['deposit_verified', 'ALL'], ['deposit_done', 'ALL'],
  ['payment', 'STALE_PAYMENT'], ['first_deposit', 'ALL'],
  ['deposit_process_date_from', '2000-01-01'], ['deposit_process_date_to', '2000-01-02'], ['_token', TOKEN],
];
function fakePage({ method = 'POST', action = '/deposit/transactions', entries = baseline } = {}) {
  const form = { formEntries: entries, getAttribute: key => key === 'method' ? method : key === 'action' ? action : null };
  const unrelatedForm = { formEntries: [['_token', 'UNRELATED_TOKEN'], ['password', 'NEVER_READ']] };
  const control = (tagName, name, value, options) => ({ tagName, value, options,
    closest: key => key === 'form' ? form : null,
    getAttribute: key => key === 'name' ? name : key === 'type' ? 'text' : null });
  const elements = {
    [SELECTORS.FILTER.DEPOSIT_TYPE]: control('SELECT', 'payment', 'STALE_PAYMENT', [
      { value: 'STALE_PAYMENT', textContent: 'Stale' }, { value: 'CANONICAL_PAY', textContent: 'Canonical Payment' }]),
    [SELECTORS.FILTER.DEPOSIT_STATUS]: control('SELECT', 'deposit_status', 'STALE_STATUS', [
      { value: 'RESOLVED_STATUS', textContent: 'Approve' }]),
    [SELECTORS.FILTER.AGENT_INPUT]: control('INPUT', 'deposit_agent_name', 'Resolved Agent'),
    [SELECTORS.FILTER.DATE_FROM]: control('INPUT', 'deposit_process_date_from', '2026-09-08'),
    [SELECTORS.FILTER.DATE_TO]: control('INPUT', 'deposit_process_date_to', '2026-09-09'),
  };
  let unrelatedInspections = 0;
  return { url: () => 'https://safe.invalid/deposit/transactions', unrelatedForm,
    async evaluate(callback, argument) {
      const oldDocument = global.document; const oldFormData = global.FormData;
      global.document = { querySelector(selector) { if (/login|password|change/i.test(selector)) unrelatedInspections++; return elements[selector] || null; } };
      global.FormData = class { constructor(target) { assert.notStrictEqual(target, unrelatedForm); this.target = target; }
        entries() { return this.target.formEntries[Symbol.iterator](); } };
      try { return callback(argument); } finally { global.document = oldDocument; global.FormData = oldFormData; }
    },
    getUnrelatedInspections: () => unrelatedInspections,
  };
}
function harness({ page = fakePage(), posts = [response(page1)], gets = [response(page2)], events = [] } = {}) {
  const postCalls = []; const getCalls = [];
  const http = {
    async post(url, options) { events.push('post-page1'); postCalls.push({ url, options }); return posts.shift(); },
    async get(url) { events.push(getCalls.length ? 'get-next' : 'get-page'); getCalls.push(url); return gets.shift(); },
  };
  const adapter = new FastHttpSourceAdapter({ getPage: () => page, getRequestContext: () => http });
  return { adapter, page, postCalls, getCalls, events };
}
const prep = async (h, code, req = request()) => {
  await assert.rejects(h.adapter.scan(req), error => error instanceof DepositRequestPreparationError && error.code === code
    && !error.message.includes(TOKEN));
  assert.strictEqual(h.postCalls.length + h.getCalls.length, 0);
};

(async () => {
  // A: GET metadata retains the safe first-page GET contract.
  let h = harness({ page: fakePage({ method: 'GET' }), gets: [response(empty)] });
  let result = await h.adapter.scan(request({ filter: profile({ payment: undefined, agent: undefined }), maxPages: 1 }));
  assert.strictEqual(h.getCalls.length, 1); assert.strictEqual(h.postCalls.length, 0);
  assert.strictEqual(new URL(h.getCalls[0]).searchParams.get('deposit_status'), 'RESOLVED_STATUS');

  // B-K/O/T/X/Y/AC: exact POST payload and callback-before-sequential-GET behavior.
  const events = []; h = harness({ events });
  const originalParse = h.adapter.parser.parse.bind(h.adapter.parser);
  h.adapter.parser.parse = (html, options) => { events.push(`parse-page${options.expectedPageNumber}`); return originalParse(html, options); };
  result = await h.adapter.scan(request({ onPage: async p => events.push(`onPage${p.pageNumber}`) }));
  assert.deepStrictEqual(events, ['post-page1', 'parse-page1', 'onPage1', 'get-page', 'parse-page2', 'onPage2']);
  assert.strictEqual(h.postCalls.length, 1); assert.strictEqual(h.getCalls.length, 1);
  assert.strictEqual(new URL(h.postCalls[0].url).pathname, '/deposit/transactions');
  const payload = h.postCalls[0].options.form;
  assert.deepStrictEqual(Object.fromEntries(baseline.filter(([name]) => !['deposit_agent_name','deposit_status','payment','deposit_process_date_from','deposit_process_date_to'].includes(name))),
    Object.fromEntries(Object.entries(payload).filter(([name]) => !['deposit_agent_name','deposit_status','payment','deposit_process_date_from','deposit_process_date_to'].includes(name))));
  assert.strictEqual(payload._token, TOKEN); assert.strictEqual(payload.payment, 'CANONICAL_PAY');
  assert.strictEqual(payload.deposit_status, 'RESOLVED_STATUS'); assert.strictEqual(payload.deposit_agent_name, 'Resolved Agent');
  assert.deepStrictEqual([payload.deposit_process_date_from, payload.deposit_process_date_to], ['2026-09-08', '2026-09-09']);
  assert(!JSON.stringify(events).includes(TOKEN)); assert.strictEqual(h.page.getUnrelatedInspections(), 0);
  assert.strictEqual(result.transactions.length, 2); assert.strictEqual(result.terminationReason, 'END_OF_PAGINATION');
  assert.match(h.getCalls[0], /page=2/); assert.match(h.getCalls[0], /_token=TEST_CSRF_TOKEN/);

  // L-N: unsafe targets and unsupported methods make zero requests.
  await prep(harness({ page: fakePage({ action: 'https://evil.invalid/deposit/transactions' }) }), 'REQUEST_ORIGIN_UNSAFE');
  await prep(harness({ page: fakePage({ action: '/unrelated' }) }), 'REQUEST_URL_INVALID');
  for (const method of ['PUT', 'DELETE']) await prep(harness({ page: fakePage({ method }) }), 'REQUEST_METHOD_UNSUPPORTED');

  // P-R: POST receives exactly the existing response-trust policy.
  h = harness({ posts: [response(unknown)] }); result = await h.adapter.scan(request()); assert.strictEqual(result.terminationReason, 'UNSAFE_RESPONSE');
  h = harness({ posts: [response(login)] }); result = await h.adapter.scan(request()); assert.strictEqual(result.terminationReason, 'SESSION_EXPIRED');
  h = harness({ posts: [response('', undefined, 401)] }); result = await h.adapter.scan(request()); assert.strictEqual(result.terminationReason, 'SESSION_EXPIRED');

  // S-V/W: expected current page permits no-active live markup; adjacent ambiguity/jumps/cross-origin fail closed.
  const parser = new RawHttpHtmlParser(); let parsed = parser.parse(page1, { expectedPageNumber: 1 });
  assert.strictEqual(parsed.pagination.nextPageNumber, 2); assert.match(parsed.pagination.nextHref, /page=2/);
  const duplicate = page1.replace('</ul>', '<li><a href="?page=2">Duplicate adjacent</a></li></ul>');
  assert.strictEqual(parser.parse(duplicate, { expectedPageNumber: 1 }).pagination.valid, false);
  const skipOnly = page1.replace(/<li><a rel="next" href="\/deposit\/transactions\?page=2[^<]+<\/a><\/li>/, '');
  assert.strictEqual(parser.parse(skipOnly, { expectedPageNumber: 1 }).pagination.valid, false);
  h = harness({ posts: [response(page1.replace('/deposit/transactions?page=2', 'https://evil.invalid/deposit/transactions?page=2'))] });
  result = await h.adapter.scan(request()); assert.strictEqual(result.terminationReason, 'UNSAFE_RESPONSE'); assert.strictEqual(h.getCalls.length, 0);

  // Z-AB: duplicate, Initial Sync, and maxPages contracts remain unchanged.
  h = harness(); result = await h.adapter.scan(request({ duplicateCheck: () => true }));
  assert.strictEqual(result.terminationReason, 'FULL_DUPLICATE_PAGE'); assert.strictEqual(h.getCalls.length, 0);
  h = harness(); result = await h.adapter.scan(request({ initialSyncMode: true, duplicateCheck: () => true }));
  assert.strictEqual(result.terminationReason, 'END_OF_PAGINATION'); assert.strictEqual(h.getCalls.length, 1);
  h = harness(); result = await h.adapter.scan(request({ maxPages: 1 }));
  assert.strictEqual(result.terminationReason, 'MAX_SCAN_REACHED'); assert.strictEqual(h.getCalls.length, 0);

  // AI-AJ: production FormData descriptor preparation rejects duplicate names
  // and non-string/File-like values before either authenticated transport runs.
  const duplicateSecret = 'DUPLICATE_VALUE_MUST_NOT_LEAK';
  h = harness({ page: fakePage({ entries: [...baseline, ['payment', duplicateSecret]] }) });
  await assert.rejects(h.adapter.scan(request()), error =>
    error instanceof DepositRequestPreparationError && error.code === 'REQUEST_FORM_MISSING'
      && !error.message.includes(duplicateSecret) && !error.message.includes(TOKEN));
  assert.strictEqual(h.postCalls.length, 0); assert.strictEqual(h.getCalls.length, 0);

  const fileSecret = 'FILE_VALUE_MUST_NOT_LEAK';
  const fileLikeValue = { name: fileSecret, toString: () => fileSecret };
  h = harness({ page: fakePage({ entries: [...baseline, ['attachment', fileLikeValue]] }) });
  await assert.rejects(h.adapter.scan(request()), error =>
    error instanceof DepositRequestPreparationError && error.code === 'REQUEST_FORM_MISSING'
      && !error.message.includes(fileSecret) && !error.message.includes(TOKEN));
  assert.strictEqual(h.postCalls.length, 0); assert.strictEqual(h.getCalls.length, 0);

  // AD-AH: concurrency and prior hotfix contracts are executable via package scripts.
  assert.match(read('src/main/sources/fast-http-source-pool.ts'), /maxConcurrentScans = 2/);
  assert.match(read('src/main/services/monitoring-engine.ts'), /return advertised === 2 \? 2 : 1/);
  assert.doesNotMatch(read('src/main/sources/legacy-browser-source-adapter.ts'), /maxConcurrentScans/);
  console.log('PASS: Hotfix 13D cases A-AJ (live POST transport, payload, response trust, pagination, and FormData fail-closed behavior).');
})().catch(error => { console.error(error); process.exitCode = 1; });
