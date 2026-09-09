import type { Page } from 'playwright';
import { SELECTORS } from '../../utils/selector-repository';

export interface DepositRequestDescriptor {
  action: string;
  method: string;
  names: { payment: string; status: string; agent: string; dateFrom: string; dateTo: string };
  formEntries: Array<[string, string]>;
}

export type DepositRequestRuntimePage = Pick<Page, 'evaluate'>;
export interface BrowserRequestHeadersRuntime {
  userAgent: string;
  acceptLanguage?: string;
}
export interface DepositRequestDescriptorRequirements {
  requirePayment: boolean;
  requireAgent: boolean;
}

/** Reads transport metadata and successful controls from the one owning search form. */
export class DepositRequestRuntimeProvider {
  constructor(private readonly page: DepositRequestRuntimePage) {}

  async readDescriptor(requirements: DepositRequestDescriptorRequirements): Promise<DepositRequestDescriptor> {
    const descriptor = await this.page.evaluate(({ selectors, requirements }) => {
      const controls = {
        payment: document.querySelector(selectors.payment),
        status: document.querySelector(selectors.status),
        agent: document.querySelector(selectors.agent),
        dateFrom: document.querySelector(selectors.dateFrom),
        dateTo: document.querySelector(selectors.dateTo),
      };
      const required = [controls.status, controls.dateFrom, controls.dateTo];
      if (required.some(control => !control)) return null;
      const form = controls.status!.closest('form');
      if (!form || required.some(control => control!.closest('form') !== form)
        || (requirements.requirePayment && controls.payment?.closest('form') !== form)
        || (requirements.requireAgent && controls.agent?.closest('form') !== form)) return null;
      const name = (control: Element | null): string => control?.getAttribute('name')?.trim() || '';
      const optionalName = (control: Element | null): string =>
        control?.closest('form') === form ? name(control) : '';
      const formEntries: Array<[string, string]> = [];
      const seen = new Set<string>();
      for (const [entryName, entryValue] of new FormData(form).entries()) {
        if (typeof entryValue !== 'string' || seen.has(entryName)) return null;
        seen.add(entryName);
        formEntries.push([entryName, entryValue]);
      }
      return {
        action: form.getAttribute('action') || '',
        method: (form.getAttribute('method') || 'get').trim().toUpperCase(),
        names: {
          payment: optionalName(controls.payment), status: name(controls.status), agent: optionalName(controls.agent),
          dateFrom: name(controls.dateFrom), dateTo: name(controls.dateTo),
        },
        formEntries,
      };
    }, { requirements, selectors: {
      payment: SELECTORS.FILTER.DEPOSIT_TYPE, status: SELECTORS.FILTER.DEPOSIT_STATUS,
      agent: SELECTORS.FILTER.AGENT_INPUT, dateFrom: SELECTORS.FILTER.DATE_FROM,
      dateTo: SELECTORS.FILTER.DATE_TO,
    },
    });
    if (!descriptor) throw new DepositRequestPreparationError('REQUEST_FORM_MISSING');
    return descriptor;
  }

  /** Reads non-secret browser metadata used to make an HTTP POST look like the owning page navigation. */
  async readBrowserRequestHeaders(): Promise<BrowserRequestHeadersRuntime> {
    const runtime = await this.page.evaluate(() => {
      const userAgent = navigator.userAgent?.trim() || '';
      const languages = Array.isArray(navigator.languages)
        ? navigator.languages.map(value => value?.trim()).filter(Boolean)
        : [];
      const fallbackLanguage = navigator.language?.trim() || '';
      return { userAgent, acceptLanguage: languages.join(',') || fallbackLanguage || undefined };
    });
    if (!runtime?.userAgent) throw new DepositRequestPreparationError('REQUEST_BROWSER_METADATA_UNAVAILABLE');
    return runtime;
  }
}

export type DepositRequestPreparationErrorCode =
  | 'REQUEST_FORM_MISSING' | 'REQUEST_PARAMETER_MISSING' | 'REQUEST_METHOD_UNSUPPORTED'
  | 'REQUEST_URL_INVALID' | 'REQUEST_ORIGIN_UNSAFE' | 'REQUEST_BROWSER_METADATA_UNAVAILABLE';

export class DepositRequestPreparationError extends Error {
  constructor(public readonly code: DepositRequestPreparationErrorCode) {
    super(`FAST request preparation failed (${code})`);
    this.name = 'DepositRequestPreparationError';
    Object.setPrototypeOf(this, DepositRequestPreparationError.prototype);
  }
}
