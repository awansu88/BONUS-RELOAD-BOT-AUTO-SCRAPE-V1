import { chromium, APIRequestContext, BrowserContext, Page } from 'playwright';
import { AppDirectoryManager } from './app-directory-manager';
import { getLogger } from './logger-service';
import { SELECTORS } from '../../utils/selector-repository';
import { formatPanelDate } from '../../utils/date-utils';
import { resolveChromium, applyChromiumResolution, showBrowserNotFoundDialog } from './browser-resolver';

/**
 * Result of a session/login validation check.
 * `reason` is set only when `ok === false` and always carries an operator-friendly message.
 */
export interface SessionValidation {
  ok: boolean;
  reason?: string;
}

// URL patterns that indicate the panel is still on the login screen.
// Kept intentionally permissive because deposit panels use varied login routes.
const LOGIN_URL_PATTERN = /\/(login|signin|log-in|sign-in|auth|session|users\/sign_in)(\/|$|\?|#)/i;

export class PlaywrightService {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  
  constructor(private appDirManager: AppDirectoryManager) {}
  
  async launch(panelUrl?: string): Promise<Page> {
    const logger = getLogger();
    logger.info('Launching browser...');
    
    const userDataDir = this.appDirManager.getBrowserProfileDir();

    // PATCH 13 — Re-resolve Chromium at launch time (in addition to the
    // one-shot resolution at app boot in main/index.ts). This catches
    // the edge case where the operator installed Chromium AFTER app
    // start, and lets us re-apply PLAYWRIGHT_BROWSERS_PATH before we
    // hand control to Playwright.
    const chromiumRes = resolveChromium();
    if (chromiumRes.ok) {
      applyChromiumResolution(chromiumRes);
      logger.info(`Chromium resolved for launch: ${chromiumRes.source} → ${chromiumRes.browsersPath}`);
      logger.info(`  executable: ${chromiumRes.executable}`);
    } else {
      logger.error('Chromium not resolvable at launch time. Presenting the friendly dialog.');
      for (const s of chromiumRes.searched) {
        logger.warn(`  probed ${s.label}: ${s.path} (exists=${s.exists}, hasChromium=${s.hasChromium})`);
      }
      // Show the friendly dialog and throw a clean, translated error.
      // The renderer / IPC caller receives this instead of Playwright's
      // raw "Executable doesn't exist… npx playwright install" message.
      try {
        await showBrowserNotFoundDialog(chromiumRes, this.appDirManager.getLogsDir());
      } catch { /* dialog itself failing must not crash the app */ }
      throw new Error('Chromium browser is not available on this machine. Please reinstall the portable package or run "npx playwright install chromium".');
    }
    
    // PATCH 13.3 — pass `executablePath` DIRECTLY to Playwright.
    //
    // Root cause: `playwright-core@1.42.0` has a hardcoded expected
    // Chromium revision (1105) baked into `browsers.json`. When we
    // rely on `PLAYWRIGHT_BROWSERS_PATH` alone, Playwright still
    // performs its own internal lookup:
    //     ${PLAYWRIGHT_BROWSERS_PATH}/chromium-1105/chrome-win/chrome.exe
    // Because our bundler stages whatever revision `npx playwright
    // install` produced (e.g. chromium-1187), the revisions do not
    // match — and Playwright throws "Executable doesn't exist" even
    // though the resolver already located a perfectly valid chrome.exe
    // at chromium-1187/chrome-win/chrome.exe.
    //
    // Handing `executablePath` to launchPersistentContext() bypasses
    // Playwright's internal revision lookup entirely and uses the
    // exact binary the resolver already validated. This is the
    // documented, stable path in Playwright's public API (LaunchOptions
    // → executablePath, since 1.0).
    //
    // The PLAYWRIGHT_BROWSERS_PATH env var is still set by
    // applyChromiumResolution() as a defensive fallback for any
    // Playwright internal that might consult it for anciliary files.
    //
    // Responsive browser: no fixed viewport, launched maximized. Operators
    // manually interact with the panel; the page must reflow when the
    // window is resized just like a normal Chrome window.
    try {
      this.context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        executablePath: chromiumRes.executable || undefined,
        viewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--start-maximized'
        ]
      });
    } catch (error: any) {
      // PATCH 13 — Wrap Playwright's raw "Executable doesn't exist" error
      // in a friendly dialog. Any other launch failure (permissions,
      // occupied port, etc.) is re-thrown unchanged so it still surfaces
      // in the app log with its original stack.
      const msg = String(error?.message || error || '');
      if (/Executable doesn't exist/i.test(msg) || /Please run.*playwright install/i.test(msg)) {
        logger.error('Playwright reported missing executable at launch — presenting friendly dialog.');
        try {
          await showBrowserNotFoundDialog(resolveChromium(), this.appDirManager.getLogsDir());
        } catch { /* dialog failure is non-fatal */ }
        throw new Error('Chromium browser is not available on this machine. Please reinstall the portable package or run "npx playwright install chromium".');
      }
      throw error;
    }
    
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    
    if (panelUrl) {
      await this.page.goto(panelUrl, { waitUntil: 'networkidle', timeout: 30000 });
    }
    
    logger.success('Browser launched');
    return this.page;
  }
  
  getPage(): Page | null { return this.page; }
  /** Shared-auth HTTP bridge. The persistent visible context remains session owner. */
  getRequestContext(): APIRequestContext | null { return this.context?.request ?? null; }
  isReady(): boolean { return this.page !== null && this.context !== null; }
  
  /**
   * Validate the panel session using the monitoring page itself as the primary
   * signal (not a fragile `.user-info` element).
   *
   * Order of checks:
   *   1. Browser exists
   *   2. Current URL is available
   *   3. Still on login page?  (URL match OR login form visible → return false)
   *   4. Deposit monitoring table exists  (primary success indicator)
   *
   * Each failure branch returns a specific, operator-friendly reason.
   */
  async validateSession(): Promise<SessionValidation> {
    // 1. Browser exists
    if (!this.context || !this.page) {
      return { ok: false, reason: 'Browser not launched' };
    }
    if (this.page.isClosed()) {
      return { ok: false, reason: 'Browser page was closed' };
    }
    
    // 2. Current URL
    let currentUrl = '';
    try {
      currentUrl = this.page.url();
    } catch {
      return { ok: false, reason: 'Cannot read current URL from browser' };
    }
    if (!currentUrl || currentUrl === 'about:blank') {
      return { ok: false, reason: 'Dashboard not loaded — open the deposit panel first' };
    }
    
    // 3. Still on login page?
    const urlLooksLikeLogin = LOGIN_URL_PATTERN.test(currentUrl);
    let loginFormVisible = false;
    try {
      loginFormVisible = (await this.page.$(SELECTORS.SESSION.LOGIN_FORM)) !== null;
    } catch {
      // page navigated during query — treat as unknown, continue
    }
    if (urlLooksLikeLogin || loginFormVisible) {
      return { ok: false, reason: 'Still on login page — complete manual login first' };
    }
    
    // 4. Verify monitoring page — deposit table is the primary success signal.
    let hasDepositTable = false;
    try {
      hasDepositTable = (await this.page.$(SELECTORS.TABLE.MAIN)) !== null;
    } catch {
      return { ok: false, reason: 'Dashboard not loaded — page is not responding' };
    }
    
    if (!hasDepositTable) {
      // Distinguish "session expired" (login form appeared mid-session, caught in step 3)
      // from "wrong page" (logged in but not on the deposit view).
      return {
        ok: false,
        reason: 'Deposit table not found — navigate to the deposit monitoring page'
      };
    }
    
    return { ok: true };
  }
  
  /**
   * Boolean shim retained for callers that only need a yes/no answer.
   * Prefer `validateSession()` for a detailed reason.
   */
  async isLoggedIn(): Promise<boolean> {
    return (await this.validateSession()).ok;
  }
  
  async navigateToDepositPage(depositUrl: string): Promise<void> {
    if (!this.page) throw new Error('Browser not launched');
    
    const logger = getLogger();
    logger.info(`Navigating to deposit page: ${depositUrl}`);
    try {
      await this.page.goto(depositUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await this.page.waitForSelector(SELECTORS.TABLE.MAIN, { state: 'visible', timeout: 10000 });
    } catch (error: any) {
      logger.error(`Failed to load deposit page (${depositUrl})`, error);
      throw error;
    }
  }
  
  async applyFilter(filter: { agent?: string; depositType?: string; name?: string; }, options: { manualDateMode?: boolean } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not launched');
    
    const logger = getLogger();
    const label = filter.name || 'unnamed';
    const manualDateMode = options.manualDateMode === true;

    // ==========================================================
    // [FILTER PROFILE] AVAILABILITY GUARD
    // ----------------------------------------------------------
    // Protective wrapper inserted at the filter-selection layer only.
    // If the profile pins a Deposit Type, verify the option really
    // exists in the panel's `#payment` <select> BEFORE any DOM
    // mutation (no reset, no fill, no Search). If it does not
    // exist, throw a soft "profile unavailable" error so the engine
    // can skip THIS profile and continue with the next enabled one.
    //
    // Absolutely no fallback: never proceed with "All", the browser
    // default, or the first available option when the requested
    // Deposit Type is missing.
    // ==========================================================
    if (filter.depositType) {
      const available = await this.isDepositTypeAvailable(filter.depositType);
      if (!available) {
        logger.warn(
          '\n[FILTER PROFILE]\n' +
          `  Profile : ${label}\n` +
          `  Status  : NOT AVAILABLE\n` +
          `  Action  : SKIPPED\n` +
          '  Continuing with remaining enabled profiles...'
        );
        throw this.profileUnavailable(
          `Deposit Type "${filter.depositType}" is not present in the panel — profile "${label}" skipped (no fallback).`,
          label,
          filter.depositType
        );
      }
      logger.info(
        '\n[FILTER PROFILE]\n' +
        `  Profile : ${label}\n` +
        `  Status  : AVAILABLE\n` +
        '  Search executed.\n' +
        '  Monitoring continues normally.'
      );
    }
    
    // Monitoring is always for the current local day when auto-date is active.
    // Filter profile dates are intentionally IGNORED — dates are the engine's
    // responsibility, not the profile's. In manualDateMode the operator sets
    // the dates in the browser once and the engine leaves them alone.
    const today = formatPanelDate(new Date());
    
    // Read whatever dates the browser currently holds (source of truth in
    // manual mode; diagnostic reference in auto mode).
    let browserFrom = '';
    let browserTo = '';
    try {
      browserFrom = await this.page.inputValue(SELECTORS.FILTER.DATE_FROM);
      browserTo   = await this.page.inputValue(SELECTORS.FILTER.DATE_TO);
    } catch { /* fields may not exist yet — surfaced below */ }
    
    logger.info(
      `Applying filter: ${label} (agent=${filter.agent || '*'}, type=${filter.depositType || '*'}, ` +
      `dateMode=${manualDateMode ? 'MANUAL' : 'AUTO'}, ` +
      `browserFrom="${browserFrom}", browserTo="${browserTo}")`
    );
    
    logger.diag(
      [
        '--------------------------------------------------',
        'FILTER DIAGNOSTIC',
        `Profile        : ${label}`,
        `Date Mode      : ${manualDateMode ? 'MANUAL (operator-selected)' : 'AUTO (today)'}`,
        `Browser From   : "${browserFrom}"`,
        `Browser To     : "${browserTo}"`,
        `Auto Target    : ${today}`,
        `Agent          : ${filter.agent || '(any)'}`,
        `Deposit Type   : ${filter.depositType || '(any)'}`,
        `Current URL    : ${this.page.url()}`,
        '--------------------------------------------------'
      ].join('\n')
    );
    
    try {
      // ==========================================================
      // Step 1: RESET the filter form so no state leaks from the
      // previously-applied filter profile. Every profile must be
      // completely independent.
      //   • Agent input   → clear
      //   • Deposit Status → force back to "Approve" (engine invariant)
      //   • Deposit Type  → clear to default "" option
      // Dates are LEFT UNTOUCHED: manual mode requires it, and auto mode
      // will overwrite them explicitly in step 3.
      // ==========================================================
      await this.resetFilterFields();
      
      // Step 2: apply this profile's values.
      if (filter.agent) await this.page.fill(SELECTORS.FILTER.AGENT_INPUT, filter.agent);
      await this.page.selectOption(SELECTORS.FILTER.DEPOSIT_STATUS, 'Approve');
      if (filter.depositType) {
        try {
          // PATCH 12 — always select by explicit VALUE. `filter.depositType`
          // holds the option's `value` attribute (e.g. "286") — never the
          // display label — so we must not let Playwright's default label-
          // match kick in when a label like "Manual Deposit" would collide
          // with a different bank listing the same word.
          await this.page.selectOption(SELECTORS.FILTER.DEPOSIT_TYPE, { value: filter.depositType });
        } catch (e: any) {
          // The availability probe above already gated this branch, but
          // the option can theoretically disappear between probe and
          // select (concurrent panel refresh). Never fall back to the
          // default option — surface as PROFILE-UNAVAILABLE so the
          // engine skips this profile and never fires Search with a
          // wrong Deposit Type.
          logger.warn(
            `Deposit type "${filter.depositType}" became unselectable during apply — treating as NOT AVAILABLE. ${e?.message || ''}`
          );
          throw this.profileUnavailable(
            `Deposit Type "${filter.depositType}" is no longer selectable — profile "${label}" skipped (no fallback).`,
            label,
            filter.depositType
          );
        }
      }
      
      // Step 3: dates. Two mutually-exclusive strategies.
      if (manualDateMode) {
        // MANUAL — never overwrite what the operator picked. Just verify
        // that both fields already carry a value so Search can succeed.
        if (!browserFrom || !browserTo) {
          throw this.cycleFatal(
            `Manual date mode: browser has empty dates ` +
            `(From="${browserFrom}", To="${browserTo}"). ` +
            `Please select Date From and Date To in the browser before starting monitoring.`
          );
        }
        logger.info(`Manual date mode: using operator-selected From=${browserFrom} To=${browserTo}`);
      } else {
        // AUTO — populate both dates and verify.
        await this.fillAndVerifyDate(SELECTORS.FILTER.DATE_FROM, today, 'Date From');
        await this.fillAndVerifyDate(SELECTORS.FILTER.DATE_TO, today, 'Date To');
      }
      
      // Step 4: submit search and wait for the deposit table to (re)render.
      await this.page.click(SELECTORS.FILTER.SEARCH_BUTTON);
      logger.info('Waiting search result…');
      
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        logger.warn('Search result: network did not go idle within 10s — continuing');
      }
      try {
        await this.page.waitForSelector(SELECTORS.TABLE.MAIN, { state: 'visible', timeout: 10000 });
      } catch (error: any) {
        logger.error(`Search result timeout: deposit table did not appear within 10s (selector "${SELECTORS.TABLE.MAIN}")`, error);
        throw error;
      }
      await this.page.waitForTimeout(1000);
      
      logger.success(`Filter applied: ${label}`);
    } catch (error: any) {
      // Profile-availability skip: NOT an application error. Do not log
      // as "Failed to apply filter" (that already happened via the
      // [FILTER PROFILE] warning) and re-throw so the engine can move
      // to the next enabled profile without treating it as a bug.
      if (error && (error as any).isProfileUnavailable) throw error;
      logger.error(`Failed to apply filter: ${label}`, error);
      // Preserve the CYCLE-FATAL tag so the engine can abort the cycle
      // instead of moving on to the next filter with a broken search state.
      if (error && (error as any).isCycleFatal) throw error;
      throw error;
    }
  }
  
  /**
   * Restore every non-date filter field to its baseline. Called at the top
   * of applyFilter() so no value from the previously-applied profile leaks
   * into the next one. Dates are intentionally NOT reset — the caller (auto
   * mode overwrites them; manual mode preserves the operator's selection).
   *
   * All calls use short (2 s) timeouts because the panel may not have a
   * matching default option for every dropdown — best-effort reset must
   * never stall the monitoring cycle.
   */
  private async resetFilterFields(): Promise<void> {
    if (!this.page) return;
    const logger = getLogger();
    try {
      await this.page.fill(SELECTORS.FILTER.AGENT_INPUT, '', { timeout: 2000 });
    } catch (e: any) {
      logger.debug(`Agent field reset skipped: ${e?.message || e}`);
    }
    try {
      // Force back to the engine's invariant: only Approved rows are monitored.
      await this.page.selectOption(SELECTORS.FILTER.DEPOSIT_STATUS, 'Approve', { timeout: 2000 });
    } catch (e: any) {
      logger.debug(`Status reset skipped: ${e?.message || e}`);
    }
    try {
      // Clear deposit-type to its default option. selectOption('') selects
      // the option whose value is '' (typical "All" default in Yii2 dropdowns).
      await this.page.selectOption(SELECTORS.FILTER.DEPOSIT_TYPE, { value: '' }, { timeout: 2000 });
    } catch {
      try {
        await this.page.selectOption(SELECTORS.FILTER.DEPOSIT_TYPE, { index: 0 }, { timeout: 2000 });
      } catch (e: any) {
        logger.debug(`Deposit type reset skipped: ${e?.message || e}`);
      }
    }
  }
  
  /**
   * Fill a date input and verify the value round-tripped correctly.
   *
   * The production panel uses jQuery-driven text inputs marked `class="datepicker"`
   * that expose a `has-value` state class only when the plugin has accepted a
   * date via its own change flow. `page.fill()` sets `.value` and dispatches
   * native `input`/`change` events but does NOT satisfy the plugin's internal
   * state — its blur handler can then wipe the value at form-submit time,
   * causing the panel to silently return an empty search result.
   *
   * Strategy (progressive, no-op on plain inputs):
   *   1. `page.fill(selector, value)` — fast path, fires native events.
   *   2. If the element carries the `datepicker` class AND jQuery is present,
   *      trigger `changeDate`, `change`, and `blur` on the jQuery object so
   *      the plugin's own listener updates its internal state.
   *   3. Read back with `page.inputValue(selector)` and compare EXACTLY.
   *      A mismatch throws a CYCLE-FATAL error so the engine aborts the cycle
   *      instead of silently continuing with empty dates.
   */
  private async fillAndVerifyDate(selector: string, value: string, label: string): Promise<void> {
    const page = this.page!;

    try {
      await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
    } catch (error: any) {
      throw this.cycleFatal(`${label}: input not visible ("${selector}") within 5s — panel structure may have changed. ${error?.message || ''}`);
    }

    // 1. Standard fill (fires native input + change events).
    try {
      await page.fill(selector, value);
    } catch (error: any) {
      throw this.cycleFatal(`${label}: could not fill "${selector}" — ${error?.message || error}`);
    }

    // 2. Notify jQuery-datepicker plugin (no-op on plain inputs).
    await page.$eval(selector, (el) => {
      const input = el as HTMLInputElement;
      if (!input.classList.contains('datepicker')) return;
      const w = window as any;
      if (w.jQuery) {
        try {
          const $ = w.jQuery;
          $(input).trigger('changeDate').trigger('change').trigger('blur');
        } catch { /* plugin absent or errored — native events already fired */ }
      }
    });

    // 3. Verify the value round-tripped. Any deviation aborts the cycle.
    let readBack = '';
    try {
      readBack = await page.inputValue(selector);
    } catch (error: any) {
      throw this.cycleFatal(`${label}: could not read back "${selector}" — ${error?.message || error}`);
    }
    if (!readBack || readBack.trim() !== value) {
      throw this.cycleFatal(
        `${label}: value did not persist after fill (selector="${selector}", attempted="${value}", readback="${readBack || '(empty)'}") — cannot start search`
      );
    }
  }

  /**
   * Build an Error tagged as CYCLE-FATAL so the MonitoringEngine's per-filter
   * try/catch can distinguish it from filter-specific errors and abort the
   * whole cycle immediately (never continue scanning after a date/search failure).
   */
  private cycleFatal(message: string): Error {
    const err = new Error(message);
    (err as any).isCycleFatal = true;
    return err;
  }

  /**
   * Check whether the panel's Deposit Type <select> currently exposes an
   * option matching `depositType` (by value OR trimmed visible text).
   *
   * Runs BEFORE any DOM mutation in applyFilter() and returns a plain
   * boolean. Never throws for the "option is missing" case — that is a
   * legitimate production state that this patch is designed to handle
   * (the panel temporarily removed a payment method). Only unexpected
   * DOM/query failures are logged and treated as "not available" so no
   * accidental Search with a wrong Deposit Type can happen.
   */
  private async isDepositTypeAvailable(depositType: string): Promise<boolean> {
    if (!this.page) return false;
    const target = (depositType || '').trim();
    if (!target) return true; // no deposit-type restriction on this profile
    try {
      // Wait briefly so we don't race the initial page render; use a short
      // timeout because we already know the deposit table is loaded by the
      // time applyFilter() is invoked.
      await this.page.waitForSelector(SELECTORS.FILTER.DEPOSIT_TYPE, { state: 'attached', timeout: 5000 });
      const options = await this.page.$$eval(
        `${SELECTORS.FILTER.DEPOSIT_TYPE} option`,
        (nodes) => nodes.map((n) => {
          const el = n as HTMLOptionElement;
          return { value: el.value || '', text: (el.textContent || '').trim() };
        })
      );
      return options.some(o => o.value === target || o.text === target);
    } catch (e: any) {
      getLogger().warn(
        `Deposit Type availability probe failed for "${target}" — treating as NOT AVAILABLE. ${e?.message || e}`
      );
      return false;
    }
  }

  /**
   * Build an Error tagged as PROFILE-UNAVAILABLE so the MonitoringEngine's
   * per-filter try/catch skips ONLY this profile (no fallback, no cycle
   * abort) and continues with the next enabled one.
   */
  private profileUnavailable(message: string, profileName: string, depositType?: string): Error {
    const err = new Error(message);
    (err as any).isProfileUnavailable = true;
    (err as any).profileName = profileName;
    (err as any).depositType = depositType;
    return err;
  }

  /**
   * PATCH 12 — Generic dropdown reader (Patch 3).
   *
   * Read every <option> under `selector` as a `{ value, label }` pair.
   *   • `value`  = the option's raw `value` attribute (used by Playwright
   *                 `selectOption({ value })` when applying filters).
   *   • `label`  = the option's visible `textContent`, trimmed.
   *
   * Empty-value / empty-label options are filtered out. The special
   * "All" placeholder is preserved so the UI can render it as `— All —`
   * (Patch 4). No de-duplication of values (duplicates from server-side
   * templates are still passed through as-is).
   *
   * NEVER throws for a missing selector — a panel that doesn't expose a
   * given <select> simply yields an empty array so callers can treat the
   * field as free-text.
   */
  async readSelectOptions(selector: string): Promise<Array<{ value: string; label: string }>> {
    if (!this.page) return [];
    try {
      await this.page.waitForSelector(selector, { state: 'attached', timeout: 2000 });
      const opts = await this.page.$$eval(`${selector} option`, (nodes) =>
        nodes.map((n) => {
          const el = n as HTMLOptionElement;
          return {
            value: (el.value ?? '').trim(),
            label: ((el.textContent ?? '').trim())
          };
        })
      );
      // Drop rows where BOTH value and label are empty. Keep every real
      // option — including the "All" placeholder — because the UI needs
      // the label to render "— All —".
      return opts.filter(o => o.value !== '' || o.label !== '');
    } catch {
      return [];
    }
  }

  /**
   * Iteration 12 — read the currently-available Bank and Payment options
   * from the deposit-transactions panel.
   *
   * This method is NEVER called from the monitoring cycle. It is only
   * invoked when the operator explicitly opens the browser or clicks
   * "Refresh Options" in the Filter Profiles page. It is read-only and
   * never mutates the DOM.
   *
   * PATCH 12 — return `{ value, label }` pairs so the UI can display
   * human-readable labels while Playwright continues to use the option's
   * raw value when `selectOption()` runs.
   */
  async readFilterOptions(): Promise<{
    payment: Array<{ value: string; label: string }>;
    bank:    Array<{ value: string; label: string }>;
    agent:   Array<{ value: string; label: string }>;
  }> {
    if (!this.page) throw new Error('Browser not launched');
    const [payment, bank, agent] = await Promise.all([
      this.readSelectOptions(SELECTORS.FILTER.DEPOSIT_TYPE),
      this.readSelectOptions('#bank'),
      this.readSelectOptions('#deposit-agent-name'),
    ]);
    return { payment, bank, agent };
  }
  
  async captureErrorScreenshot(errorContext: string): Promise<string | null> {
    if (!this.page) return null;
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `error-${errorContext}-${timestamp}.png`;
      const filepath = `${this.appDirManager.getScreenshotsDir()}/${filename}`;
      
      await this.page.screenshot({ path: filepath, fullPage: false });
      return filepath;
    } catch {
      return null;
    }
  }
  
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
    getLogger().info('Browser closed');
  }
}
