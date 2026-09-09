/** Hotfix 13E verifier. Synthetic fixtures only; no browser, database, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const { FastHttpSourceAdapter } = require(path.join(ROOT, 'dist/main/main/sources/fast-http-source-adapter.js'));
const { DepositRequestPreparationError } = require(path.join(ROOT, 'dist/main/main/sources/deposit-request-runtime-provider.js'));
const { SELECTORS } = require(path.join(ROOT, 'dist/main/utils/selector-repository.js'));
const page1Html = read('scripts/fixtures/hotfix13d/live-post-page1-sanitized.html');
const page2Html = read('scripts/fixtures/hotfix13d/live-post-page2-final-sanitized.html');
const emptyHtml = read('scripts/fixtures/phase4/empty.html');
const loginHtml = read('scripts/fixtures/phase4/login.html');
const unknownHtml = read('scripts/fixtures/phase4/unknown-layout.html');
const TEST_TOKEN = 'TEST_CSRF_TOKEN';
const TEST_UA = 'TEST_BROWSER_UA_DYNAMIC';
const TEST_LANGUAGES = ['en-GB', 'ms'];

const baseline = [
  ['deposit_status', 'OLD'], ['deposit_process_date_from', '2000-01-01'],
  ['deposit_process_date_to', '2000-01-02'], ['payment', 'OLD'],
  ['deposit_agent_name', 'OLD'], ['_token', TEST_TOKEN],
];
function fakePage({ method = 'POST', action = '/deposit/transactions', userAgent = TEST_UA,
  languages = TEST_LANGUAGES, browserUrl = 'https://safe.invalid/deposit/transactions?token=TEST_QUERY_SECRET' } = {}) {
  const form = { formEntries: baseline, getAttribute: key => key === 'method' ? method : key === 'action' ? action : null };
  const control = (name, tagName = 'INPUT', options) => ({ tagName,
    value: name.endsWith('_from') ? '2026-09-08' : name.endsWith('_to') ? '2026-09-09' : '', options,
    closest: key => key === 'form' ? form : null, getAttribute: key => key === 'name' ? name : null });
  const elements = {
    [SELECTORS.FILTER.DEPOSIT_TYPE]: control('payment', 'SELECT', [{ value: 'PAY', textContent: 'Canonical Payment' }]),
    [SELECTORS.FILTER.DEPOSIT_STATUS]: control('deposit_status', 'SELECT', [{ value: 'STATUS', textContent: 'Approve' }]),
    [SELECTORS.FILTER.AGENT_INPUT]: control('deposit_agent_name'),
    [SELECTORS.FILTER.DATE_FROM]: control('deposit_process_date_from'),
    [SELECTORS.FILTER.DATE_TO]: control('deposit_process_date_to'),
  };
  return { url: () => browserUrl, async evaluate(callback, argument) {
    const oldDocument = global.document; const oldFormData = global.FormData;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    global.document = { querySelector: selector => elements[selector] || null };
    global.FormData = class { constructor(target) { this.target = target; } entries() { return this.target.formEntries[Symbol.iterator](); } };
    Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent, languages, language: languages?.[0] } });
    try { return callback(argument); } finally {
      global.document = oldDocument; global.FormData = oldFormData;
      if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor); else delete global.navigator;
    }
  } };
}
const profile = { id: 'test', name: 'Test', enabled: true, priority: 1,
  payment: 'Canonical Payment', status: 'Rejected', agent: 'Agent' };
const scanRequest = overrides => ({ filter: profile, manualDateMode: true, maxPages: 10,
  initialSyncMode: false, shouldStop: () => false, duplicateCheck: () => false, ...overrides });
const response = (html, url = 'https://safe.invalid/deposit/transactions', status = 200, contentType = 'text/html') => ({
  status: () => status, url: () => url, text: async () => html, headers: () => ({ 'content-type': contentType }),
});
function harness({ page = fakePage(), posts = [response(page1Html)], gets = [response(page2Html)], events = [] } = {}) {
  const postCalls = []; const getCalls = [];
  const http = {
    async post(url, options) { events.push('post page1'); postCalls.push({ url, options }); return posts.shift(); },
    async get(url) { events.push(getCalls.length ? 'get next' : 'get page2'); getCalls.push(url); return gets.shift(); },
  };
  const adapter = new FastHttpSourceAdapter({ getPage: () => page, getRequestContext: () => http });
  return { adapter, postCalls, getCalls, events };
}

(async () => {
  // A-H, P-Q: navigation headers are runtime-derived, narrow, and credential-free; form remains unchanged.
  let h = harness();
  const originalParse = h.adapter.parser.parse.bind(h.adapter.parser);
  h.adapter.parser.parse = (html, options) => { h.events.push(`parse page${options.expectedPageNumber}`); return originalParse(html, options); };
  let result = await h.adapter.scan(scanRequest({ onPage: async value => h.events.push(`onPage${value.pageNumber}`) }));
  assert.deepStrictEqual(h.events, ['post page1', 'parse page1', 'onPage1', 'get page2', 'parse page2', 'onPage2']);
  assert.strictEqual(h.postCalls.length, 1); assert.strictEqual(h.getCalls.length, 1);
  const { form, headers } = h.postCalls[0].options;
  assert.match(headers.Accept, /^text\/html,application\/xhtml\+xml/);
  assert.strictEqual(headers.Origin, 'https://safe.invalid');
  assert.strictEqual(headers.Referer, 'https://safe.invalid/deposit/transactions');
  assert.strictEqual(new URL(headers.Referer).search, '');
  assert.strictEqual(headers['User-Agent'], TEST_UA);
  assert.strictEqual(headers['Accept-Language'], TEST_LANGUAGES.join(','));
  assert.deepStrictEqual([headers['Sec-Fetch-Dest'], headers['Sec-Fetch-Mode'], headers['Sec-Fetch-Site'], headers['Sec-Fetch-User']],
    ['document', 'navigate', 'same-origin', '?1']);
  assert.strictEqual(headers['Upgrade-Insecure-Requests'], '1'); assert.strictEqual(headers['Cache-Control'], 'max-age=0');
  for (const forbidden of ['cookie', 'set-cookie', 'authorization', 'host', 'content-length', 'connection', 'content-type'])
    assert(!Object.keys(headers).some(key => key.toLowerCase() === forbidden));
  assert.strictEqual(form._token, TEST_TOKEN); assert(!Object.values(headers).includes(TEST_TOKEN));
  assert.strictEqual(form.payment, 'PAY'); assert.strictEqual(form.deposit_status, 'STATUS');
  assert.match(h.getCalls[0], /page=2/); assert.strictEqual(result.terminationReason, 'END_OF_PAGINATION');

  // I-J: GET form and pagination retain the existing header-free GET contract.
  h = harness({ page: fakePage({ method: 'GET' }), gets: [response(emptyHtml)] });
  result = await h.adapter.scan(scanRequest({ maxPages: 1 }));
  assert.strictEqual(h.postCalls.length, 0); assert.strictEqual(h.getCalls.length, 1);
  assert.strictEqual(new URL(h.getCalls[0]).searchParams.get('deposit_status'), 'STATUS');

  // N-O: target and required browser UA fail closed before authenticated transport.
  for (const [page, code] of [
    [fakePage({ action: 'https://evil.invalid/deposit/transactions' }), 'REQUEST_ORIGIN_UNSAFE'],
    [fakePage({ userAgent: '' }), 'REQUEST_BROWSER_METADATA_UNAVAILABLE'],
  ]) {
    h = harness({ page });
    await assert.rejects(h.adapter.scan(scanRequest()), error => error instanceof DepositRequestPreparationError && error.code === code);
    assert.strictEqual(h.postCalls.length + h.getCalls.length, 0);
  }

  // R: the frozen response trust classifications remain intact.
  for (const [reply, reason] of [[response('', undefined, 401), 'SESSION_EXPIRED'], [response('', undefined, 403), 'HTTP_FAILURE'],
    [response(loginHtml), 'SESSION_EXPIRED'], [response(unknownHtml), 'UNSAFE_RESPONSE'],
    [response(page1Html, 'https://evil.invalid/deposit/transactions'), 'UNSAFE_RESPONSE']]) {
    h = harness({ posts: [reply] }); result = await h.adapter.scan(scanRequest()); assert.strictEqual(result.terminationReason, reason);
  }

  // Structural security and secret-hygiene guards cover only production header construction.
  const production = read('src/main/sources/deposit-request-runtime-provider.ts') + read('src/main/sources/fast-http-source-adapter.ts');
  const forbiddenProductionPatterns = [
    /document\s*\.\s*cookie/i, /storageState\s*\(/i, /context\s*\.\s*cookies\s*\(/i,
    /laravel_session/i, /XSRF-TOKEN/i, /['"]Authorization['"]\s*:/i, /['"]Cookie['"]\s*:/i,
  ];
  forbiddenProductionPatterns.forEach(pattern => assert.doesNotMatch(production, pattern));
  assert.doesNotMatch(production, /Chrome\/\d+/);
  assert(!/https?:\/\/(?!safe\.invalid)/i.test(`${page1Html}\n${page2Html}`));
  console.log('PASS: Hotfix 13E cases A-V (navigation header parity, runtime metadata, security, ordering, and frozen trust).');
})().catch(error => { console.error(error); process.exitCode = 1; });
