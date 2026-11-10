/**
 * Budgets. A task's cap covers all of its runs; each run starts with what the task has left as
 * its own limit, which the SDK enforces. Reaching the subscription's usage limit is not a task
 * failure: it pauses the whole company.
 */
import { PRICES } from '../shared/prices.ts';
import type { RuntimeEvent } from '../shared/runtime.ts';
import type { Task } from '../shared/types.ts';

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };

/** What a turn cost: the SDK's own figure when it gives one, else tokens at list prices. */
export function costOf(usage: Usage, model: string): number {
  if (usage.costUsd > 0) return usage.costUsd;
  const price = PRICES[model];
  if (!price) return 0;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}

/** The limit for the next run of a task: what the task has left. Under a cent, there is nothing to run on. */
export function budgetFor(task: Pick<Task, 'capUsd'>, spentUsd: number): number | 'exhausted' {
  const left = Math.round((task.capUsd - spentUsd) * 10_000) / 10_000;
  return left < 0.01 ? 'exhausted' : left;
}

/** Whether an event says the plan's own limit was reached, and when it resets if the event says. */
export function isUsageLimit(event: RuntimeEvent): { until: string | null } | null {
  if (event.kind === 'plan_usage' && event.status === 'rejected') return { until: event.resetsAt === null ? null : new Date(event.resetsAt * 1000).toISOString() };
  if (event.kind === 'api_error' && event.error === 'rate_limit') return { until: null };
  return null;
}
