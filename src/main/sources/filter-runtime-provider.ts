import { Page } from 'playwright';
import { SELECTORS } from '../../utils/selector-repository';
import { FilterControl, FilterRuntimeSnapshot, RuntimeDateValue } from './filter-request-resolver';

/** A deliberately read-only view of the Playwright operations used here. */
export type FilterRuntimePage = Pick<Page, 'evaluate'>;

export interface FilterRuntimeProvider {
  readSnapshot(): Promise<FilterRuntimeSnapshot>;
}

export class PlaywrightFilterRuntimeProvider implements FilterRuntimeProvider {
  constructor(private readonly page: FilterRuntimePage) {}

  async readSnapshot(): Promise<FilterRuntimeSnapshot> {
    try {
      return await this.page.evaluate((selectors): FilterRuntimeSnapshot => {
      const readControl = (selector: string): FilterControl => {
        const element = document.querySelector(selector);
        if (!element) return { kind: 'UNAVAILABLE' };
        if (element.tagName.toUpperCase() === 'SELECT') {
          const select = element as HTMLSelectElement;
          return {
            kind: 'SELECT' as const,
            options: Array.from(select.options).map(option => ({
              value: String(option.value || '').trim(),
              label: String(option.textContent || '').trim(),
            })),
          };
        }
        if (element.tagName.toUpperCase() === 'TEXTAREA') {
          return { kind: 'FREE_TEXT' as const };
        }
        if (element.tagName.toUpperCase() === 'INPUT') {
          const inputType = (element.getAttribute('type') || 'text').trim().toLowerCase();
          return inputType === 'text' || inputType === 'search'
            ? { kind: 'FREE_TEXT' as const }
            : { kind: 'UNAVAILABLE' as const };
        }
        return { kind: 'UNAVAILABLE' as const };
      };
      const readDate = (selector: string): RuntimeDateValue => {
        const element = document.querySelector(selector);
        const tagName = element?.tagName.toUpperCase();
        if (!element || !['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName || '') || !('value' in element)) {
          return { available: false, value: '' };
        }
        return { available: true, value: String((element as HTMLInputElement).value) };
      };
      return {
        payment: readControl(selectors.payment),
        status: readControl(selectors.status),
        agent: readControl(selectors.agent),
        dateFrom: readDate(selectors.dateFrom),
        dateTo: readDate(selectors.dateTo),
      };
    }, {
      payment: SELECTORS.FILTER.DEPOSIT_TYPE,
      status: SELECTORS.FILTER.DEPOSIT_STATUS,
      agent: SELECTORS.FILTER.AGENT_INPUT,
      dateFrom: SELECTORS.FILTER.DATE_FROM,
      dateTo: SELECTORS.FILTER.DATE_TO,
      });
    } catch {
      return {
        payment: { kind: 'UNAVAILABLE' },
        status: { kind: 'UNAVAILABLE' },
        agent: { kind: 'UNAVAILABLE' },
        dateFrom: { available: false, value: '' },
        dateTo: { available: false, value: '' },
      };
    }
  }
}
