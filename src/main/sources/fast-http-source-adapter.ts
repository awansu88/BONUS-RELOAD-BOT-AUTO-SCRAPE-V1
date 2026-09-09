import type { APIRequestContext, APIResponse, Page } from 'playwright';
import type { RawTransaction } from '../../types/transaction';
import { FilterRequestResolver, FilterResolutionError } from './filter-request-resolver';
import { PlaywrightFilterRuntimeProvider } from './filter-runtime-provider';
import {
  DepositRequestDescriptor, DepositRequestPreparationError, DepositRequestRuntimeProvider,
} from './deposit-request-runtime-provider';
import { RawHttpHtmlParser, RawHttpResponseClassification as Classification } from './raw-http-html-parser';
import type { PageStats, ScanTerminationReason, SourceAdapter, SourceScanRequest, SourceScanResult } from './source-adapter';
import { getLogger } from '../services/logger-service';

type FastHttpResponse = Pick<APIResponse, 'status' | 'url' | 'text'> & { headers?: () => Record<string, string> };
export interface FastHttpRequestContext {
  get(url: string): Promise<FastHttpResponse>;
  post(url: string, options: { form: Record<string, string>; headers: Record<string, string> }): Promise<FastHttpResponse>;
}
export interface FastHttpSessionOwner {
  getPage(): Page | null;
  getRequestContext(): APIRequestContext | FastHttpRequestContext | null;
}
export interface FastHttpAdapterOptions { now?: () => Date; }

export class FastHttpSourceError extends Error {
  constructor(public readonly code: string) {
    super(`FAST HTTP source failed (${code})`);
    this.name = 'FastHttpSourceError';
    Object.setPrototypeOf(this, FastHttpSourceError.prototype);
  }
}

export class FastWorkerBusyError extends FastHttpSourceError {
  constructor() {
    super('FAST_WORKER_BUSY');
    this.name = 'FastWorkerBusyError';
    Object.setPrototypeOf(this, FastWorkerBusyError.prototype);
  }
}

const PROFILE_CODES = new Set([
  'PROFILE_PAYMENT_CONFLICT', 'PAYMENT_UNAVAILABLE', 'PAYMENT_AMBIGUOUS',
  'AGENT_UNAVAILABLE', 'AGENT_AMBIGUOUS', 'AGENT_CONTROL_UNSUPPORTED',
]);
const LOGIN_PATH = /\/(login|signin|log-in|sign-in|auth|session|users\/sign_in)(\/|$)/i;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const AUTH_QUERY = /^(?:_?token|csrf|xsrf|authorization)$/i;
const TRUSTED_DEPOSIT_PATH = /^\/deposit\/transactions\/?$/;
const NAVIGATION_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

/** Dormant Phase 6 authenticated GET transport; production still defaults to Legacy. */
export class FastHttpSourceAdapter implements SourceAdapter {
  private active = false;
  private readonly resolver = new FilterRequestResolver();
  private readonly parser = new RawHttpHtmlParser();

  constructor(private readonly session: FastHttpSessionOwner, private readonly options: FastHttpAdapterOptions = {}) {}

  async scan(request: SourceScanRequest): Promise<SourceScanResult> {
    if (this.active) throw new FastWorkerBusyError();
    this.active = true;
    try { return await this.scanExclusive(request); }
    finally { this.active = false; }
  }

  private async scanExclusive(request: SourceScanRequest): Promise<SourceScanResult> {
    const page = this.session.getPage();
    if (!page) throw new FastHttpSourceError('BROWSER_PAGE_UNAVAILABLE');
    const http = this.session.getRequestContext() as FastHttpRequestContext | null;
    if (!http) throw new FastHttpSourceError('REQUEST_CONTEXT_UNAVAILABLE');
    const browserUrl = this.safeBrowserUrl(page.url());

    let resolved;
    try {
      const snapshot = await new PlaywrightFilterRuntimeProvider(page).readSnapshot();
      resolved = this.resolver.resolve(request.filter, snapshot, {
        manualDateMode: request.manualDateMode, now: this.options.now?.(),
      });
    } catch (error) {
      const profileSpecificUnavailable = error instanceof FilterResolutionError && (
        PROFILE_CODES.has(error.code)
        || (error.code === 'RUNTIME_CONTROL_UNAVAILABLE'
          && (error.field === 'payment' || error.field === 'agent'))
      );
      if (profileSpecificUnavailable) {
        (error as FilterResolutionError & { isProfileUnavailable: boolean }).isProfileUnavailable = true;
      }
      throw error;
    }

    const runtimeProvider = new DepositRequestRuntimeProvider(page);
    const descriptor = await runtimeProvider.readDescriptor({
      requirePayment: resolved.payment !== undefined,
      requireAgent: resolved.agent !== undefined,
    });
    const firstRequest = this.prepareFirstRequest(browserUrl, descriptor, resolved);
    const postHeaders = firstRequest.method === 'POST'
      ? this.preparePostHeaders(browserUrl, firstRequest.url, await runtimeProvider.readBrowserRequestHeaders())
      : undefined;
    request.onScanStart?.();

    const transactions: RawTransaction[] = [];
    const perPage: PageStats[] = [];
    let pageNumber = 1;
    let nextUrl = firstRequest.url;
    const result = (reason: ScanTerminationReason, failure = false): SourceScanResult => ({
      transactions, perPage, navigationFailure: failure, terminationReason: reason,
      lastPageScanned: perPage.length ? perPage[perPage.length - 1].pageNumber : 0,
      configuredMaxPage: request.maxPages,
    });

    if (request.maxPages <= 0) return result('MAX_SCAN_REACHED');
    while (true) {
      if (request.shouldStop()) return result('STOP_REQUESTED');
      let response: FastHttpResponse;
      try {
        response = pageNumber === 1 && firstRequest.method === 'POST'
          ? await http.post(nextUrl.toString(), { form: firstRequest.form!, headers: postHeaders! })
          : await http.get(nextUrl.toString());
      }
      catch { return result('HTTP_FAILURE', true); }

      const status = response.status();
      if (status === 401) return result('SESSION_EXPIRED', true);
      if (status === 403 || status < 200 || status >= 300) return result('HTTP_FAILURE', true);

      let finalUrl: URL;
      try { finalUrl = new URL(response.url()); }
      catch { return result('UNSAFE_RESPONSE', true); }
      if (LOGIN_PATH.test(finalUrl.pathname)) return result('SESSION_EXPIRED', true);
      if (!HTTP_PROTOCOLS.has(finalUrl.protocol) || finalUrl.origin !== browserUrl.origin)
        return result('UNSAFE_RESPONSE', true);

      let parsed;
      try { parsed = this.parser.parse(await response.text(), { expectedPageNumber: pageNumber }); }
      catch { return result('UNSAFE_RESPONSE', true); }
      if (pageNumber === 1 && firstRequest.method === 'POST') this.logFirstPostResponse(response, finalUrl, parsed);
      if (parsed.classification === Classification.LOGIN_PAGE) return result('SESSION_EXPIRED', true);
      if (parsed.classification !== Classification.DEPOSIT_TABLE
        && parsed.classification !== Classification.EMPTY_DEPOSIT_TABLE) return result('UNSAFE_RESPONSE', true);

      let duplicate = 0;
      if (!request.initialSyncMode) {
        for (const transaction of parsed.transactions) if (request.duplicateCheck(transaction)) duplicate++;
      }
      transactions.push(...parsed.transactions);
      const stats: PageStats = { pageNumber, rowsDetected: parsed.rowsDetected, rowsParsed: parsed.transactions.length,
        rowsRejected: parsed.rejections.length, duplicate, buffered: 0, exported: 0 };
      perPage.push(stats);
      await request.onPage?.({ pageNumber, transactions: parsed.transactions, stats });

      if (!request.initialSyncMode && parsed.transactions.length > 0 && duplicate === parsed.transactions.length)
        return result('FULL_DUPLICATE_PAGE');
      if (request.shouldStop()) return result('STOP_REQUESTED');
      if (pageNumber >= request.maxPages) return result('MAX_SCAN_REACHED');
      if (!parsed.pagination.valid) return result('UNSAFE_RESPONSE', true);
      if (!parsed.pagination.hasNext) return result('END_OF_PAGINATION');
      if (parsed.pagination.nextPageNumber !== pageNumber + 1 || !parsed.pagination.nextHref?.trim())
        return result('UNSAFE_RESPONSE', true);
      let candidate: URL;
      try { candidate = new URL(parsed.pagination.nextHref, finalUrl); }
      catch { return result('UNSAFE_RESPONSE', true); }
      if (!HTTP_PROTOCOLS.has(candidate.protocol) || candidate.origin !== browserUrl.origin)
        return result('UNSAFE_RESPONSE', true);
      nextUrl = candidate;
      pageNumber++;
    }
  }

  private preparePostHeaders(browserUrl: URL, target: URL,
    runtime: { userAgent: string; acceptLanguage?: string }): Record<string, string> {
    if (!runtime.userAgent.trim())
      throw new DepositRequestPreparationError('REQUEST_BROWSER_METADATA_UNAVAILABLE');
    if (target.origin !== browserUrl.origin || !TRUSTED_DEPOSIT_PATH.test(target.pathname))
      throw new DepositRequestPreparationError('REQUEST_ORIGIN_UNSAFE');
    const headers: Record<string, string> = {
      Accept: NAVIGATION_ACCEPT,
      Origin: browserUrl.origin,
      Referer: `${browserUrl.origin}/deposit/transactions`,
      'User-Agent': runtime.userAgent,
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
    };
    if (runtime.acceptLanguage) headers['Accept-Language'] = runtime.acceptLanguage;
    return headers;
  }

  private logFirstPostResponse(response: FastHttpResponse, finalUrl: URL,
    parsed: ReturnType<RawHttpHtmlParser['parse']>): void {
    let contentType = '';
    try { contentType = response.headers?.()['content-type'] || ''; } catch { /* diagnostic metadata is optional */ }
    try {
      getLogger().diag(`FAST first response method=POST status=${response.status()} finalPath=${finalUrl.pathname}`
        + ` contentType=${contentType} classification=${parsed.classification} headerCount=${parsed.layout.headerCount}`
        + ` rowsDetected=${parsed.rowsDetected} recognizedLayout=${parsed.layout.recognized}`);
    } catch { /* logger may not be initialized in isolated adapter tests */ }
  }

  private safeBrowserUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new DepositRequestPreparationError('REQUEST_URL_INVALID'); }
    if (!HTTP_PROTOCOLS.has(url.protocol)) throw new DepositRequestPreparationError('REQUEST_URL_INVALID');
    return url;
  }

  private prepareFirstRequest(browserUrl: URL, descriptor: DepositRequestDescriptor,
    resolved: ReturnType<FilterRequestResolver['resolve']>): { method: 'GET' | 'POST'; url: URL; form?: Record<string, string> } {
    const formMethod = descriptor.method.trim().toUpperCase();
    if (formMethod !== 'GET' && formMethod !== 'POST')
      throw new DepositRequestPreparationError('REQUEST_METHOD_UNSUPPORTED');
    let target: URL;
    if (!descriptor.action.trim()) {
      if (!/^\/deposit\/transactions\/?$/i.test(browserUrl.pathname))
        throw new DepositRequestPreparationError('REQUEST_URL_INVALID');
      target = new URL(browserUrl.origin + browserUrl.pathname);
    } else {
      try { target = new URL(descriptor.action, browserUrl); }
      catch { throw new DepositRequestPreparationError('REQUEST_URL_INVALID'); }
    }
    if (!HTTP_PROTOCOLS.has(target.protocol) || target.origin !== browserUrl.origin)
      throw new DepositRequestPreparationError('REQUEST_ORIGIN_UNSAFE');
    if (formMethod === 'POST' && !TRUSTED_DEPOSIT_PATH.test(target.pathname))
      throw new DepositRequestPreparationError('REQUEST_URL_INVALID');
    const required = [descriptor.names.status, descriptor.names.dateFrom, descriptor.names.dateTo];
    if (required.some(name => !name)) throw new DepositRequestPreparationError('REQUEST_PARAMETER_MISSING');
    const values = formMethod === 'POST' ? Object.fromEntries(descriptor.formEntries) : target.searchParams;
    const set = (name: string, value: string): void => formMethod === 'POST'
      ? void ((values as Record<string, string>)[name] = value)
      : (values as URLSearchParams).set(name, value);
    set(descriptor.names.status, resolved.status.value);
    set(descriptor.names.dateFrom, resolved.dateFrom);
    set(descriptor.names.dateTo, resolved.dateTo);
    if (resolved.payment) {
      if (!descriptor.names.payment) throw new DepositRequestPreparationError('REQUEST_PARAMETER_MISSING');
      set(descriptor.names.payment, resolved.payment.value);
    }
    if (resolved.agent) {
      if (!descriptor.names.agent) throw new DepositRequestPreparationError('REQUEST_PARAMETER_MISSING');
      set(descriptor.names.agent, resolved.agent.value);
    }
    if (formMethod === 'GET') {
      for (const key of [...target.searchParams.keys()]) if (AUTH_QUERY.test(key)) target.searchParams.delete(key);
      if (target.searchParams.has('page')) target.searchParams.set('page', '1');
      return { method: 'GET', url: target };
    }
    return { method: 'POST', url: target, form: values as Record<string, string> };
  }
}
