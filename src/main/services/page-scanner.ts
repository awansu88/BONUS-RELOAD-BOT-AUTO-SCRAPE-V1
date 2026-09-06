import { Page } from 'playwright';
import { RawTransaction } from '../../types/transaction';
import { FilterProfile } from '../../types/filter-profile';
import { HTMLMapper } from './html-mapper';
import { SELECTORS } from '../../utils/selector-repository';
import { getLogger } from './logger-service';
import { extractPageNumber, urlHasPageMarker } from '../../utils/date-utils';
import type { PageStats, ScanTerminationReason, SourceScanResult } from '../sources/source-adapter';

/**
 * Per-page counters that MonitoringEngine uses to render the diagnostic
 * "Page N Summary" block. `duplicate` / `buffered` / `exported` are filled
 * in by the engine after processing.
 */
export type { PageStats, ScanTerminationReason, SourceScanResult as ScanResult } from '../sources/source-adapter';

/**
 * PATCH 12 — Scan termination classification.
 *
 * Distinguishes benign end-of-scan conditions (which MUST NOT discard
 * transactions already collected) from genuine navigation/browser
 * failures (which are still cycle-fatal). Kept as a string union to
 * remain compatible with existing pass-by-value plumbing.
 */
export class PageScanner {
  private htmlMapper: HTMLMapper;
  private shouldStop: () => boolean = () => false;
  /**
   * Duplicate detector supplied by MonitoringEngine. Returns true when the
   * raw transaction is already known to SQLite (or the in-cycle cache).
   *
   * This is the ONLY per-row check the scanner performs. Fingerprint +
   * SQLite are the only signals used to decide whether the scanner should
   * continue past the current page — no Process Date compare, no Resume
   * Marker compare, no Sheets state compare.
   */
  private isDuplicate: ((raw: RawTransaction) => boolean) | null = null;
  
  constructor(private page: Page) {
    this.htmlMapper = new HTMLMapper(page);
  }
  
  /**
   * Register the duplicate detector. The scanner uses it to decide when a
   * page is 100% duplicates and scanning can stop. Passing null (or not
   * calling this at all) disables the stop condition — the scanner will
   * walk every page up to `maxPages` (used only by the initial-sync path
   * where SQLite is empty and every row is new by definition).
   */
  setDuplicateCheck(fn: ((raw: RawTransaction) => boolean) | null): void {
    this.isDuplicate = fn;
  }
  
  /**
   * Register a cancellation predicate. The scanner checks it before every
   * page scan and before every pagination click; when it returns true the
   * scanner exits its loop cleanly (marking the run as complete, NOT as a
   * navigation failure). Used by MonitoringEngine to honour Stop Monitoring
   * without waiting for pagination to finish (Bug #3).
   */
  setShouldStop(predicate: () => boolean): void {
    this.shouldStop = predicate;
  }
  
  /**
   * Scan pages using BOTH the browser URL AND the pagination widget's active
   * page indicator as sources of truth. Never trusts an internal counter.
   *
   * Loop invariant:
   *   currentPage = getActivePageFromDom() ?? extractPageNumber(url)
   *   expected    = currentPage + 1
   *   after click: verify BOTH URL page and widget active page equal expected
   *   any mismatch → log FAIL block, mark navigationFailure=true, STOP.
   */
  async scanPages(filter: FilterProfile, maxPages: number = 10): Promise<SourceScanResult> {
    const logger = getLogger();
    const allTransactions: RawTransaction[] = [];
    const perPage: PageStats[] = [];
    let navigationFailure = false;
    let terminationReason: ScanTerminationReason = 'END_OF_PAGINATION';
    let lastPageScanned = 0;
    let scanned = 0;
    
    logger.info(`Starting scan for filter: ${filter.name} (maxPageScan=${maxPages})`);
    
    while (scanned < maxPages) {
      // Honour Stop Monitoring immediately — exit the loop cleanly BEFORE
      // parsing a fresh page or issuing another pagination click.
      if (this.shouldStop()) {
        logger.info(`Stop requested — exiting scan after ${scanned} page(s).`);
        terminationReason = 'STOP_REQUESTED';
        break;
      }
      
      const currentUrl = this.page.url();
      const domPage = await this.getActivePageFromDom();
      const urlPage = urlHasPageMarker(currentUrl) ? extractPageNumber(currentUrl) : null;
      // Prefer the DOM widget (panel is authoritative). Fall back to URL,
      // then to 1 when neither source has a marker (first page of a search).
      const currentBrowserPage = domPage ?? urlPage ?? 1;
      logger.info(`Scanning page ${currentBrowserPage}`);
      
      // Parse rows
      const parse = await this.htmlMapper.parseCurrentPage();
      logger.info(`Rows found on page ${currentBrowserPage}: ${parse.transactions.length}`);
      
      // Diagnostic block: Table
      logger.diag(
        [
          '--------------------------------------------------',
          'TABLE DIAGNOSTIC',
          `Current Page  : ${currentBrowserPage}`,
          `URL Page      : ${urlPage ?? '(no marker)'}`,
          `DOM Page      : ${domPage ?? '(not found)'}`,
          `Current URL   : ${currentUrl}`,
          `Rows Detected : ${parse.rowsDetected}`,
          `Rows Parsed   : ${parse.transactions.length}`,
          `Rows Rejected : ${parse.rejections.length}`,
          '--------------------------------------------------'
        ].join('\n')
      );
      
      // Per-row rejection diagnostics
      for (const rej of parse.rejections) {
        logger.diag(
          [
            '--------------------------------------------------',
            `Row #${rej.rowIndex}`,
            'Rejected',
            'Reason:',
            rej.reason,
            '--------------------------------------------------'
          ].join('\n')
        );
      }
      
      // Every scanned transaction is returned. The engine remains
      // responsible for the full pipeline (Essential Field Check →
      // fingerprint → dup → buffer). The scanner uses the same duplicate
      // predicate ONLY to detect the "100% duplicate page" stop.
      let newOnPage = 0;
      let duplicateOnPage = 0;
      for (const transaction of parse.transactions) {
        const dup = this.isDuplicate ? this.isDuplicate(transaction) : false;
        if (dup) duplicateOnPage++; else newOnPage++;
        allTransactions.push(transaction);
      }
      // First page where every parsed row is already known → stop.
      // A page with zero parsed rows (all rejected / empty result) does
      // NOT trigger the stop — we keep walking until we actually see a
      // fully duplicated page of real transactions.
      const stopByDuplicatePage =
        this.isDuplicate !== null &&
        parse.transactions.length > 0 &&
        newOnPage === 0;
      if (stopByDuplicatePage) {
        logger.info(
          '\n========== SCAN TERMINATION (100% duplicate page) ==========\n' +
          `  Page              : ${currentBrowserPage}\n` +
          `  Rows on Page      : ${parse.transactions.length}\n` +
          `  New Transactions  : 0\n` +
          `  Duplicates        : ${duplicateOnPage}\n` +
          `  Result            : STOP — first fully duplicated page reached\n` +
          '============================================================'
        );
      } else {
        logger.info(
          `Page ${currentBrowserPage} — new=${newOnPage}, duplicate=${duplicateOnPage} (continue scan)`
        );
      }
      
      const pageStats: PageStats = {
        pageNumber: currentBrowserPage,
        rowsDetected: parse.rowsDetected,
        rowsParsed: parse.transactions.length,
        rowsRejected: parse.rejections.length,
        duplicate: duplicateOnPage, buffered: 0, exported: 0
      };
      perPage.push(pageStats);
      scanned++;
      lastPageScanned = currentBrowserPage;
      
      if (stopByDuplicatePage) {
        terminationReason = 'FULL_DUPLICATE_PAGE';
        break;
      }
      
      // Second stop-check: don't spend time navigating to the next page if
      // the operator hit Stop while we were parsing.
      if (this.shouldStop()) {
        logger.info(`Stop requested — exiting scan after ${scanned} page(s), skipping pagination.`);
        terminationReason = 'STOP_REQUESTED';
        break;
      }
      
      // Respect the configured maxPageScan explicitly: never click Next past
      // the operator-set limit (Bug #2).
      if (scanned >= maxPages) {
        logger.info(`Reached maxPageScan=${maxPages} — stopping pagination.`);
        terminationReason = 'MAX_SCAN_REACHED';
        break;
      }
      
      // Check for a valid, enabled Next anchor scoped to the pagination widget.
      const hasNext = await this.hasNextPage(currentBrowserPage);
      if (!hasNext) {
        logger.info('No more pages — end of pagination reached.');
        terminationReason = 'END_OF_PAGINATION';
        break;
      }
      
      const expected = currentBrowserPage + 1;
      logger.info(`Moving to page ${expected}`);
      
      // Navigate and verify against BOTH URL and DOM widget.
      // PATCH 12 — navigateAndVerify may return a benign END_OF_PAGINATION
      // signal (throw with `endOfPagination=true`) when the click did not
      // advance the widget but there is no genuine browser failure. Only
      // real DOM/browser disagreements are treated as navigation failures.
      try {
        await this.navigateAndVerify(currentUrl, currentBrowserPage, expected);
      } catch (error: any) {
        if (error && error.endOfPagination === true) {
          logger.info(
            `Pagination widget did not advance past page ${currentBrowserPage} — treating as End Of Pagination (${error.message}).`
          );
          terminationReason = 'END_OF_PAGINATION';
          break;
        }
        logger.error(`Pagination failed while moving to page ${expected}`, error);
        navigationFailure = true;
        terminationReason = error && error.browserFailure === true
          ? 'BROWSER_FAILURE'
          : 'NAVIGATION_FAILURE';
        break;
      }
    }
    
    logger.success(
      `Pagination completed: scanned ${scanned} page(s), found ${allTransactions.length} new transaction(s)`
    );
    
    return {
      transactions: allTransactions,
      perPage,
      navigationFailure,
      terminationReason,
      lastPageScanned,
      configuredMaxPage: maxPages
    };
  }
  
  /**
   * Read the panel's active-page indicator from the DOM. Returns null when
   * the pagination widget is not rendered or the active marker is missing —
   * callers fall back to URL parsing in that case.
   *
   * The panel is the source of truth: if the widget says we're on page 1,
   * we are on page 1, regardless of what the URL claims.
   */
  private async getActivePageFromDom(): Promise<number | null> {
    try {
      return await this.page.evaluate((activeSel: string) => {
        const nodes = document.querySelectorAll(activeSel);
        for (const node of Array.from(nodes)) {
          const text = (node.textContent || '').trim();
          const m = text.match(/\d+/);
          if (m) return parseInt(m[0], 10);
        }
        return null;
      }, SELECTORS.PAGINATION.ACTIVE);
    } catch {
      return null;
    }
  }
  
  /**
   * PATCH 12 — Return true only when the pagination widget contains an
   * ENABLED Next anchor pointing at a page STRICTLY greater than the
   * current active page. Checks (in order, all must pass):
   *
   *   1. Pagination container exists.
   *   2. There is at least one <a> whose href resolves to a page > current
   *      OR a rel="next" anchor that is not marked disabled.
   *   3. The candidate anchor is NOT inside an <li> flagged `disabled` /
   *      `aria-disabled` / `active` / with text starting with the current
   *      page (some Yii2 pagers render a phantom Next that just re-links to
   *      the current page on the final page).
   *   4. The candidate href is not `#`, empty, or `javascript:void(0)`.
   *   5. No sibling "last page" marker (`.last.disabled`, `[data-last]`)
   *      appears next to the widget.
   *
   * Callers still fall back gracefully if this returns false — that is
   * treated as END_OF_PAGINATION, never as a navigation failure.
   */
  private async hasNextPage(currentPage?: number): Promise<boolean> {
    try {
      return await this.page.evaluate(
        ({ container, nextSel, currentPage }: { container: string; nextSel: string; currentPage: number | null }) => {
          const boxes = Array.from(document.querySelectorAll(container));
          if (boxes.length === 0) return false;
          
          const isDisabledAnchor = (a: HTMLAnchorElement): boolean => {
            if (a.getAttribute('aria-disabled') === 'true') return true;
            if (a.hasAttribute('disabled')) return true;
            const li = a.closest('li');
            if (li) {
              if (li.classList.contains('disabled')) return true;
              if (li.classList.contains('active'))   return true; // Next-that-loops-to-self
              if (li.getAttribute('aria-disabled') === 'true') return true;
            }
            return false;
          };
          const isJunkHref = (href: string): boolean => {
            if (!href) return true;
            const h = href.trim();
            if (h === '' || h === '#') return true;
            if (h.toLowerCase().startsWith('javascript:')) return true;
            return false;
          };
          const extractHrefPage = (href: string): number | null => {
            const q = (href.match(/[?&]page=(\d+)/) || [])[1];
            if (q) return parseInt(q, 10);
            const p = (href.match(/\/page\/(\d+)(?:\/|$)/) || [])[1];
            if (p) return parseInt(p, 10);
            return null;
          };
          
          for (const box of boxes) {
            // A "last page indicator" nearby → definitely no next page.
            if (box.querySelector('li.last.disabled, li[data-last="true"]')) continue;
            
            const anchors = Array.from(box.querySelectorAll('a')) as HTMLAnchorElement[];
            
            // Strategy A: a page-number anchor pointing STRICTLY beyond current.
            if (currentPage !== null) {
              for (const a of anchors) {
                if (isDisabledAnchor(a)) continue;
                const href = a.getAttribute('href') || '';
                if (isJunkHref(href)) continue;
                const p = extractHrefPage(href);
                if (p !== null && p > currentPage) return true;
              }
            }
            
            // Strategy B: rel="next" (or matching next-selector) that is enabled AND
            // whose href either has no page marker (relative pager) or points beyond current.
            const nexts = Array.from(box.querySelectorAll(nextSel)) as HTMLAnchorElement[];
            for (const a of nexts) {
              if (isDisabledAnchor(a)) continue;
              const href = a.getAttribute('href') || '';
              if (isJunkHref(href)) continue;
              const p = extractHrefPage(href);
              if (currentPage !== null && p !== null && p <= currentPage) continue;
              return true;
            }
          }
          return false;
        },
        {
          container: SELECTORS.PAGINATION.CONTAINER,
          nextSel: SELECTORS.PAGINATION.NEXT,
          currentPage: typeof currentPage === 'number' ? currentPage : null
        }
      );
    } catch (e) {
      getLogger().warn('Failed to inspect pagination Next button', e);
      return false;
    }
  }
  
  /**
   * Click the pagination anchor for `expected`, then verify the browser
   * actually landed there by inspecting BOTH:
   *   1. `page.url()` — if a page marker is present
   *   2. `.pagination .active` — the widget's own indicator (authoritative)
   *
   * Only when both agree with `expected` is navigation considered successful.
   * Mismatches throw a CYCLE-FATAL error so the engine aborts the scan.
   */
  private async navigateAndVerify(fromUrl: string, fromPage: number, expected: number): Promise<void> {
    const logger = getLogger();
    
    // Prefer an anchor scoped to the pagination container that either
    //   (a) points to page=<expected>, or
    //   (b) is the rel="next" inside the pagination box.
    // Falls back to a page-scoped rel="next" click. Never picks up
    // rel="next" from outside the pagination widget.
    const clickInfo = await this.page.evaluate(
      ({ container, nextSel, expected }: { container: string; nextSel: string; expected: number }) => {
        const boxes = Array.from(document.querySelectorAll(container));
        if (boxes.length === 0) return { clicked: false, reason: 'pagination container missing' };
        for (const box of boxes) {
          // Strategy 1: specific page number anchor inside the pagination widget.
          const anchors = Array.from(box.querySelectorAll('a')) as HTMLAnchorElement[];
          for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!href || href === '#') continue;
            const q = (href.match(/[?&]page=(\d+)/) || [])[1];
            const p = q || (href.match(/\/page\/(\d+)(?:\/|$)/) || [])[1];
            if (p && parseInt(p, 10) === expected) {
              a.click();
              return { clicked: true, reason: `page=${expected} link` };
            }
          }
          // Strategy 2: rel="next" inside pagination widget.
          const next = box.querySelector(nextSel) as HTMLAnchorElement | null;
          if (next) {
            const href = next.getAttribute('href') || '';
            const disabled = next.getAttribute('aria-disabled') === 'true'
              || (next.closest('li')?.classList.contains('disabled') ?? false);
            if (!disabled && href && href !== '#') {
              next.click();
              return { clicked: true, reason: 'rel=next inside pagination' };
            }
          }
        }
        return { clicked: false, reason: 'no enabled anchor for target page' };
      },
      { container: SELECTORS.PAGINATION.CONTAINER, nextSel: SELECTORS.PAGINATION.NEXT, expected }
    );
    
    if (!clickInfo.clicked) {
      // PATCH 12 — No enabled anchor for the target page is NOT a browser
      // failure; it just means the pager exhausted itself between hasNextPage()
      // and the click. Surface as END_OF_PAGINATION so already-collected rows
      // are exported normally.
      const err: any = new Error(`No enabled Next anchor: ${clickInfo.reason} (target page ${expected})`);
      err.endOfPagination = true;
      throw err;
    }
    
    // Wait for the widget's active marker OR the URL to equal `expected`.
    // Either signal is sufficient to consider navigation "in flight" — we
    // will then insist on BOTH agreeing during verification below.
    try {
      await this.page.waitForFunction(
        ({ oldUrl, oldPage, expectedPage, activeSel }: { oldUrl: string; oldPage: number; expectedPage: number; activeSel: string }) => {
          // URL page (if marker present)
          const url = window.location.href;
          let urlPage: number | null = null;
          try {
            const u = new URL(url);
            const q = u.searchParams.get('page');
            if (q && /^\d+$/.test(q)) urlPage = parseInt(q, 10);
            else {
              const m = u.pathname.match(/\/page\/(\d+)(?:\/|$)/);
              if (m) urlPage = parseInt(m[1], 10);
            }
          } catch { /* ignore */ }
          
          // DOM active page
          let domPage: number | null = null;
          const nodes = document.querySelectorAll(activeSel);
          for (const node of Array.from(nodes)) {
            const t = (node.textContent || '').trim();
            const m = t.match(/\d+/);
            if (m) { domPage = parseInt(m[0], 10); break; }
          }
          
          if (domPage === expectedPage) return true;
          if (urlPage === expectedPage && url !== oldUrl) return true;
          // Guard: still on the same page → keep waiting.
          if (domPage === oldPage && url === oldUrl) return false;
          return false;
        },
        {
          oldUrl: fromUrl,
          oldPage: fromPage,
          expectedPage: expected,
          activeSel: SELECTORS.PAGINATION.ACTIVE
        },
        { timeout: 10000 }
      );
    } catch {
      // Fall through — verification block below produces the definitive diagnostic.
    }
    
    // Wait for the table to be renderable on the new page.
    try {
      await this.page.waitForSelector(SELECTORS.TABLE.MAIN, { state: 'visible', timeout: 10000 });
    } catch (error: any) {
      logger.error(
        `Timeout waiting for deposit table on page ${expected} (selector "${SELECTORS.TABLE.MAIN}", 10s)`,
        error
      );
    }
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      logger.warn(`Network did not go idle within 10s on page ${expected} — continuing`);
    }
    await this.page.waitForTimeout(300);
    
    // === Post-navigation verification (browser + DOM widget are source of truth) ===
    const actualUrl = this.page.url();
    const urlPage = urlHasPageMarker(actualUrl) ? extractPageNumber(actualUrl) : null;
    const domPage = await this.getActivePageFromDom();
    const detected = domPage ?? urlPage ?? 1;
    
    // Success requires the DOM widget to agree, and (when URL exposes a page
    // marker) the URL to agree as well.
    const domOk = domPage !== null ? domPage === expected : true;
    const urlOk = urlPage !== null ? urlPage === expected : true;
    const ok = (domPage === expected) || (urlPage === expected && domOk);
    const status = ok ? 'SUCCESS' : 'FAILED';
    
    const diagBlock = [
      '--------------------------------------------------',
      'PAGINATION DIAGNOSTIC',
      'Current Browser URL',
      actualUrl,
      `Expected Page   : ${expected}`,
      `URL Page        : ${urlPage ?? '(no marker)'}`,
      `DOM Widget Page : ${domPage ?? '(not found)'}`,
      `Detected Page   : ${detected}`,
      `Navigation Status: ${status}`,
      ...(ok ? [] : ['Reason', 'Browser did not navigate to the expected page (URL and/or widget disagreed).']),
      '--------------------------------------------------'
    ].join('\n');
    logger.diag(diagBlock);
    
    if (!ok) {
      // PATCH 12 — Classify the failure:
      //   • DOM widget still on the OLD page + URL unchanged  → the click did
      //     not advance the pager. On the actual last page (Configured >
      //     Available) this is exactly what happens: the anchor exists but
      //     the widget refuses to move. Treat as END_OF_PAGINATION so the
      //     engine exports what it already collected instead of aborting.
      //   • Anything else (URL moved to a wrong page, DOM disagreed with
      //     itself, page went blank) → real navigation failure, cycle fatal.
      const pagerStuck =
        (domPage === fromPage || domPage === null) &&
        (urlPage === null || urlPage === fromPage) &&
        actualUrl === fromUrl;
      logger.error(
        `Navigation verification failed. Expected page ${expected}, URL=${urlPage ?? 'n/a'}, DOM=${domPage ?? 'n/a'}. URL: ${actualUrl}`
      );
      if (pagerStuck) {
        const err: any = new Error(
          `Pager did not advance past page ${fromPage} — treating as end of pagination.`
        );
        err.endOfPagination = true;
        throw err;
      }
      const err: any = new Error(
        `Navigation verification failed: expected ${expected}, urlPage=${urlPage ?? 'n/a'}, domPage=${domPage ?? 'n/a'} (${actualUrl})`
      );
      err.isCycleFatal = true;
      throw err;
    }
    // Also warn when URL disagrees with DOM (panel URL out of sync but widget is authoritative).
    if (!urlOk && domPage === expected) {
      logger.warn(`URL and pagination widget disagree on page ${expected} (URL says ${urlPage}). Trusting widget.`);
    }
  }
}
