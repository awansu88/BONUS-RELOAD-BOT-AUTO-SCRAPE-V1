import { Page } from 'playwright';
import { SELECTORS } from '../../utils/selector-repository';
import { FilterControl, FilterRuntimeSnapshot, RuntimeDateValue } from './filter-request-resolver';

/** A deliberately read-only view of the Playwright operations used here. */
export type FilterRuntimePage = Pick<Page, '$eval' | 'inputValue'>;

export interface FilterRuntimeProvider {
  readSnapshot(): Promise<FilterRuntimeSnapshot>;
}

export class PlaywrightFilterRuntimeProvider implements FilterRuntimeProvider {
  constructor(private readonly page: FilterRuntimePage) {}

  async readSnapshot(): Promise<FilterRuntimeSnapshot> {
    const [payment, status, agent, dateFrom, dateTo] = await Promise.all([
      this.readControl(SELECTORS.FILTER.DEPOSIT_TYPE),
      this.readControl(SELECTORS.FILTER.DEPOSIT_STATUS),
      this.readControl(SELECTORS.FILTER.AGENT_INPUT),
      this.readDate(SELECTORS.FILTER.DATE_FROM),
      this.readDate(SELECTORS.FILTER.DATE_TO),
    ]);
    return { payment, status, agent, dateFrom, dateTo };
  }

  private async readControl(selector: string): Promise<FilterControl> {
    try {
      return await this.page.$eval(selector, element => {
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
        if (element.tagName.toUpperCase() === 'INPUT' || element.tagName.toUpperCase() === 'TEXTAREA') {
          return { kind: 'FREE_TEXT' as const };
        }
        return { kind: 'UNAVAILABLE' as const };
      });
    } catch {
      return { kind: 'UNAVAILABLE' };
    }
  }

  private async readDate(selector: string): Promise<RuntimeDateValue> {
    try {
      return { available: true, value: await this.page.inputValue(selector) };
    } catch {
      return { available: false, value: '' };
    }
  }
}
