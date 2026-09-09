import type { SourceMode } from './source-mode';
import type { ExportStrategy } from './export-strategy';

export interface AppConfig {
  version: string;
  panelUrl?: string;
  monitoring: {
    sourceMode?: SourceMode;
    exportStrategy?: ExportStrategy;
    pollingInterval: number;
    maxPageScan: number;
    retryCount: number;
    requestTimeout: number;
    browserTimeout: number;
    batchSize: number;
    maxCache: number;
  };
  browser: {
    profileDirectory: string;
    persistentContext: boolean;
    headless: boolean;
    openDevTools: boolean;
    zoom: number;
  };
  database: {
    cleanupDays: number;
  };
  logging: {
    level: string;
    maxSize: string;
    maxFiles: string;
  };
  features: {
    screenshotOnError: boolean;
    autoResume: boolean;
    autoReconnect: boolean;
    diagnosticLogging?: boolean;
    /**
     * When true, MonitoringEngine ignores the previous latest-processed date
     * and scans/exports every valid transaction from page 1 onward. Adaptive
     * scanning is disabled while this flag is on. Intended for first
     * deployment, database rebuild, production testing, and recovery after
     * database reset. Default: false (incremental behavior).
     */
    initialSyncMode?: boolean;
    /**
     * When true, PlaywrightService.applyFilter DOES NOT populate Date From /
     * Date To. The operator sets the dates manually in the browser and the
     * engine leaves them alone across cycles. Filter profile date fields are
     * still ignored in either mode — the browser is the source of truth.
     * Default: true (reliability > automation, per production directive).
     */
    manualDateMode?: boolean;
  };
}
