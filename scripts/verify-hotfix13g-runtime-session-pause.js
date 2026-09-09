/** Hotfix 13G verifier. Portable: no browser, DB, network, or real timers. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const loggerService = require(path.join(DIST, 'services/logger-service.js'));
const logs = [];
loggerService.getLogger = () => ({
  info(message) { logs.push(String(message)); },
  warn(message) { logs.push(String(message)); },
  error(message) { logs.push(String(message)); },
  success(message) { logs.push(String(message)); },
  debug() {}, diag() {}, isDiagEnabled() { return false; },
});

const { MonitoringEngine } = require(path.join(DIST, 'services/monitoring-engine.js'));
const { MonitoringCycleSourceError } = require(path.join(DIST, 'services/monitoring-failure-policy.js'));

const cfg = { monitoring: { sourceMode: 'AUTO', pollingInterval: 2, batchSize: 1000 }, features: {} };
const recovery = { pendingFound: 0, alreadyRemote: 0, appended: 0, reconciled: 0, remaining: 0, skipped: null, failureClass: null };

function harness(validateSession) {
  const playwright = { isReady: () => true, validateSession };
  const filters = { loadProfiles: async () => {}, getEnabledProfiles: () => [] };
  const sqlite = {
    loadFingerprints: async () => new Set(), getPendingExportCount: async () => 0,
    getStoredTransactionCount: async () => 0, isReady: () => true,
    getResumeMarker: async () => null, saveResumeMarker: async () => {},
  };
  const sheets = { isConnected: () => false, connect: async () => {} };
  const config = { loadAppConfig: async () => cfg, loadGoogleSheetsConfig: async () => null };
  const inert = {};
  const engine = new MonitoringEngine(playwright, filters, inert, inert, sqlite, sheets, config, { scan: async () => { throw new Error('unused'); } });
  engine.config = cfg;
  engine.isRunning = true;
  engine.recoverPendingExports = async () => recovery;
  return { engine, playwright, sheets };
}

function failure(reason, modes = { requestedMode: 'AUTO', effectiveMode: 'FAST' }) {
  if (reason === 'SESSION_EXPIRED' || reason === 'HTTP_FAILURE' || reason === 'UNSAFE_RESPONSE') {
    return Object.assign(new MonitoringCycleSourceError(reason, 'PGA', 3), modes);
  }
  return Object.assign(new Error('sanitized fixture'), { code: reason, isCycleFatal: true, filterName: 'PGA', rowsHandedOff: 3 }, modes);
}

async function runFailures({ validateSession, reasons, stopAfter, modes }) {
  const fixture = harness(validateSession);
  const sleeps = [];
  let cycles = 0;
  fixture.engine.sleep = async ms => { sleeps.push(ms); };
  fixture.engine.runMonitoringCycle = async () => {
    cycles++;
    if (stopAfter && cycles > reasons.length) { fixture.engine.isRunning = false; return; }
    throw failure(reasons[Math.min(cycles - 1, reasons.length - 1)], modes);
  };
  await fixture.engine.runMonitoringLoop();
  return { ...fixture, sleeps, cycles };
}

(async () => {
  // A: invalid session normalizes only for policy and enters the existing PAUSE owner.
  let result = await runFailures({ validateSession: async () => ({ ok: false }), reasons: ['RUNTIME_CONTROL_UNAVAILABLE'] });
  assert.equal(result.engine.getState(), 'PAUSED');
  assert.equal(result.engine.isMonitoring(), false);
  assert.deepEqual(result.sleeps, []);
  assert(logs.some(line => line.includes('action=PAUSE reason=SESSION_EXPIRED')));

  // B-C: a valid session retains the runtime-control reason and full retry ladder.
  result = await runFailures({
    validateSession: async () => ({ ok: true }),
    reasons: Array(5).fill('RUNTIME_CONTROL_UNAVAILABLE'), stopAfter: true,
  });
  assert.deepEqual(result.sleeps, [5000, 10000, 20000, 40000, 60000]);
  assert(logs.some(line => line.includes('action=RETRY reason=RUNTIME_CONTROL_UNAVAILABLE consecutive=1 retryInMs=5000')));

  // D: validator errors are contained and preserve the original retry behavior.
  result = await runFailures({
    validateSession: async () => { throw new Error('validator unavailable'); },
    reasons: ['RUNTIME_CONTROL_UNAVAILABLE'], stopAfter: true,
  });
  assert.deepEqual(result.sleeps, [5000]);

  // E-G: established direct source classifications are unchanged.
  result = await runFailures({ validateSession: async () => ({ ok: true }), reasons: ['SESSION_EXPIRED'] });
  assert.equal(result.engine.getState(), 'PAUSED'); assert.deepEqual(result.sleeps, []);
  result = await runFailures({ validateSession: async () => ({ ok: true }), reasons: ['HTTP_FAILURE'], stopAfter: true });
  assert.deepEqual(result.sleeps, [5000]);
  result = await runFailures({ validateSession: async () => ({ ok: true }), reasons: ['UNSAFE_RESPONSE'] });
  assert.equal(result.engine.getState(), 'PAUSED');

  // H-I: the requested-mode distinction for browser prerequisites is unchanged.
  result = await runFailures({ validateSession: async () => ({ ok: true }), reasons: ['BROWSER_PAGE_UNAVAILABLE'], stopAfter: true, modes: { requestedMode: 'AUTO', effectiveMode: 'FAST' } });
  assert.deepEqual(result.sleeps, [5000]);
  result = await runFailures({ validateSession: async () => ({ ok: true }), reasons: ['BROWSER_PAGE_UNAVAILABLE'], modes: { requestedMode: 'FAST', effectiveMode: 'FAST' } });
  assert.equal(result.engine.getState(), 'PAUSED');

  // J-K: later session health does not mutate PAUSED or execute another cycle.
  let valid = false;
  let validations = 0;
  result = await runFailures({ validateSession: async () => ({ ok: valid }), reasons: ['RUNTIME_CONTROL_UNAVAILABLE'] });
  const pausedCycles = result.cycles;
  valid = true;
  assert.deepEqual(await result.playwright.validateSession(), { ok: true }); validations++;
  await Promise.resolve();
  assert.equal(result.engine.getState(), 'PAUSED');
  assert.equal(result.engine.isMonitoring(), false);
  assert.equal(result.cycles, pausedCycles);
  assert.equal(validations, 1);

  // L: only explicit Start clears the pause and creates a new loop.
  let newRuns = 0;
  result.engine.resolveResumeMarker = async () => {};
  result.engine.recoverPendingExports = async () => recovery;
  result.engine.runMonitoringLoop = async () => { newRuns++; result.engine.isRunning = false; };
  await result.engine.startMonitoring('https://panel.invalid');
  await Promise.resolve();
  assert.equal(newRuns, 1);
  assert.equal(result.engine.pauseReason, null);

  // M-N: the bridge performs validation only; it neither navigates nor matches reason text.
  const source = fs.readFileSync(path.join(ROOT, 'src/main/services/monitoring-engine.ts'), 'utf8');
  const bridge = source.slice(source.indexOf('private async normalizeRuntimeControlFailure'), source.indexOf('private async runMonitoringCycle'));
  assert.doesNotMatch(bridge, /page\.goto|\.reload\(|newBrowser|newContext|launch\(|login/i);
  assert.match(bridge, /if \(session\.ok\) return error/);
  assert.doesNotMatch(bridge, /session\.reason|includes\(|match\(/);

  // O: the hotfix's emitted diagnostics contain no sensitive fields or values.
  assert.doesNotMatch(logs.join('\n').toLowerCase(), /cookie|authorization|token|credential|account|username|form value/);

  console.log('PASS: Hotfix 13G cases A-O (runtime-control session-expiry pause contract).');
})().catch(error => { console.error(error); process.exitCode = 1; });
