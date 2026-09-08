import { Transaction, RawTransaction } from '../../types/transaction';
import { FilterProfile } from '../../types/filter-profile';
import { MonitoringState, ExportStats, PreRunValidation, PreRunCheck } from '../../types/monitoring';
import { PlaywrightService } from './playwright-service';
import { FilterManager } from './filter-manager';
import { TransactionValidator } from './transaction-validator';
import { FingerprintGenerator } from './fingerprint-generator';
import { SQLiteService } from './sqlite-service';
import { GoogleSheetsService } from './google-sheets-service';
import { ConfigManager } from './config-manager';
import { getLogger } from './logger-service';
import { AppConfig } from '../../types/config';
import { PendingExportRecovery, PendingRecoveryResult } from './pending-export-recovery';
import type { SourceAdapter } from '../sources/source-adapter';
import { LegacyBrowserSourceAdapter } from '../sources/legacy-browser-source-adapter';
import { FastHttpSourcePool } from '../sources/fast-http-source-pool';
import { SourceModeSelector } from '../sources/source-mode-selector';
import { normalizeSourceMode } from '../../types/source-mode';
import { CentralIngestService } from './central-ingest-service';
import { ExportDrainOptions, ExportWriterQueue } from './export-writer-queue';

interface ConcurrentScanCapability { readonly maxConcurrentScans: number; }
type TransactionOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

function sourceConcurrency(source: SourceAdapter): number {
  const advertised = (source as SourceAdapter & Partial<ConcurrentScanCapability>).maxConcurrentScans;
  return advertised === 2 ? 2 : 1;
}

export class MonitoringEngine {
  private state: MonitoringState = 'IDLE';
  private isRunning: boolean = false;
  private cachedFingerprints: Set<string> = new Set();
  private bufferFingerprints: Set<string> = new Set();
  private processedInCycle: Set<string> = new Set();
  private buffer: Transaction[] = [];
  private pendingExportRecovery: PendingExportRecovery;
  private exportWriterQueue: ExportWriterQueue;
  private sourceAdapterOverride?: SourceAdapter;
  private sourceModeSelector?: SourceModeSelector;
  private centralIngestService: CentralIngestService;
  /**
   * Resume Marker — short KEY_ID (8-char upper-case fingerprint) of the
   * newest transaction confirmed as exported to Google Sheets. Persisted
   * in SQLite via `app_state('resume_marker')`; validated against Sheets
   * at startMonitoring (Sheets wins on disagreement). Advanced ONLY after
   * a successful Sheets append + Mark-Exported step.
   */
  private resumeMarker: string | null = null;
  private exportStats: ExportStats = {
    pendingQueueCount: 0,
    retryQueueCount: 0,
    successfulExportsToday: 0,
    lastExportTime: null,
    lastExportCount: 0,
    loadedFingerprints: 0,
    storedTransactions: 0,
    transactionsScanned: 0,
    newTransactions: 0,
    duplicatesSkipped: 0,
    rejectedTransactions: 0,
    manualDateMode: true,
    initialSyncMode: false,
    duplicateDetection: true,
    sqliteConnected: false,
    googleSheetsConnected: false,
    unavailableProfiles: []
  };
  // Per-cycle counters for the pipeline audit log. Reset at the top of
  // every runMonitoringCycle. Persisted counters (successfulExportsToday,
  // storedTransactions, loadedFingerprints) live in `exportStats`.
  //
  // NOTE: business filtering (Status / Done / Deposit Type / Agent /
  // Include & Exclude keywords) is applied by the browser BEFORE any row
  // becomes visible in the deposit table. The backend does not repeat
  // those decisions, so there is no separate "filter-match" counter.
  private cycleCounters = {
    parsed: 0,           // rows returned by HTMLMapper as valid transactions
    validated: 0,        // passed Essential Field Check
    duplicates: 0,       // rejected by isDuplicate / processedInCycle
    rejected: 0,         // failed Essential Field Check
    fingerprintsCreated: 0,
    buffered: 0,
    sqliteInserted: 0,
    sheetsAppended: 0,
    markedExported: 0
  };
  private config: AppConfig | null = null;
  private panelUrl: string = '';
  private onStateChange?: (state: MonitoringState) => void;
  private onStatsUpdate?: (stats: ExportStats) => void;
  
  constructor(
    private playwrightService: PlaywrightService,
    private filterManager: FilterManager,
    private validator: TransactionValidator,
    private fingerprintGen: FingerprintGenerator,
    private sqliteService: SQLiteService,
    private googleSheetsService: GoogleSheetsService,
    private configManager: ConfigManager,
    sourceAdapter?: SourceAdapter,
  ) {
    this.sourceAdapterOverride = sourceAdapter;
    if (!sourceAdapter) {
      const legacySource = new LegacyBrowserSourceAdapter(playwrightService);
      const fastSource = new FastHttpSourcePool(playwrightService);
      this.sourceModeSelector = new SourceModeSelector(legacySource, fastSource, playwrightService);
    }
    this.centralIngestService = new CentralIngestService(validator, fingerprintGen, sqliteService);
    this.pendingExportRecovery = new PendingExportRecovery(
      sqliteService,
      googleSheetsService,
      () => !this.isRunning,
    );
    this.exportWriterQueue = new ExportWriterQueue(this.pendingExportRecovery);
  }
  
  setStateChangeCallback(cb: (state: MonitoringState) => void): void {
    this.onStateChange = cb;
  }
  
  setStatsUpdateCallback(cb: (stats: ExportStats) => void): void {
    this.onStatsUpdate = cb;
  }
  
  async initialize(): Promise<void> {
    const logger = getLogger();
    logger.info('Initializing Monitoring Engine...');
    
    this.config = await this.configManager.loadAppConfig();
    await this.filterManager.loadProfiles();
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    this.cachedFingerprints = await this.sqliteService.loadFingerprints(thirtyDaysAgo);
    
    const pending = await this.sqliteService.getPendingExports();
    if (pending.length > 0) {
      logger.info(`Found ${pending.length} durable pending export(s) in SQLite`);
    }
    
    // Load the Resume Marker from SQLite. Cross-check with Google Sheets
    // happens later in startMonitoring() once the Sheets client is
    // connected — SQLite is only a fast local cache; Sheets is the
    // production source of truth.
    this.resumeMarker = await this.sqliteService.getResumeMarker();
    if (this.resumeMarker) {
      logger.info(`Resume Marker loaded from SQLite: ${this.resumeMarker}`);
    } else {
      logger.info('Resume Marker: none in SQLite (fresh install or first run).');
    }
    
    // Prime the live dashboard stats with the initial persisted counters.
    this.exportStats.loadedFingerprints = this.cachedFingerprints.size;
    this.exportStats.storedTransactions = await this.sqliteService.getStoredTransactionCount();
    this.exportStats.sqliteConnected = this.sqliteService.isReady();
    this.exportStats.googleSheetsConnected = this.googleSheetsService.isConnected();
    this.exportStats.manualDateMode = this.config?.features.manualDateMode !== false;
    this.exportStats.initialSyncMode = this.config?.features.initialSyncMode === true;
    this.exportStats.retryQueueCount = pending.length;
    if (this.onStatsUpdate) this.onStatsUpdate({ ...this.exportStats });
    
    logger.success(`Monitoring Engine initialized (fingerprints=${this.cachedFingerprints.size}, stored=${this.exportStats.storedTransactions}, pending=${pending.length})`);
  }
  
  async validatePreRunChecks(): Promise<PreRunValidation> {
    const checks: PreRunCheck[] = [];
    this.config = await this.configManager.loadAppConfig();
    
    checks.push({
      name: 'Browser Ready', status: this.playwrightService.isReady(),
      icon: '🌐', error: 'Browser not opened. Click "Open Browser".'
    });
    
    const session = await this.playwrightService.validateSession();
    checks.push({
      name: 'Manual Login Completed', status: session.ok,
      icon: '👤',
      error: session.reason || 'Not logged in. Please login manually.'
    });
    if (session.ok) {
      getLogger().success('Manual login validated');
    } else {
      getLogger().warn(`Login validation failed: ${session.reason}`);
    }

    const requestedMode = normalizeSourceMode(this.config?.monitoring.sourceMode);
    if (!this.sourceAdapterOverride && requestedMode === 'FAST') {
      const readiness = this.sourceModeSelector!.getFastReadiness();
      checks.push({
        name: 'FAST Transport Ready', status: readiness.ready, icon: '⚡',
        error: `FAST transport unavailable: ${readiness.reason}`
      });
    }
    
    checks.push({
      name: 'SQLite Initialized', status: this.sqliteService.isReady(),
      icon: '💾', error: 'Database not initialized.'
    });
    
    const googleConfig = await this.configManager.loadGoogleSheetsConfig();
    
    checks.push({
      name: 'Google Credential Loaded',
      status: googleConfig !== null && googleConfig.credentialJsonPath !== '',
      icon: '🔑', error: 'Google credential not configured.'
    });
    
    checks.push({
      name: 'Spreadsheet Found', status: googleConfig?.isConnected === true,
      icon: '📊', error: 'Spreadsheet not accessible.'
    });
    
    checks.push({
      name: 'Worksheet MASTER Found', status: googleConfig?.worksheetName === 'MASTER',
      icon: '📄', error: 'Worksheet "MASTER" not found.'
    });
    
    checks.push({
      name: 'Worksheet Headers Valid', status: googleConfig?.headersValidated === true,
      icon: '📋', error: 'Worksheet headers invalid.'
    });
    
    const enabledProfiles = this.filterManager.getEnabledProfiles();
    checks.push({
      name: 'Filter Profiles Available', status: enabledProfiles.length > 0,
      icon: '🎯', error: 'No enabled filter profiles.'
    });
    
    const allPassed = checks.every(c => c.status);
    return { passed: allPassed, checks, canStartMonitoring: allPassed };
  }
  
  async startMonitoring(panelUrl: string): Promise<void> {
    if (this.isRunning) return;
    
    this.panelUrl = panelUrl;
    this.isRunning = true;
    
    getLogger().info('Starting monitoring...');
    
    const googleConfig = await this.configManager.loadGoogleSheetsConfig();
    if (googleConfig) {
      await this.googleSheetsService.connect(googleConfig);
    }
    
    // Resolve the Resume Marker against Google Sheets (production source
    // of truth). Runs AFTER connect() so the Sheets client is ready. Safe
    // to skip when Sheets is unreachable — the SQLite marker (if any)
    // remains authoritative until the next successful export syncs it.
    await this.resolveResumeMarker();

    // Startup recovery is independent of browser rediscovery and its
    // fingerprint cache. The force option bypasses only cycle backoff.
    await this.recoverPendingExports({ force: true });
    
    this.runMonitoringLoop().catch(error => {
      getLogger().error('Monitoring loop error', error);
      this.isRunning = false;
      this.setState('ERROR');
    });
  }
  
  /**
   * Reconcile the SQLite Resume Marker with Google Sheets column D.
   *
   *   • Sheets NOT connected  → keep SQLite marker as-is (offline start).
   *   • Sheets EMPTY          → clear the SQLite marker so we scan every
   *                             transaction (nothing to resume from).
   *   • Sheets ≠ SQLite       → Sheets wins. Overwrite SQLite marker and
   *                             use the Sheets value going forward.
   *   • Sheets === SQLite     → happy path. Continue with the SQLite value.
   */
  private async resolveResumeMarker(): Promise<void> {
    const logger = getLogger();
    if (!this.googleSheetsService.isConnected()) {
      logger.info(
        '\n========== RESUME MARKER ==========\n' +
        `  Source           : SQLite (Sheets not connected)\n` +
        `  Loaded KEY_ID    : ${this.resumeMarker || '(none)'}\n` +
        `  Sync Result      : SKIPPED (offline start)\n` +
        `  Resume Ready     : true\n` +
        '===================================='
      );
      return;
    }
    const sheetsKeyId = await this.googleSheetsService.getLatestExportedKeyId();
    let source = 'SQLite';
    let syncResult = 'IN_SYNC';
    if (sheetsKeyId && sheetsKeyId !== this.resumeMarker) {
      source = 'Google Sheets';
      syncResult = this.resumeMarker
        ? `RESYNCED (SQLite="${this.resumeMarker}" → Sheets="${sheetsKeyId}")`
        : `RESYNCED (SQLite=(none) → Sheets="${sheetsKeyId}")`;
      this.resumeMarker = sheetsKeyId;
      await this.sqliteService.saveResumeMarker(sheetsKeyId);
    } else if (!sheetsKeyId && this.resumeMarker) {
      source = 'Google Sheets';
      syncResult = `RESYNCED (SQLite="${this.resumeMarker}" → Sheets=(empty)) — full scan next cycle`;
      this.resumeMarker = null;
      // Wipe the stale marker so subsequent runs don't stop early.
      await this.sqliteService.saveResumeMarker('');
    } else if (!sheetsKeyId) {
      source = 'Google Sheets';
      syncResult = 'EMPTY (nothing exported yet)';
    }
    logger.info(
      '\n========== RESUME MARKER ==========\n' +
      `  Source           : ${source}\n` +
      `  Loaded KEY_ID    : ${this.resumeMarker || '(none)'}\n` +
      `  Sync Result      : ${syncResult}\n` +
      `  Resume Ready     : true\n` +
      '===================================='
    );
  }
  
  async stopMonitoring(): Promise<void> {
    getLogger().info('Stopping monitoring...');
    this.isRunning = false;
  }
  
  private async runMonitoringLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.runMonitoringCycle();
        
        if (this.isRunning) {
          this.setState('SLEEPING');
          const interval = this.config?.monitoring.pollingInterval || 2;
          await this.sleep(interval * 1000);
        }
      } catch (error) {
        getLogger().error('Cycle error', error);
        this.setState('ERROR');
        await this.sleep(5000);
      }
    }
    
    this.setState('IDLE');
  }
  
  private async runMonitoringCycle(): Promise<void> {
    const start = Date.now();
    this.processedInCycle.clear();
    
    // Reload config at the top of every cycle so Settings changes
    // (maxPageScan, initialSyncMode, manualDateMode, batchSize, etc.) take
    // effect on the NEXT cycle without requiring an app restart. This fixes
    // both Bug #2 (maxPageScan ignored after Settings change) and Bug #4
    // (Initial Sync OFF didn't restore incremental monitoring).
    try {
      this.config = await this.configManager.loadAppConfig();
      getLogger().info(
        `Config reloaded: maxPageScan=${this.config.monitoring.maxPageScan}, ` +
        `initialSyncMode=${this.config.features.initialSyncMode === true}, ` +
        `manualDateMode=${this.config.features.manualDateMode !== false}, ` +
        `batchSize=${this.config.monitoring.batchSize}`
      );
    } catch (e: any) {
      getLogger().warn(`Config reload failed — using previous in-memory config. ${e?.message || e}`);
    }

    // Resolve once and retain the exact source for the entire cycle. Injected
    // adapters remain fixed for Phase 2–9 fixtures and never construct FAST.
    const selection = this.sourceAdapterOverride
      ? { requestedMode: 'LEGACY' as const, effectiveMode: 'LEGACY' as const,
          source: this.sourceAdapterOverride, reason: 'INJECTED' }
      : this.sourceModeSelector!.selectForCycle(this.config?.monitoring.sourceMode);
    const cycleSource = selection.source;
    const concurrency = sourceConcurrency(cycleSource);
    getLogger().info(`[SOURCE MODE] requested=${selection.requestedMode} effective=${selection.effectiveMode} reason=${selection.reason} concurrency=${concurrency}`);

    // One cycle-triggered attempt only; failures are retained in SQLite and
    // bounded backoff prevents API hammering on subsequent polling cycles.
    await this.recoverPendingExports();
    
    // Reset per-cycle counters (persisted counters unaffected).
    this.cycleCounters = {
      parsed: 0, validated: 0, duplicates: 0, rejected: 0,
      fingerprintsCreated: 0, buffered: 0, sqliteInserted: 0,
      sheetsAppended: 0, markedExported: 0
    };
    
    this.setState('LOADING_FILTERS');
    const filters = this.filterManager.getEnabledProfiles();
    
    if (filters.length === 0) return;

    // [FILTER PROFILE] per-cycle availability tracking. Populated by the
    // per-filter catch below when applyFilter() throws a soft
    // `isProfileUnavailable` error. Never triggers a fallback; used only
    // for the operator-facing status log and the dashboard status card.
    const unavailableByIndex: Array<string | undefined> = new Array(filters.length);
    let appliedProfileCount = 0;
    
    // Every polling cycle always starts from Page 1 (iter-9 directive).
    // Adaptive scanning by Process Date has been removed — the panel is
    // ordered by Created At and Process Date is non-monotonic, so no
    // scan-ordering decision can be trusted based on it. The single
    // scan-termination signal is "first fully duplicated page" and is
    // driven by fingerprint + SQLite alone (see PageScanner.setDuplicateCheck).
    const initialSyncMode = this.config?.features.initialSyncMode === true;
    if (initialSyncMode) {
      getLogger().info('Initial Sync Mode ACTIVE — duplicate-page stop disabled; scan up to maxPageScan pages.');
    } else {
      getLogger().info('Incremental monitoring — scan stops at the first page where every row is already in SQLite.');
    }
    
    let nextFilterIndex = 0;
    let groupAbortRequested = false;
    let fatalError: any = null;
    const runWorker = async (): Promise<void> => {
      while (this.isRunning && !groupAbortRequested) {
        const index = nextFilterIndex++;
        if (index >= filters.length) return;
        const filter = filters[index];
        try {
          await this.processFilter(filter, cycleSource, () => groupAbortRequested);
          appliedProfileCount++;
        } catch (error: any) {
          if (error && error.isProfileUnavailable) {
            unavailableByIndex[index] = filter.name;
            getLogger().warn(
              `[FILTER PROFILE] ${filter.name} — NOT AVAILABLE, SKIPPED. Continuing with remaining enabled profiles...`
            );
            continue;
          }
          // A concurrent acquisition error is cycle-fatal: request peer stop,
          // settle every already-running filter, and start no queued filter.
          if (error?.isCycleFatal || concurrency > 1) {
            groupAbortRequested = true;
            fatalError ??= error;
            getLogger().error(`Cycle aborted (fatal): ${filter.name} — ${error?.message || error}`);
            return;
          }
          getLogger().error(`Filter error: ${filter.name}`, error);
        }
      }
    };
    const schedulers: Promise<void>[] = [];
    for (let worker = 0; worker < concurrency; worker++) schedulers.push(runWorker());
    await Promise.all(schedulers);
    if (fatalError) throw fatalError;

    const unavailableProfileNames = unavailableByIndex.filter((name): name is string => name !== undefined);

    // When every enabled profile in this cycle was unavailable, emit the
    // operator-required "no profile available" status. No fallback is
    // ever performed; the loop simply sleeps and retries next tick.
    const enabledCount = filters.length;
    if (enabledCount > 0 && appliedProfileCount === 0 && unavailableProfileNames.length === enabledCount) {
      getLogger().warn(
        '\n[FILTER PROFILE]\n' +
        '  No enabled payment profile is currently available.\n' +
        '  Monitoring skipped.\n' +
        '  Waiting for next polling cycle...'
      );
    }
    this.exportStats.unavailableProfiles = [...unavailableProfileNames];
    
    if (this.buffer.length > 0) {
      await this.exportBuffer();
    }
    
    await this.updateExportStats();
    
    // === PIPELINE AUDIT (operator-requested per-cycle log block) ===
    // Emits a plain-text summary of every stage's SUCCESS/FAILED count so
    // future production troubleshooting can happen without code changes.
    const c = this.cycleCounters;
    const parsedGE = c.parsed;
    const sheetsStatus = this.googleSheetsService.isConnected() ? 'connected' : 'DISCONNECTED (rows persisted to SQLite only)';
    getLogger().info(
      '\n========== PIPELINE AUDIT (this cycle) ==========\n' +
      `  Transactions Parsed              : ${parsedGE}\n` +
      `  Essential Field Check            : ${c.validated} passed, ${c.rejected} rejected\n` +
      `  Fingerprints Created             : ${c.fingerprintsCreated}\n` +
      `  Duplicates Skipped               : ${c.duplicates}\n` +
      `  Transactions Buffered            : ${c.buffered}\n` +
      `  SQLite Records Inserted          : ${c.sqliteInserted}\n` +
      `  Google Sheets Batch Appended     : ${c.sheetsAppended}\n` +
      `  Transactions Marked Exported     : ${c.markedExported}\n` +
      `  Google Sheets Connection         : ${sheetsStatus}\n` +
      `  Diagnostic Logging               : ${getLogger().isDiagEnabled() ? 'ENABLED' : 'disabled'}\n` +
      `  Fingerprints Loaded (init)       : ${this.exportStats.loadedFingerprints}\n` +
      `  Stored Transactions (SQLite)     : ${this.exportStats.storedTransactions}\n` +
      `  Export Queue (SQLite pending)    : ${this.exportStats.retryQueueCount}\n` +
      '===================================================='
    );
    
    // Explicit pipeline invariant check — the equation the operator requested:
    //   parsed = sqlite_inserted + duplicates_skipped + rejected
    //   sqlite_inserted = sheets_appended = marked_exported  (when Sheets connected)
    if (parsedGE > 0) {
      const equation = c.sqliteInserted + c.duplicates + c.rejected;
      if (equation !== parsedGE) {
        getLogger().warn(
          `Pipeline invariant deviation: parsed=${parsedGE} but ` +
          `(sqliteInserted=${c.sqliteInserted} + duplicates=${c.duplicates} + rejected=${c.rejected})=${equation}. ` +
          `Investigate silent-drop between stages.`
        );
      }
      if (this.googleSheetsService.isConnected() && c.sheetsAppended !== c.sqliteInserted) {
        getLogger().warn(
          `Sheets append count mismatch: sqliteInserted=${c.sqliteInserted}, sheetsAppended=${c.sheetsAppended}. ` +
          `Some persisted transactions did not reach Google Sheets.`
        );
      }
    }
    
    getLogger().success(`Monitoring cycle completed in ${Date.now() - start}ms`);
  }
  
  private async processFilter(
    filter: FilterProfile,
    source: SourceAdapter = this.sourceAdapterOverride!,
    groupShouldStop: () => boolean = () => false,
  ): Promise<void> {
    const filterStartedAt = Date.now();
    // Propagate the manual-date preference from config into the service.
    // Default: true (reliability > automation, per production directive).
    const manualDateMode = this.config?.features.manualDateMode !== false;
    
    // The source receives the cooperative cancellation signal and the
    // duplicate detector — the ONLY duplicate scan-termination signal.
    // Uses fingerprint + SQLite + the current in-cycle cache. When a full
    // page returns nothing new, the scanner stops. The engine still
    // receives every parsed row and runs the full pipeline (Essential
    // Field Check → fingerprint → dedup → buffer). Skipped in Initial
    // Sync Mode where every row is new by definition.
    const initialSyncMode = this.config?.features.initialSyncMode === true;
    const duplicateCheck = (raw: RawTransaction): boolean => {
        const fp = this.fingerprintGen.generate(raw);
        return this.processedInCycle.has(fp) || this.isDuplicate(fp);
    };
    
    const maxPages = this.config?.monitoring.maxPageScan || 10;
    const result = await source.scan({
      filter,
      manualDateMode,
      maxPages,
      initialSyncMode,
      shouldStop: () => !this.isRunning || groupShouldStop(),
      duplicateCheck,
      // Preserve Legacy lifecycle ordering: source preparation (including
      // filter application) must succeed before the scan state is exposed.
      onScanStart: () => this.setState('SCANNING_PAGE'),
    });
    
    // PATCH 12 — Process every collected transaction FIRST, regardless of
    // termination reason. Losing already-scanned rows because the pager
    // couldn't advance past the actual last page is the exact production
    // bug this patch fixes. `navigationFailure` remains reserved for
    // genuine DOM/browser failures (see PageScanner classification).
    let bufferedThisFilter = 0;
    for (const raw of result.transactions) {
      if (!this.isRunning) break;
      if (await this.processTransaction(raw, filter) === 'ACCEPTED') bufferedThisFilter++;
    }
    
    // PATCH 12 — Pagination Summary. Emitted once per filter after every
    // collected row has been handed off to the pipeline, so the operator
    // can distinguish End Of Pagination from a real navigation failure and
    // see exactly how many rows survived to the export buffer.
    const parsedThisFilter = result.perPage.reduce((sum, page) => sum + page.rowsParsed, 0);
    const rejectedThisFilter = result.perPage.reduce((sum, page) => sum + page.rowsRejected, 0);
    const duplicateThisFilter = result.perPage.reduce((sum, page) => sum + page.duplicate, 0);
    getLogger().info(
      '\n========== PAGINATION SUMMARY ==========\n' +
      `  Filter Profile        : ${filter.name}\n` +
      `  Configured Max Page   : ${result.configuredMaxPage}\n` +
      `  Available Pages       : ${result.terminationReason === 'END_OF_PAGINATION' ? String(result.lastPageScanned) : `(not fully explored, stopped at ${result.lastPageScanned})`}\n` +
      `  Pages Scanned         : ${result.perPage.length}\n` +
      `  Termination Reason    : ${result.terminationReason}\n` +
      `  Transactions Buffered : ${result.transactions.length}\n` +
      `  Transactions Exported : ${bufferedThisFilter} (queued — actual Sheets append reported in pipeline audit)\n` +
      `  Rows Parsed / Rejected : ${parsedThisFilter} / ${rejectedThisFilter}\n` +
      `  Rows New / Duplicate   : ${parsedThisFilter - duplicateThisFilter} / ${duplicateThisFilter}\n` +
      `  Total Filter Time      : ${Date.now() - filterStartedAt}ms\n` +
      '========================================'
    );
    
    // AFTER the collected buffer is processed, decide whether the cycle
    // must abort. Only a real navigation/browser failure aborts the cycle;
    // END_OF_PAGINATION / MAX_SCAN_REACHED / FULL_DUPLICATE_PAGE /
    // STOP_REQUESTED are all normal terminations.
    if (result.navigationFailure) {
      getLogger().warn(
        `Filter "${filter.name}" ended with ${result.terminationReason} — ` +
        `${result.transactions.length} row(s) already handed off to the pipeline before abort.`
      );
      const err: any = new Error(
        `Navigation verification failed while scanning "${filter.name}" — aborting cycle`
      );
      err.isCycleFatal = true;
      throw err;
    }
  }
  
  private async processTransaction(raw: RawTransaction, filter: FilterProfile): Promise<TransactionOutcome> {
    this.cycleCounters.parsed++;
    
    this.setState('VALIDATING');
    const result = await this.centralIngestService.ingest(raw, filter.name);

    if (result.status === 'REJECTED') {
      this.cycleCounters.rejected++;
      getLogger().diag(
        [
          '========================',
          'ESSENTIAL FIELD CHECK',
          '========================',
          `Filter Profile: ${filter.name}`,
          '--------------------------------',
          `Transaction #${this.cycleCounters.parsed}`,
          `User    : ${raw.userName || '(blank)'}`,
          `Account : ${raw.accountNumber || '(blank)'}`,
          `Amount  : ${raw.amount}`,
          `Process : ${raw.processDate || '(blank)'}`,
          `Result  : REJECTED`,
          `Reason  : ${result.errors.join(', ')}`,
          '--------------------------------'
        ].join('\n')
      );
      return 'REJECTED';
    }
    this.cycleCounters.validated++;
    getLogger().debug(`Transaction validated: user=${raw.userName} amount=${raw.amount}`);
    this.cycleCounters.fingerprintsCreated++;

    if (result.status === 'DUPLICATE') {
      this.processedInCycle.add(result.fingerprint);
      this.cachedFingerprints.add(result.fingerprint);
      getLogger().debug(`SQLite-confirmed duplicate: ${result.fingerprint.slice(0, 12)}…`);
      this.cycleCounters.duplicates++;
      return 'DUPLICATE';
    }

    this.setState('BUFFERING');
    this.buffer.push(result.transaction);
    this.bufferFingerprints.add(result.fingerprint);
    this.processedInCycle.add(result.fingerprint);
    this.cachedFingerprints.add(result.fingerprint);
    this.cycleCounters.sqliteInserted++;
    this.cycleCounters.buffered++;
    this.exportStats.newTransactions++;
    
    getLogger().info(`Buffered new transaction (buffer size: ${this.buffer.length})`);
    
    const batchSize = this.config?.monitoring.batchSize || 1000;
    if (this.buffer.length >= batchSize) {
      await this.exportBuffer();
    }
    return 'ACCEPTED';
  }
  
  private isDuplicate(fingerprint: string): boolean {
    return this.cachedFingerprints.has(fingerprint) || this.bufferFingerprints.has(fingerprint);
  }
  
  /**
   * Clear the volatile accepted-row tracker, then hand already-durable
   * pending work to the existing single recovery owner.
   */
  private async exportBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    this.setState('EXPORTING');
    this.buffer = [];
    this.bufferFingerprints.clear();
    const result = await this.recoverPendingExports();
    this.cycleCounters.sheetsAppended += result.appended;
    this.cycleCounters.markedExported += result.reconciled;
    if (result.reconciled > 0) {
      this.exportStats.lastExportTime = new Date();
      this.exportStats.lastExportCount = result.reconciled;
    }
  }
  
  private async updateExportStats(): Promise<void> {
    this.exportStats.pendingQueueCount = this.buffer.length;
    this.exportStats.retryQueueCount = (await this.sqliteService.getPendingExports()).length;
    this.exportStats.successfulExportsToday = await this.sqliteService.getTodayExportCount();
    this.exportStats.storedTransactions = await this.sqliteService.getStoredTransactionCount();
    this.exportStats.loadedFingerprints = this.cachedFingerprints.size;
    this.exportStats.sqliteConnected = this.sqliteService.isReady();
    this.exportStats.googleSheetsConnected = this.googleSheetsService.isConnected();
    this.exportStats.manualDateMode = this.config?.features.manualDateMode !== false;
    this.exportStats.initialSyncMode = this.config?.features.initialSyncMode === true;
    // Roll cycle counters into the running-today counters.
    this.exportStats.transactionsScanned = this.cycleCounters.parsed;
    this.exportStats.duplicatesSkipped = this.cycleCounters.duplicates;
    this.exportStats.rejectedTransactions = this.cycleCounters.rejected;
    // newTransactions is incremented per-buffer inside processTransaction.
    
    if (this.onStatsUpdate) {
      this.onStatsUpdate({ ...this.exportStats });
    }
  }
  
  getExportStats(): ExportStats { return { ...this.exportStats }; }
  getState(): MonitoringState { return this.state; }
  isMonitoring(): boolean { return this.isRunning; }

  /** Testable/manual lifecycle hook; all drain requests share one FIFO writer queue. */
  async recoverPendingExports(options: ExportDrainOptions = {}): Promise<PendingRecoveryResult> {
    const result = await this.exportWriterQueue.enqueue({
      force: options.force,
      batchSize: options.batchSize ?? this.config?.monitoring.batchSize ?? 1000,
    });
    // Every normal queued invocation carries its own result. A null count is
    // still tolerated for the recovery owner's defensive RUNNING guard.
    if (result.remaining !== null) this.exportStats.retryQueueCount = result.remaining;
    if (result.reconciled > 0) this.resumeMarker = await this.sqliteService.getResumeMarker();
    return result;
  }
  
  private setState(newState: MonitoringState): void {
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
