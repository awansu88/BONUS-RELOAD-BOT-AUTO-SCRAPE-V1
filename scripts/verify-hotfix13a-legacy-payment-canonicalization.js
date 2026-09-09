/** Hotfix 13A: deterministic tests against compiled PlaywrightService.applyFilter. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main');
// PlaywrightService statically imports the launch-only browser resolver. Stub
// Electron for this portable applyFilter test; no browser or Electron API runs.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: {}, dialog: {}, shell: {}, clipboard: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const loggerService = require(path.join(DIST, 'main/services/logger-service.js'));
loggerService.getLogger = () => ({
  info() {}, warn() {}, error() {}, debug() {}, success() {}, diag() {},
  isDiagEnabled() { return false; },
});
const { PlaywrightService } = require(path.join(DIST, 'main/services/playwright-service.js'));
const { SELECTORS } = require(path.join(DIST, 'utils/selector-repository.js'));
Module._load = originalLoad;

function pageFake(options, config = {}) {
  const events = [];
  let explicitPaymentAttempts = 0;
  return {
    events,
    async waitForSelector() {},
    async $$eval(selector) {
      assert.equal(selector, `${SELECTORS.FILTER.DEPOSIT_TYPE} option`);
      return options.map(({ value, label }) => ({ value: value.trim(), label: label.trim() }));
    },
    async inputValue(selector) {
      if (selector === SELECTORS.FILTER.DATE_FROM) return '09/09/2026';
      if (selector === SELECTORS.FILTER.DATE_TO) return '09/09/2026';
      return '';
    },
    async fill(selector, value) { events.push({ kind: 'fill', selector, value }); },
    async selectOption(selector, choice) {
      events.push({ kind: 'select', selector, choice });
      if (selector === SELECTORS.FILTER.DEPOSIT_TYPE && choice && choice.value !== '') {
        explicitPaymentAttempts++;
        if (config.disappear && explicitPaymentAttempts === 1) throw new Error('option disappeared');
        if (!options.some(option => option.value.trim() === choice.value)) throw new Error('missing option');
      }
    },
    async click(selector) { events.push({ kind: 'click', selector }); },
    async waitForLoadState() {}, async waitForTimeout() {},
    url() { return 'https://panel.example/deposits'; },
  };
}

async function run(profile, options, config) {
  const page = pageFake(options, config);
  const service = new PlaywrightService({});
  service.page = page;
  let error;
  try { await service.applyFilter(profile, { manualDateMode: true }); } catch (caught) { error = caught; }
  return { page, error };
}

function explicitPaymentSelections(page) {
  return page.events.filter(event => event.kind === 'select' &&
    event.selector === SELECTORS.FILTER.DEPOSIT_TYPE && event.choice && event.choice.value !== '');
}
function searchClicks(page) {
  return page.events.filter(event => event.kind === 'click' && event.selector === SELECTORS.FILTER.SEARCH_BUTTON);
}
function assertUnavailable(result) {
  assert.equal(result.error?.isProfileUnavailable, true);
  assert.equal(searchClicks(result.page).length, 0);
  assert.equal(result.page.events.length, 0, 'resolution failure must precede every DOM mutation');
}

(async () => {
  // A/B: raw profiles and legacy label profiles both select the canonical raw value.
  for (const requested of ['2787', 'PGA']) {
    const result = await run({ name: requested, depositType: requested }, [{ value: '2787', label: 'PGA' }]);
    assert.ifError(result.error);
    assert.deepEqual(explicitPaymentSelections(result.page).map(event => event.choice), [{ value: '2787' }]);
    assert.equal(searchClicks(result.page).length, 1);
  }

  // C: duplicate DOM rows representing the same semantic value are allowed.
  let result = await run({ depositType: 'PGA' }, [
    { value: '2787', label: 'PGA' }, { value: '2787', label: 'PGA' },
  ]);
  assert.ifError(result.error);
  assert.deepEqual(explicitPaymentSelections(result.page)[0].choice, { value: '2787' });

  // D-F: ambiguous, missing, and blank-only labels fail before reset or Search.
  result = await run({ depositType: 'PGA' }, [
    { value: '2787', label: 'PGA' }, { value: '9999', label: 'PGA' },
  ]); assertUnavailable(result);
  result = await run({ depositType: 'PGA' }, [{ value: '2787', label: 'Other' }]); assertUnavailable(result);
  result = await run({ depositType: 'PGA' }, [{ value: '', label: 'PGA' }]); assertUnavailable(result);

  // G: exact raw value wins before an otherwise matching label.
  result = await run({ depositType: 'PGA' }, [
    { value: 'PGA', label: 'Other' }, { value: '2787', label: 'PGA' },
  ]);
  assert.ifError(result.error);
  assert.deepEqual(explicitPaymentSelections(result.page)[0].choice, { value: 'PGA' });

  // H/I: trim only; matching remains case-sensitive.
  result = await run({ depositType: ' PGA ' }, [{ value: '2787', label: ' PGA ' }]);
  assert.ifError(result.error);
  assert.deepEqual(explicitPaymentSelections(result.page)[0].choice, { value: '2787' });
  result = await run({ depositType: 'pga' }, [{ value: '2787', label: 'PGA' }]); assertUnavailable(result);

  // J: a post-resolution disappearance is profile-local and never reaches Search.
  result = await run({ depositType: 'PGA' }, [{ value: '2787', label: 'PGA' }], { disappear: true });
  assert.equal(result.error?.isProfileUnavailable, true);
  assert.equal(searchClicks(result.page).length, 0);
  assert.deepEqual(explicitPaymentSelections(result.page)[0].choice, { value: '2787' });

  // K/L: agent-only and unrestricted profiles retain their established behavior.
  result = await run({ agent: 'agent-1' }, []);
  assert.ifError(result.error);
  assert.ok(result.page.events.some(event => event.kind === 'fill' && event.value === 'agent-1'));
  assert.equal(explicitPaymentSelections(result.page).length, 0);
  assert.equal(searchClicks(result.page).length, 1);
  result = await run({ name: 'unrestricted' }, []);
  assert.ifError(result.error);
  assert.equal(explicitPaymentSelections(result.page).length, 0);
  assert.equal(searchClicks(result.page).length, 1);

  // M: runtime canonicalization never rewrites the persisted profile object.
  const profile = { name: 'legacy', agent: 'a', depositType: 'PGA' };
  const snapshot = JSON.parse(JSON.stringify(profile));
  result = await run(profile, [{ value: '2787', label: 'PGA' }]);
  assert.ifError(result.error);
  assert.deepEqual(profile, snapshot);

  // N: an unavailable profile remains soft/local; a sibling can still apply.
  const first = await run({ name: 'missing', depositType: 'PGA' }, []);
  assert.equal(first.error?.isProfileUnavailable, true);
  const sibling = await run({ name: 'sibling', depositType: '2787' }, [{ value: '2787', label: 'PGA' }]);
  assert.ifError(sibling.error);
  assert.equal(searchClicks(sibling.page).length, 1);
  const engineSource = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  assert.match(engineSource, /if \(error && error\.isProfileUnavailable\)[\s\S]*?continue;/);

  console.log('Hotfix 13A Legacy payment canonicalization verification: PASS (A-N)');
})().catch(error => { console.error(error); process.exitCode = 1; });
