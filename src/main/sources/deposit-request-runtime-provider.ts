import type { Page } from 'playwright';
import { SELECTORS } from '../../utils/selector-repository';

export interface DepositRequestDescriptor {
  action: string;
  method: string;
  names: { payment: string; status: string; agent: string; dateFrom: string; dateTo: string };
}

export type DepositRequestRuntimePage = Pick<Page, 'evaluate'>;
export interface DepositRequestDescriptorRequirements {
  requirePayment: boolean;
  requireAgent: boolean;
}

/** Reads transport metadata from the base form and only the requested optional controls. */
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
      return {
        action: form.getAttribute('action') || '',
        method: (form.getAttribute('method') || 'get').trim().toUpperCase(),
        names: {
          payment: optionalName(controls.payment), status: name(controls.status), agent: optionalName(controls.agent),
          dateFrom: name(controls.dateFrom), dateTo: name(controls.dateTo),
        },
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
}

export type DepositRequestPreparationErrorCode =
  | 'REQUEST_FORM_MISSING' | 'REQUEST_PARAMETER_MISSING' | 'REQUEST_METHOD_UNSUPPORTED'
  | 'REQUEST_URL_INVALID' | 'REQUEST_ORIGIN_UNSAFE';

export class DepositRequestPreparationError extends Error {
  constructor(public readonly code: DepositRequestPreparationErrorCode) {
    super(`FAST request preparation failed (${code})`);
    this.name = 'DepositRequestPreparationError';
    Object.setPrototypeOf(this, DepositRequestPreparationError.prototype);
  }
}
