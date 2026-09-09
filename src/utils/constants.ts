/**
 * Application constants
 */

export const APP_VERSION = '1.0.0';
export const APP_NAME = 'Live Deposit Monitor';

export const WORKSHEET_NAME = 'MASTER' as const;

/**
 * Physical column letters in the MASTER worksheet. These are the ONLY
 * production contract — header text may be renamed by the operator at
 * any time without affecting export or resume logic.
 *
 * Columns A / F / I hold permanent ArrayFormulas — the exporter must
 * NEVER write into these cells.
 */
export const COLUMN = {
  USER_ID:    'B',
  AMOUNT:     'C',
  KEY_ID:     'D',
  TIME_STAMP: 'E',
  TRUE_AMOUNT: 'F',   // ArrayFormula — read-only
  TX_ID:       'I',   // ArrayFormula — read-only
} as const;

export const EXPECTED_HEADERS = {
  B: 'USER ID',
  C: 'AMOUNT',
  D: 'KEY_ID',
  E: 'TIME STAMP'
};

export const DEFAULT_CONFIG = {
  monitoring: {
    sourceMode: 'LEGACY' as const,
    exportStrategy: 'BATCHED' as const,
    pollingInterval: 2,
    maxPageScan: 10,
    retryCount: 3,
    requestTimeout: 10000,
    browserTimeout: 30000,
    batchSize: 1000,
    maxCache: 10000,
  },
  browser: {
    profileDirectory: 'browser-profile',
    persistentContext: true,
    headless: false,
    openDevTools: false,
    zoom: 1.0,
  },
  database: {
    cleanupDays: 7,
  },
  logging: {
    level: 'info',
    maxSize: '20m',
    maxFiles: '14d',
  },
  features: {
    screenshotOnError: false,
    autoResume: true,
    autoReconnect: true,
    diagnosticLogging: false,
    // Reliability > automation, per production directive. Operator picks the
    // dates in the browser; the engine leaves them untouched across cycles.
    manualDateMode: true,
    // Off by default — flip to true for first deployment / database rebuild /
    // production testing / recovery after database reset.
    initialSyncMode: false,
  },
};

export const MONITORING_STATES = {
  IDLE: 'IDLE',
  LOADING_FILTERS: 'LOADING_FILTERS',
  SCANNING_PAGE: 'SCANNING_PAGE',
  PARSING_HTML: 'PARSING_HTML',
  VALIDATING: 'VALIDATING',
  CHECKING_DUPLICATES: 'CHECKING_DUPLICATES',
  BUFFERING: 'BUFFERING',
  EXPORTING: 'EXPORTING',
  UPDATING_CACHE: 'UPDATING_CACHE',
  SLEEPING: 'SLEEPING',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
} as const;
