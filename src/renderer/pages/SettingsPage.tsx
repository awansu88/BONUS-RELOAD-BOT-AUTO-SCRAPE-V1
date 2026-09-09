import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useMonitoringStore } from '../store/monitoring-store';
import { AppConfig } from '../../types/config';
import { DEFAULT_CONFIG } from '../../utils/constants';
import InfoCard from '../components/InfoCard';
import ConfirmDialog from '../components/ConfirmDialog';
import { normalizeSourceMode, SourceMode } from '../../types/source-mode';
import { ExportStrategy, normalizeExportStrategy } from '../../types/export-strategy';

/**
 * Settings — Iteration 11 layout polish only.
 * Every setting key, valid range, disabled-while-monitoring rule and
 * IPC call is preserved exactly as before. Sections are re-grouped:
 * General, Monitoring, Database, Features (formerly Google Sheets +
 * Logging + Advanced are covered by dedicated pages / feature toggles).
 */
const SettingsPage: React.FC = () => {
  const { isMonitoring } = useMonitoringStore();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    // Fall back to hard-coded defaults so the Settings screen still
    // renders when running outside the Electron preload context
    // (e.g. Vite dev preview, static-hosted renderer, e2e tests).
    if (!window.electron) {
      setConfig(DEFAULT_CONFIG as unknown as AppConfig);
      return;
    }
    const result = await window.electron.getAppConfig();
    if (result.success) setConfig(result.data);
    else setConfig(DEFAULT_CONFIG as unknown as AppConfig);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const result = await window.electron.saveAppConfig(config);
      if (result.success) toast.success('Settings saved');
      else toast.error('Save failed');
    } finally { setSaving(false); }
  };

  const doReset = async () => {
    setConfirmReset(false);
    // Reset only the operator-tunable fields to their defaults; leave
    // panelUrl, credentials, and structural fields intact.
    if (!config) return;
    const next: AppConfig = {
      ...config,
      monitoring: { ...config.monitoring, sourceMode: 'LEGACY', exportStrategy: 'BATCHED', pollingInterval: 2, maxPageScan: 10, retryCount: 3, batchSize: 1000 },
      database:   { ...config.database, cleanupDays: 7 },
      features:   { ...config.features, screenshotOnError: false, autoResume: true, autoReconnect: true,
                    diagnosticLogging: false, manualDateMode: true, initialSyncMode: false }
    };
    setConfig(next);
    toast.success('Defaults restored (click Save to apply)');
  };

  if (!config) return <div className="text-text-tertiary">Loading…</div>;

  return (
    <div className="space-y-5 max-w-4xl" data-testid="settings-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div className="flex gap-2">
          <button
            data-testid="reset-settings-btn"
            onClick={() => setConfirmReset(true)}
            className="h-9 px-3 text-sm bg-bg-tertiary text-text-primary rounded hover:bg-gray-700"
          >
            Reset to Defaults
          </button>
          <button
            data-testid="save-settings-btn"
            onClick={handleSave}
            disabled={saving}
            className="h-9 px-4 text-sm bg-accent-primary text-white rounded hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>

      {isMonitoring && (
        <div className="bg-amber-500/10 border border-amber-500/40 text-amber-300 rounded-md p-3 text-sm">
          Some settings cannot be changed while monitoring is active.
        </div>
      )}

      <InfoCard title="Monitoring" testId="settings-monitoring">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div className="col-span-2">
            <label className="block text-xs text-text-secondary mb-1">Source Mode</label>
            <select
              data-testid="source-mode-select"
              value={normalizeSourceMode(config.monitoring.sourceMode)}
              onChange={(e) => setConfig({ ...config, monitoring: { ...config.monitoring, sourceMode: e.target.value as SourceMode } })}
              disabled={isMonitoring}
              className="w-full h-9 text-sm"
            >
              <option value="AUTO">AUTO — Prefer FAST when the authenticated browser session supports it; otherwise use Legacy next cycle.</option>
              <option value="FAST">FAST — Force authenticated HTTP acquisition with two workers; prerequisites are required.</option>
              <option value="LEGACY">LEGACY — Existing sequential browser scraper; compatibility / safest mode.</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-text-secondary mb-1">Export Strategy</label>
            <select
              data-testid="export-strategy-select"
              value={normalizeExportStrategy(config.monitoring.exportStrategy)}
              onChange={(e) => setConfig({ ...config, monitoring: { ...config.monitoring, exportStrategy: e.target.value as ExportStrategy } })}
              disabled={isMonitoring}
              className="w-full h-9 text-sm"
            >
              <option value="BATCHED">BATCHED — Current V2 batching (batch size / cycle boundary).</option>
              <option value="PER_PAGE">PER_PAGE — Trigger durable export after every successfully scanned page.</option>
            </select>
            <p className="text-[11px] text-text-tertiary mt-1">
              PER_PAGE still persists through SQLite and the safe writer queue; it never exports directly from the scanner.
            </p>
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Polling Interval (seconds)</label>
            <input
              type="number"
              value={config.monitoring.pollingInterval}
              onChange={(e) => setConfig({ ...config, monitoring: { ...config.monitoring, pollingInterval: parseInt(e.target.value) } })}
              disabled={isMonitoring}
              min={1} max={30}
              className="w-full h-9 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Max Page Scan</label>
            <input
              type="number"
              value={config.monitoring.maxPageScan}
              onChange={(e) => setConfig({ ...config, monitoring: { ...config.monitoring, maxPageScan: parseInt(e.target.value) } })}
              min={1}
              className="w-full h-9 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Retry Count</label>
            <input
              type="number"
              value={config.monitoring.retryCount}
              onChange={(e) => setConfig({ ...config, monitoring: { ...config.monitoring, retryCount: parseInt(e.target.value) } })}
              min={0}
              className="w-full h-9 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Batch Size</label>
            <input
              type="number"
              value={config.monitoring.batchSize}
              onChange={(e) => setConfig({ ...config, monitoring: { ...config.monitoring, batchSize: parseInt(e.target.value) } })}
              min={1}
              className="w-full h-9 text-sm"
            />
          </div>
        </div>
      </InfoCard>

      <InfoCard title="Database" testId="settings-database">
        <div className="max-w-sm">
          <label className="block text-xs text-text-secondary mb-1">Cleanup Days</label>
          <input
            type="number"
            value={config.database.cleanupDays}
            onChange={(e) => setConfig({ ...config, database: { cleanupDays: parseInt(e.target.value) } })}
            min={1}
            className="w-full h-9 text-sm"
          />
          <p className="text-[11px] text-text-tertiary mt-1">
            Exported rows older than this many days may be pruned by maintenance jobs.
          </p>
        </div>
      </InfoCard>

      <InfoCard title="Features" testId="settings-features">
        <div className="space-y-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              data-testid="toggle-manual-date-mode"
              checked={config.features.manualDateMode !== false}
              onChange={(e) => setConfig({ ...config, features: { ...config.features, manualDateMode: e.target.checked } })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">Manual Date Mode</div>
              <div className="text-xs text-text-secondary leading-relaxed">
                Operator manually selects monitoring dates in the browser. The engine verifies both fields have values but never modifies them.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              data-testid="toggle-initial-sync-mode"
              checked={config.features.initialSyncMode === true}
              onChange={(e) => setConfig({ ...config, features: { ...config.features, initialSyncMode: e.target.checked } })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">Initial Sync Mode</div>
              <div className="text-xs text-text-secondary leading-relaxed">
                Ignores existing fingerprints and scans every page. Use only for first deployment, database rebuild, or recovery.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              data-testid="toggle-diagnostic-logging"
              checked={config.features.diagnosticLogging === true}
              onChange={(e) => setConfig({ ...config, features: { ...config.features, diagnosticLogging: e.target.checked } })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">Diagnostic Logging</div>
              <div className="text-xs text-text-secondary leading-relaxed">
                Emits rich per-cycle diagnostic blocks to the Live Log. Useful when investigating a scraping regression.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.features.screenshotOnError}
              onChange={(e) => setConfig({ ...config, features: { ...config.features, screenshotOnError: e.target.checked } })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">Screenshot on Error</div>
              <div className="text-xs text-text-secondary leading-relaxed">Capture a screenshot when the pipeline hits an error.</div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.features.autoResume}
              onChange={(e) => setConfig({ ...config, features: { ...config.features, autoResume: e.target.checked } })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">Auto Resume</div>
              <div className="text-xs text-text-secondary leading-relaxed">Automatically resume monitoring after an error.</div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.features.autoReconnect}
              onChange={(e) => setConfig({ ...config, features: { ...config.features, autoReconnect: e.target.checked } })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">Auto Reconnect</div>
              <div className="text-xs text-text-secondary leading-relaxed">Reopen the browser session after unexpected disconnects.</div>
            </div>
          </label>
        </div>
      </InfoCard>

      <ConfirmDialog
        open={confirmReset}
        title="Reset settings to defaults?"
        description="Only operator-tunable fields (polling interval, max page scan, retry count, batch size, cleanup days, features) will be reset. Panel URL and Google credentials are preserved. You still need to click Save to apply the reset."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
        testId="confirm-reset-settings"
      />
    </div>
  );
};

export default SettingsPage;
