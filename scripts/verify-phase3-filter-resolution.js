/** Phase 3 filter resolution verification. Portable: no Electron, browser, DB, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main/sources');
const {
  FilterRequestResolver, FilterResolutionError,
} = require(path.join(DIST, 'filter-request-resolver.js'));
const { PlaywrightFilterRuntimeProvider } = require(path.join(DIST, 'filter-runtime-provider.js'));
const { SELECTORS } = require(path.join(ROOT, 'dist/main/utils/selector-repository.js'));

const resolver = new FilterRequestResolver();
const profile = overrides => ({ id: 'fixture', name: 'Fixture', enabled: true, priority: 1, ...overrides });
const select = options => ({ kind: 'SELECT', options: options.map(([value, label]) => ({ value, label })) });
const availableDate = value => ({ available: true, value });
const runtime = overrides => ({
  payment: select([['', 'All'], ['286', 'Manual Deposit']]),
  status: select([['Approve', 'Approved']]),
  agent: { kind: 'FREE_TEXT' },
  dateFrom: availableDate('operator from'),
  dateTo: availableDate('operator to'),
  ...overrides,
});
const resolve = (p = {}, r = {}, options = { manualDateMode: true }) =>
  resolver.resolve(profile(p), runtime(r), options);
const rejectsCode = (fn, code, field) => {
  assert.throws(fn, error => error instanceof FilterResolutionError &&
    error.code === code && (!field || error.field === field));
};

(async () => {
  // A/B: raw value wins; a legacy exact label maps to its raw value.
  assert.deepStrictEqual(resolve({ depositType: '286' }).payment, { value: '286', source: 'VALUE' });
  assert.deepStrictEqual(resolve({ depositType: 'Manual Deposit' }).payment, { value: '286', source: 'LABEL' });

  // C/D/E: ambiguity, absence, and incompatible profile fields all fail closed.
  const duplicateLabels = select([['286', 'Manual Deposit'], ['912', 'Manual Deposit']]);
  rejectsCode(() => resolve({ depositType: 'Manual Deposit' }, { payment: duplicateLabels }), 'PAYMENT_AMBIGUOUS');
  rejectsCode(() => resolve({ depositType: 'Missing' }), 'PAYMENT_UNAVAILABLE');
  rejectsCode(() => resolve({ payment: '286', depositType: '912' }), 'PROFILE_PAYMENT_CONFLICT');

  // F/G/H: both compatibility fields work, blanks stay absent, identical DOM duplicates are safe.
  for (const p of [{ payment: '286', depositType: '286' }, { payment: '286' }, { depositType: '286' }]) {
    assert.strictEqual(resolve(p).payment.value, '286');
  }
  for (const p of [{}, { payment: ' ', depositType: '' }]) assert.ok(!('payment' in resolve(p)));
  assert.strictEqual(resolve({ depositType: 'Manual Deposit' }, {
    payment: select([['286', 'Manual Deposit'], ['286', 'Manual Deposit']]),
  }).payment.value, '286');

  // I-L: status is exactly the Legacy Approve invariant, never profile-defined.
  assert.deepStrictEqual(resolve().status, { value: 'Approve', source: 'VALUE' });
  assert.deepStrictEqual(resolve({}, { status: select([['1', 'Approve']]) }).status, { value: '1', source: 'LABEL' });
  assert.strictEqual(resolve({ status: 'Rejected' }).status.value, 'Approve');
  rejectsCode(() => resolve({}, { status: select([['2', 'Rejected']]) }), 'STATUS_UNAVAILABLE');
  rejectsCode(() => resolve({}, { status: select([['1', 'Approve'], ['2', 'Approve']]) }), 'STATUS_AMBIGUOUS');

  // M-Q: free-text is explicit; selects use the same exact deterministic rules.
  assert.deepStrictEqual(resolve({ agent: '  Agent A  ' }).agent, { value: 'Agent A', source: 'LITERAL' });
  assert.deepStrictEqual(resolve({ agent: '7' }, { agent: select([['7', 'Agent A']]) }).agent, { value: '7', source: 'VALUE' });
  assert.deepStrictEqual(resolve({ agent: 'Agent A' }, { agent: select([['7', 'Agent A']]) }).agent, { value: '7', source: 'LABEL' });
  rejectsCode(() => resolve({ agent: 'Agent A' }, { agent: select([['7', 'Agent A'], ['8', 'Agent A']]) }), 'AGENT_AMBIGUOUS');
  rejectsCode(() => resolve({ agent: 'Missing' }, { agent: select([['7', 'Agent A']]) }), 'AGENT_UNAVAILABLE');
  rejectsCode(() => resolve({ agent: 'Agent A' }, { agent: { kind: 'UNAVAILABLE' } }), 'AGENT_CONTROL_UNSUPPORTED');
  assert.ok(!('agent' in resolve({}, { agent: { kind: 'UNAVAILABLE' } })));

  // R-T: manual browser values are byte-for-byte preserved; auto uses formatPanelDate.
  const manual = resolve();
  assert.deepStrictEqual([manual.dateFrom, manual.dateTo], ['operator from', 'operator to']);
  rejectsCode(() => resolve({}, { dateFrom: availableDate('') }), 'MANUAL_DATE_REQUIRED', 'dateFrom');
  const auto = resolve({}, {}, { manualDateMode: false, now: new Date(2026, 8, 7, 23, 59) });
  assert.deepStrictEqual([auto.dateFrom, auto.dateTo], ['2026-09-07', '2026-09-07']);

  // U/V: dormant fields never leak; matching is trim-only and case-sensitive.
  const dormant = resolve({ bank: 'Bank', status: 'Rejected', done: 'Yes', verified: 'Yes', firstDeposit: 'Yes',
    username: 'user', accountName: 'customer', accountNumber: '123', includeKeyword: 'include', excludeKeyword: 'exclude' });
  assert.deepStrictEqual(Object.keys(dormant).sort(), ['dateFrom', 'dateTo', 'manualDateMode', 'status']);
  assert.strictEqual(dormant.status.value, 'Approve');
  rejectsCode(() => resolve({ payment: 'manual deposit' }), 'PAYMENT_UNAVAILABLE');

  // W: a failed control read is distinct from a normally empty SELECT.
  rejectsCode(() => resolve({ payment: '286' }, { payment: { kind: 'UNAVAILABLE' } }), 'RUNTIME_CONTROL_UNAVAILABLE');
  rejectsCode(() => resolve({}, { status: { kind: 'UNAVAILABLE' } }), 'RUNTIME_CONTROL_UNAVAILABLE');
  rejectsCode(() => resolve({ payment: '286' }, { payment: select([]) }), 'PAYMENT_UNAVAILABLE');

  // X: provider makes one evaluate call, uses central selectors, trims option metadata,
  // and reports a missing element rather than manufacturing an empty select.
  const calls = [];
  const elements = {
    [SELECTORS.FILTER.DEPOSIT_TYPE]: { tagName: 'SELECT', options: [{ value: ' 286 ', textContent: ' Manual Deposit ' }] },
    [SELECTORS.FILTER.DEPOSIT_STATUS]: { tagName: 'SELECT', options: [{ value: ' Approve ', textContent: ' Approved ' }] },
    [SELECTORS.FILTER.AGENT_INPUT]: { tagName: 'INPUT', getAttribute() { return null; } },
    [SELECTORS.FILTER.DATE_FROM]: { tagName: 'INPUT', value: 'from' },
    [SELECTORS.FILTER.DATE_TO]: { tagName: 'INPUT', value: 'to' },
  };
  const evaluatedPage = elementMap => ({
    async evaluate(callback, argument) {
      calls.push(['evaluate']);
      const previous = global.document;
      global.document = { querySelector: selector => elementMap[selector] || null };
      try { return callback(argument); } finally { global.document = previous; }
    },
  });
  const fakePage = {
    ...evaluatedPage(elements),
    async $eval() { calls.push(['$eval']); throw new Error('$eval must not be used'); },
    async inputValue() { calls.push(['inputValue']); throw new Error('inputValue must not be used'); },
  };
  const snapshot = await new PlaywrightFilterRuntimeProvider(fakePage).readSnapshot();
  assert.deepStrictEqual(snapshot.payment, { kind: 'SELECT', options: [{ value: '286', label: 'Manual Deposit' }] });
  assert.strictEqual(snapshot.agent.kind, 'FREE_TEXT');
  assert.deepStrictEqual(snapshot.dateFrom, { available: true, value: 'from' });
  assert.deepStrictEqual(calls, [['evaluate']]);

  const missingElements = { ...elements };
  delete missingElements[SELECTORS.FILTER.DEPOSIT_TYPE];
  const missingPage = evaluatedPage(missingElements);
  assert.strictEqual((await new PlaywrightFilterRuntimeProvider(missingPage).readSnapshot()).payment.kind, 'UNAVAILABLE');

  // A failed single browser snapshot retains the old deterministic unavailable semantics.
  const failedCalls = { evaluate: 0, $eval: 0, inputValue: 0 };
  const failedSnapshot = await new PlaywrightFilterRuntimeProvider({
    async evaluate() { failedCalls.evaluate++; throw new Error('execution context destroyed'); },
    async $eval() { failedCalls.$eval++; },
    async inputValue() { failedCalls.inputValue++; },
  }).readSnapshot();
  assert.deepStrictEqual(failedSnapshot, {
    payment: { kind: 'UNAVAILABLE' }, status: { kind: 'UNAVAILABLE' }, agent: { kind: 'UNAVAILABLE' },
    dateFrom: { available: false, value: '' }, dateTo: { available: false, value: '' },
  });
  assert.deepStrictEqual(failedCalls, { evaluate: 1, $eval: 0, inputValue: 0 });

  // Y: a placeholder's blank raw value can never satisfy an explicit restriction.
  rejectsCode(() => resolve({ depositType: 'All' }, {
    payment: select([['', 'All']]),
  }), 'PAYMENT_UNAVAILABLE');
  rejectsCode(() => resolve({ agent: 'All Agents' }, {
    agent: select([['', 'All Agents']]),
  }), 'AGENT_UNAVAILABLE');
  rejectsCode(() => resolve({}, {
    status: select([['', 'Approve']]),
  }), 'STATUS_UNAVAILABLE');
  assert.ok(!('payment' in resolve({}, { payment: select([['', 'All']]) })));

  // Z: only actual text-entry controls are FREE_TEXT; non-text inputs are unsupported.
  const controlKind = async (tagName, type) => {
    const control = { tagName, getAttribute(name) { return name === 'type' ? type : null; } };
    const controlPage = evaluatedPage({ ...elements, [SELECTORS.FILTER.AGENT_INPUT]: control });
    return (await new PlaywrightFilterRuntimeProvider(controlPage).readSnapshot()).agent.kind;
  };
  assert.strictEqual(await controlKind('INPUT', null), 'FREE_TEXT');
  assert.strictEqual(await controlKind('INPUT', 'text'), 'FREE_TEXT');
  assert.strictEqual(await controlKind('INPUT', 'search'), 'FREE_TEXT');
  assert.strictEqual(await controlKind('TEXTAREA', null), 'FREE_TEXT');
  for (const type of ['hidden', 'checkbox', 'radio']) {
    assert.strictEqual(await controlKind('INPUT', type), 'UNAVAILABLE');
  }

  // Structural freeze: preparation has no transport and production Legacy does not import it.
  const resolverSource = fs.readFileSync(path.join(ROOT, 'src/main/sources/filter-request-resolver.ts'), 'utf8');
  const providerSource = fs.readFileSync(path.join(ROOT, 'src/main/sources/filter-runtime-provider.ts'), 'utf8');
  for (const forbidden of ['fetch(', '/deposit/transactions', 'context.request', 'browserContext.request']) {
    assert.ok(!resolverSource.includes(forbidden) && !providerSource.includes(forbidden), `forbidden Phase 4 token: ${forbidden}`);
  }
  for (const productionFile of ['legacy-browser-source-adapter.ts', '../services/monitoring-engine.ts']) {
    const source = fs.readFileSync(path.join(ROOT, 'src/main/sources', productionFile), 'utf8');
    assert.ok(!source.includes('FilterRequestResolver'));
  }

  console.log('PASS: Phase 3 filter resolution cases A-Z and read-only/transport structural guards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
