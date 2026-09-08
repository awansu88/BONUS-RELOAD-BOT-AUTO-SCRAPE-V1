/** Phase 6 FAST HTTP verification. Portable: no browser, Electron, DB, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main/sources');
const { FastHttpSourceAdapter, FastWorkerBusyError } = require(path.join(DIST, 'fast-http-source-adapter.js'));
const { DepositRequestPreparationError } = require(path.join(DIST, 'deposit-request-runtime-provider.js'));
const { FilterResolutionError } = require(path.join(DIST, 'filter-request-resolver.js'));
const { SELECTORS } = require(path.join(ROOT, 'dist/main/utils/selector-repository.js'));
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/phase4', name), 'utf8');
const valid = fixture('layout-17h-15b.html');
const empty = fixture('empty.html');
const page1 = fixture('pagination-page-1.html');
const final = fixture('pagination-final.html');

const profile = overrides => ({ id: 'p', name: 'Fixture', enabled: true, priority: 1, ...overrides });
const fakePage = (origin = 'https://example-a.invalid/deposit/transactions?page=9', options = {}) => {
  const form = { getAttribute: name => name === 'action'
    ? (options.formAction ?? '/deposit/transactions?static=kept&_token=remove&csrf=remove')
    : name === 'method' ? (options.formMethod ?? 'GET') : null };
  const otherForm = { getAttribute: () => null };
  const names = { payment: 'payment_id', status: 'deposit_status', agent: 'agent_name',
    dateFrom: 'deposit_process_date_from', dateTo: 'deposit_process_date_to', ...(options.names || {}) };
  const element = (tagName, name, owningForm, extra = {}) => ({ tagName, ...extra,
    closest: selector => selector === 'form' ? owningForm : null,
    getAttribute: attribute => attribute === 'name' ? name : attribute === 'type' && tagName === 'INPUT' ? 'text' : null,
  });
  const elements = {
    ...(!options.omitPayment ? { [SELECTORS.FILTER.DEPOSIT_TYPE]: element('SELECT', names.payment,
      options.paymentInOtherForm ? otherForm : form, { options: [{ value: '', textContent: 'All' }, { value: '286', textContent: 'Manual Deposit' }] }) } : {}),
    [SELECTORS.FILTER.DEPOSIT_STATUS]: element('SELECT', names.status, options.missingForm ? null : form,
      { options: [{ value: 'approved_raw', textContent: 'Approve' }] }),
    ...(!options.omitAgent ? { [SELECTORS.FILTER.AGENT_INPUT]: element(options.agentSelect ? 'SELECT' : 'INPUT', names.agent,
      options.agentInOtherForm ? otherForm : form, options.agentSelect ? { options: [{ value: '7', textContent: 'Agent A' }] } : {}) } : {}),
    [SELECTORS.FILTER.DATE_FROM]: element('INPUT', names.dateFrom, options.missingForm ? null : form, { value: options.from ?? 'manual-from' }),
    [SELECTORS.FILTER.DATE_TO]: element('INPUT', names.dateTo, options.missingForm ? null : form, { value: options.to ?? 'manual-to' }),
  };
  return {
    url: () => origin,
    async $eval(selector, callback) { if (!elements[selector]) throw new Error('missing'); return callback(elements[selector]); },
    async inputValue(selector) { return selector === SELECTORS.FILTER.DATE_FROM ? (options.from ?? 'manual-from') : (options.to ?? 'manual-to'); },
    async evaluate(callback, argument) {
      const previous = global.document;
      global.document = { querySelector: selector => elements[selector] || null };
      try { return callback(argument); } finally {
        if (previous === undefined) delete global.document; else global.document = previous;
      }
    },
  };
};
const response = (html, url = 'https://example-a.invalid/deposit/transactions', status = 200, wait) => ({
  status: () => status, url: () => url, async text() { if (wait) await wait; return html; },
});
const request = overrides => ({ filter: profile({}), manualDateMode: true, maxPages: 10,
  initialSyncMode: false, shouldStop: () => false, duplicateCheck: () => false, ...overrides });
const harness = ({ page = fakePage(), responses = [response(valid)], get, now } = {}) => {
  const calls = []; let inFlight = 0; let maxInFlight = 0; let index = 0; let requestContextReads = 0;
  const context = { async get(url) {
    calls.push(url); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try { return get ? await get(url, index++) : responses[index++]; } finally { inFlight--; }
  }};
  const owner = { getPage: () => page, getRequestContext() { requestContextReads++; return context; } };
  return { adapter: new FastHttpSourceAdapter(owner, now ? { now } : {}), calls,
    stats: () => ({ maxInFlight, requestContextReads }) };
};
const expectPrep = async (adapter, req, code) => assert.rejects(adapter.scan(req), error =>
  error instanceof DepositRequestPreparationError && error.code === code);

(async () => {
  // A-E: session-owned request bridge, dynamic origin/action, same-origin, and GET-only.
  let h = harness(); let result = await h.adapter.scan(request());
  assert.strictEqual(h.stats().requestContextReads, 1); assert.strictEqual(new URL(h.calls[0]).origin, 'https://example-a.invalid');
  h = harness({ page: fakePage('https://example-b.invalid/deposit/transactions', { formAction: './transactions' }),
    responses: [response(valid, 'https://example-b.invalid/deposit/transactions')] });
  await h.adapter.scan(request()); assert.strictEqual(new URL(h.calls[0]).origin, 'https://example-b.invalid');
  assert.strictEqual(new URL(h.calls[0]).pathname, '/deposit/transactions');
  h = harness({ page: fakePage(undefined, { formAction: 'https://evil.invalid/deposits' }) });
  await expectPrep(h.adapter, request(), 'REQUEST_ORIGIN_UNSAFE'); assert.strictEqual(h.calls.length, 0);
  h = harness({ page: fakePage(undefined, { formMethod: 'POST' }) });
  await expectPrep(h.adapter, request(), 'REQUEST_METHOD_UNSUPPORTED'); assert.strictEqual(h.calls.length, 0);

  // F-L: actual Phase 3 provider/resolver semantics feed exact query values and dates.
  for (const [requested, expected] of [['286', '286'], ['Manual Deposit', '286']]) {
    h = harness(); await h.adapter.scan(request({ filter: profile({ payment: requested }) }));
    assert.strictEqual(new URL(h.calls[0]).searchParams.get('payment_id'), expected);
  }
  h = harness(); await h.adapter.scan(request({ filter: profile({ agent: '  Agent A  ', status: 'Rejected' }) }));
  let query = new URL(h.calls[0]).searchParams;
  assert.strictEqual(query.get('agent_name'), 'Agent A'); assert.strictEqual(query.get('deposit_status'), 'approved_raw');
  assert.deepStrictEqual([query.get('deposit_process_date_from'), query.get('deposit_process_date_to')], ['manual-from', 'manual-to']);
  for (const requested of ['7', 'Agent A']) {
    h = harness({ page: fakePage(undefined, { agentSelect: true }) });
    await h.adapter.scan(request({ filter: profile({ agent: requested }) }));
    assert.strictEqual(new URL(h.calls[0]).searchParams.get('agent_name'), '7');
  }
  const clock = new Date(2026, 8, 7, 13, 0);
  h = harness({ now: () => clock }); await h.adapter.scan(request({ manualDateMode: false })); query = new URL(h.calls[0]).searchParams;
  assert.deepStrictEqual([query.get('deposit_process_date_from'), query.get('deposit_process_date_to')], ['2026-09-07', '2026-09-07']);

  // M-N: profile-specific absence is soft; core descriptor failures are hard and pre-start.
  let started = false;
  h = harness({ page: fakePage(undefined, { omitPayment: true }) });
  await assert.rejects(h.adapter.scan(request({ filter: profile({ payment: 'missing' }), onScanStart: () => { started = true; } })),
    error => error.isProfileUnavailable === true); assert.strictEqual(started, false); assert.strictEqual(h.calls.length, 0);
  h = harness({ page: fakePage(undefined, { missingForm: true }) });
  await expectPrep(h.adapter, request({ onScanStart: () => { started = true; } }), 'REQUEST_FORM_MISSING'); assert.strictEqual(h.calls.length, 0);
  h = harness({ page: fakePage(undefined, { names: { status: '' } }) });
  await expectPrep(h.adapter, request(), 'REQUEST_PARAMETER_MISSING'); assert.strictEqual(h.calls.length, 0);
  for (const field of ['dateFrom', 'dateTo']) {
    h = harness({ page: fakePage(undefined, { names: { [field]: '' } }) });
    await expectPrep(h.adapter, request(), 'REQUEST_PARAMETER_MISSING'); assert.strictEqual(h.calls.length, 0);
  }

  // Revision 1: optional controls are irrelevant unless the resolved request needs them.
  h = harness({ page: fakePage(undefined, { omitPayment: true, omitAgent: true }) });
  await h.adapter.scan(request()); query = new URL(h.calls[0]).searchParams;
  assert.strictEqual(query.has('payment_id'), false); assert.strictEqual(query.has('agent_name'), false);
  h = harness({ page: fakePage(undefined, { paymentInOtherForm: true, agentInOtherForm: true }) });
  await h.adapter.scan(request()); assert.strictEqual(h.calls.length, 1);

  // Semantic absence is soft, but missing required transport shape after resolution is hard.
  h = harness({ page: fakePage(undefined, { omitPayment: true }) });
  await assert.rejects(h.adapter.scan(request({ filter: profile({ payment: '286' }) })), error => error.isProfileUnavailable === true);
  assert.strictEqual(h.calls.length, 0);
  const failedSnapshotCalls = { evaluate: 0, $eval: 0, inputValue: 0 };
  const failedSnapshotPage = {
    ...fakePage(),
    async evaluate() { failedSnapshotCalls.evaluate++; throw new Error('execution context destroyed'); },
    async $eval() { failedSnapshotCalls.$eval++; },
    async inputValue() { failedSnapshotCalls.inputValue++; },
  };
  h = harness({ page: failedSnapshotPage });
  await assert.rejects(h.adapter.scan(request({ filter: profile({ payment: '286' }) })), error =>
    error instanceof FilterResolutionError && error.code === 'RUNTIME_CONTROL_UNAVAILABLE'
      && error.field === 'payment' && error.isProfileUnavailable === true
      && error.message !== 'execution context destroyed');
  assert.deepStrictEqual(failedSnapshotCalls, { evaluate: 1, $eval: 0, inputValue: 0 });
  assert.strictEqual(h.calls.length, 0);
  for (const pageOptions of [{ names: { payment: '' } }, { paymentInOtherForm: true }]) {
    h = harness({ page: fakePage(undefined, pageOptions) });
    await assert.rejects(h.adapter.scan(request({ filter: profile({ payment: '286' }) })),
      error => error instanceof DepositRequestPreparationError && error.isProfileUnavailable !== true);
    assert.strictEqual(h.calls.length, 0);
  }
  for (const pageOptions of [{ names: { agent: '' } }, { agentInOtherForm: true }]) {
    h = harness({ page: fakePage(undefined, pageOptions) });
    await assert.rejects(h.adapter.scan(request({ filter: profile({ agent: 'Agent A' }) })),
      error => error instanceof DepositRequestPreparationError && error.isProfileUnavailable !== true);
    assert.strictEqual(h.calls.length, 0);
  }

  // O-P: real parser returns exact rows and trusts a semantic empty table.
  h = harness(); result = await h.adapter.scan(request());
  assert.strictEqual(result.transactions[0].userName, 'Example User'); assert.strictEqual(result.terminationReason, 'END_OF_PAGINATION');
  assert.deepStrictEqual(result.perPage[0], { pageNumber: 1, rowsDetected: 1, rowsParsed: 1, rowsRejected: 0, duplicate: 0, buffered: 0, exported: 0 });
  h = harness({ responses: [response(empty)] }); result = await h.adapter.scan(request());
  assert.deepStrictEqual(result.transactions, []); assert.strictEqual(result.terminationReason, 'END_OF_PAGINATION');

  // Q-R: exact parser hrefs are followed serially in page order.
  const second = page1
    .replace('<li class="active"><a href="?page=1">1</a></li><li><a href="?page=2">2</a></li>',
      '<li><a href="?page=1">1</a></li><li class="active"><a href="?page=2">2</a></li>')
    .replace('/safe/deposits?page=2', '/nonstandard/exact?page=3')
    .replace('Example User', 'Second User');
  const third = final.replace('Example User', 'Third User').replace('class="active">2', 'class="active">3');
  h = harness({ responses: [response(page1), response(second, 'https://example-a.invalid/safe/deposits?page=2'), response(third, 'https://example-a.invalid/nonstandard/exact?page=3')] });
  result = await h.adapter.scan(request());
  assert.deepStrictEqual(result.transactions.map(row => row.userName), ['Example User', 'Second User', 'Third User']);
  assert.deepStrictEqual(h.calls.slice(1).map(url => new URL(url).pathname), ['/safe/deposits', '/nonstandard/exact']);
  assert.strictEqual(h.stats().maxInFlight, 1);

  // S-T: unsafe/ambiguous continuation retains the trusted current page and sends nothing more.
  const crossNext = page1.replace('/safe/deposits?page=2', 'https://evil.invalid/page=2');
  h = harness({ responses: [response(crossNext)] }); result = await h.adapter.scan(request());
  assert.strictEqual(result.transactions.length, 1); assert.strictEqual(result.terminationReason, 'UNSAFE_RESPONSE'); assert.strictEqual(h.calls.length, 1);
  const ambiguous = page1.replace('href="?page=1">1', 'href="#">?');
  h = harness({ responses: [response(ambiguous)] }); result = await h.adapter.scan(request());
  assert.strictEqual(result.transactions.length, 1); assert.strictEqual(result.navigationFailure, true); assert.strictEqual(h.calls.length, 1);

  // U-AA: max, stop, duplicate policy, empty-page behavior, and Initial Sync.
  h = harness({ responses: [response(page1)] }); result = await h.adapter.scan(request({ maxPages: 1 }));
  assert.strictEqual(result.terminationReason, 'MAX_SCAN_REACHED'); assert.strictEqual(h.calls.length, 1);
  h = harness(); result = await h.adapter.scan(request({ shouldStop: () => true }));
  assert.strictEqual(result.terminationReason, 'STOP_REQUESTED'); assert.strictEqual(h.calls.length, 0);
  let stopChecks = 0; h = harness({ responses: [response(page1)] });
  result = await h.adapter.scan(request({ shouldStop: () => ++stopChecks > 1 }));
  assert.strictEqual(result.terminationReason, 'STOP_REQUESTED'); assert.strictEqual(h.calls.length, 1); assert.strictEqual(result.transactions.length, 1);
  h = harness(); result = await h.adapter.scan(request({ duplicateCheck: () => true }));
  assert.strictEqual(result.terminationReason, 'FULL_DUPLICATE_PAGE'); assert.strictEqual(result.transactions.length, 1);
  h = harness({ responses: [response(page1), response(final, 'https://example-a.invalid/safe/deposits?page=2')] });
  let duplicateCalls = 0; result = await h.adapter.scan(request({ duplicateCheck: row => { duplicateCalls++; return row.userName === 'Nobody'; } }));
  assert.strictEqual(h.calls.length, 2); assert.strictEqual(duplicateCalls, 2);
  h = harness({ responses: [response(empty)] }); result = await h.adapter.scan(request({ duplicateCheck: () => true }));
  assert.notStrictEqual(result.terminationReason, 'FULL_DUPLICATE_PAGE');
  h = harness({ responses: [response(page1), response(final, 'https://example-a.invalid/safe/deposits?page=2')] });
  duplicateCalls = 0; result = await h.adapter.scan(request({ initialSyncMode: true, duplicateCheck: () => { duplicateCalls++; return true; } }));
  assert.strictEqual(duplicateCalls, 0); assert.strictEqual(result.transactions.length, 2);

  // AB-AK: every unsafe real-parser classification fails closed; earlier safe rows survive.
  const row = valid.match(/<tbody>([\s\S]*)<\/tbody>/)[1];
  const malformed = valid.replace('</tbody>', row.replace('data-bank-number="7976181505">797-618-1505', 'data-bank-number=" ">') + '</tbody>');
  const wrongHeader = valid.replace(/<th>[^<]*<\/th>/g, '<th>Wrong</th>');
  for (const html of [malformed, fixture('unknown-layout.html'), wrongHeader, fixture('permission-error.html'), '<not html']) {
    h = harness({ responses: [response(html)] }); result = await h.adapter.scan(request());
    assert.deepStrictEqual(result.transactions, []); assert.strictEqual(result.terminationReason, 'UNSAFE_RESPONSE');
  }
  h = harness({ responses: [response(fixture('login.html'))] }); result = await h.adapter.scan(request());
  assert.strictEqual(result.terminationReason, 'SESSION_EXPIRED');
  for (const [status, reason] of [[401, 'SESSION_EXPIRED'], [403, 'HTTP_FAILURE'], [500, 'HTTP_FAILURE']]) {
    h = harness({ responses: [response('ignored', undefined, status)] }); result = await h.adapter.scan(request());
    assert.strictEqual(result.terminationReason, reason); assert.strictEqual(h.calls.length, 1);
  }
  h = harness({ responses: [response(page1), response(malformed, 'https://example-a.invalid/safe/deposits?page=2')] });
  result = await h.adapter.scan(request()); assert.strictEqual(result.transactions.length, 1);
  assert.strictEqual(result.navigationFailure, true); assert.strictEqual(result.terminationReason, 'UNSAFE_RESPONSE');

  // AL-AM: final login and cross-origin redirects are rejected before body trust.
  h = harness({ responses: [response(valid, 'https://example-a.invalid/login')] }); result = await h.adapter.scan(request());
  assert.strictEqual(result.terminationReason, 'SESSION_EXPIRED');
  h = harness({ responses: [response(valid, 'https://evil.invalid/deposits')] }); result = await h.adapter.scan(request());
  assert.strictEqual(result.terminationReason, 'UNSAFE_RESPONSE');

  // AN: active scan guard rejects rather than queues and one request remains in flight.
  let release; const gate = new Promise(resolve => { release = resolve; });
  h = harness({ get: async () => { await gate; return response(valid); } });
  const first = h.adapter.scan(request()); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.adapter.scan(request()), error => error instanceof FastWorkerBusyError && error.code === 'FAST_WORKER_BUSY');
  release(); await first; assert.strictEqual(h.stats().maxInFlight, 1);

  // AO-AQ: no auth query injection, Legacy remains default, and no fallback exists.
  h = harness(); await h.adapter.scan(request()); query = new URL(h.calls[0]).searchParams;
  for (const key of ['_token', 'csrf', 'xsrf', 'Authorization']) assert.strictEqual(query.has(key), false);
  assert.strictEqual(query.get('static'), 'kept'); assert.strictEqual(query.get('page'), null);
  const monitoring = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  assert.match(monitoring, /new LegacyBrowserSourceAdapter\(playwrightService\)/);
  assert.match(monitoring, /new FastHttpSourcePool\(playwrightService\)/);
  assert.doesNotMatch(monitoring, /FastHttpSourceAdapter/);
  const fastSource = fs.readFileSync(path.join(ROOT, 'src/main/sources/fast-http-source-adapter.ts'), 'utf8');
  assert.doesNotMatch(fastSource, /LegacyBrowserSourceAdapter|PageScanner|Promise\.all|request\.newContext/);

  // Executable security/dependency guards over all Phase 6 production sources.
  const phase6 = fastSource + fs.readFileSync(path.join(ROOT, 'src/main/sources/deposit-request-runtime-provider.ts'), 'utf8');
  for (const forbidden of [/from ['"]axios['"]/, /node-fetch/, /request\.newContext/, /\.cookies\s*\(/,
    /localStorage|sessionStorage/, /console\.|getLogger/, /selectOption\s*\(|\.fill\s*\(|\.click\s*\(/]) assert.doesNotMatch(phase6, forbidden);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const dependency of ['axios', 'node-fetch', 'got', 'undici', 'request', 'superagent']) assert.ok(!pkg.dependencies[dependency]);
  const playwrightService = fs.readFileSync(path.join(ROOT, 'src/main/services/playwright-service.ts'), 'utf8');
  assert.match(playwrightService, /getRequestContext\(\): APIRequestContext \| null \{ return this\.context\?\.request \?\? null; \}/);
  assert.doesNotMatch(playwrightService, /getRequestContext[\s\S]{0,160}cookies\s*\(/);

  console.log('PASS: Phase 6 FAST HTTP worker cases A-AQ, shared-auth, trust, concurrency, and security guards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
