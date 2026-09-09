/** Hotfix 13H verifier. Portable: source-only; no Electron, browser, DB, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'd897b98f5f4d6633b32e148e65186a0669bacc05';
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/App.tsx'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/MonitoringPage.tsx'), 'utf8');

const listener = app.slice(app.indexOf('window.electron.onStateChange'), app.indexOf('window.electron.onStatsUpdate'));
const tone = page.slice(page.indexOf('const stateTone'), page.indexOf('/**\n * Compact live-status'));
const startButton = page.match(/^.*data-testid="start-monitoring-btn".*$/m)?.[0] || '';
const stopButton = page.match(/^.*data-testid="stop-monitoring-btn".*$/m)?.[0] || '';
const health = page.match(/<InfoRow label="Monitoring">[^\n]+/)?.[0] || '';

// A, F: backend terminal states update both renderer state dimensions.
assert.match(listener, /setMonitoringState\(state as any\)/);
assert.match(listener, /state === 'PAUSED'/);
assert.match(listener, /state === 'IDLE'/);
assert.match(listener, /setIsMonitoring\(false\)/);

// B: PAUSED wins before the generic stopped presentation.
assert.match(tone, /if \(state === 'PAUSED'\) return \{ tone: 'warning', label: 'Paused' \};/);
assert(tone.indexOf("state === 'PAUSED'") < tone.indexOf('!isMonitoring'));

// C-E: controls and health remain driven by synchronized isMonitoring state.
assert.match(startButton, /isMonitoring/);
assert.match(startButton, /!validationResult\?\.canStartMonitoring/);
assert.match(stopButton, /!isMonitoring/);
assert.match(health, /isMonitoring\s+\? 'Running'\s+: 'Stopped'/);

// G-H: retry/backoff and processing states never clear the running flag.
assert.doesNotMatch(listener, /state === 'ERROR'/);
assert.doesNotMatch(listener, /state === 'SLEEPING'/);
for (const state of ['LOADING_FILTERS', 'SCANNING_PAGE', 'PARSING_HTML', 'VALIDATING',
  'CHECKING_DUPLICATES', 'BUFFERING', 'EXPORTING', 'UPDATING_CACHE']) {
  assert(!listener.includes(state));
}

// I-J: state events do not initiate monitoring or other operator/browser actions.
assert.doesNotMatch(listener, /startMonitoring|handleStartMonitoring|login|navigate|goto|reload|launchBrowser|openBrowser/i);

// K-L: backend 13G, dependency manifests, lockfiles, and schema are frozen.
const changed = execFileSync('git', ['diff', '--name-only', BASE, '--'], { cwd: ROOT, encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(Boolean);
const frozenBackend = [
  'src/main/services/monitoring-engine.ts',
  'src/main/services/monitoring-failure-policy.ts',
  'src/main/ipc-handlers.ts',
  'src/main/preload.ts',
];
assert(!changed.some(file => frozenBackend.includes(file) || file.startsWith('src/main/sources/')));
assert(!changed.some(file => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file)));
assert(!changed.some(file => /(^|\/)(schema|schemas|migrations)(\/|$)/i.test(file)));

const basePackage = JSON.parse(execFileSync('git', ['show', `${BASE}:package.json`], { cwd: ROOT, encoding: 'utf8' }));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.deepStrictEqual(packageJson.dependencies, basePackage.dependencies);
assert.deepStrictEqual(packageJson.devDependencies, basePackage.devDependencies);

console.log('PASS: Hotfix 13H cases A-L (paused renderer state synchronization contract).');
