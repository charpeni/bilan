import type { Tooltip } from './tooltip.ts';
import type { FilterState, MetricPr, Payload } from '@bilan/core';

/** Everything a render pass needs: the data, the derived PRs, and the UI handles. */
export interface DashboardContext {
  root: HTMLElement;
  data: Payload;
  prs: MetricPr[];
  bots: Set<string>;
  last: number;
  state: FilterState;
  tip: Tooltip;
}
