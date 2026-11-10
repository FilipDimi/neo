import { describe, expect, it } from 'vitest';
import { PRICES } from '../../src/shared/prices.ts';
import { budgetFor, costOf, isUsageLimit } from '../../src/supervisor/budget.ts';
import { task } from '../helpers.ts';

const usage = (over = {}) => ({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 500_000, costUsd: 0, ...over });

describe('budgets', () => {
  it("uses the SDK's cost when present and the price table when it is zero", () => {
    expect(costOf(usage({ costUsd: 0.42 }), 'claude-haiku-5-5')).toBe(0.42);
    const p = PRICES['claude-haiku-5-5']!;
    expect(costOf(usage(), 'claude-haiku-5-5')).toBeCloseTo(p.input + 0.1 * p.output + 2 * p.cacheRead + 0.5 * p.cacheWrite, 10);
    expect(costOf(usage(), 'a-model-nobody-priced')).toBe(0);
  });

  it('has a price for every model a company can pick', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) expect(PRICES[model], model).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  });

  it('gives a run what the task has left, and exhausted when under a cent', () => {
    expect(budgetFor(task({ capUsd: 2 }), 0.5)).toBe(1.5);
    expect(budgetFor(task({ capUsd: 2 }), 1.995)).toBe('exhausted');
    expect(budgetFor(task({ capUsd: 2 }), 3)).toBe('exhausted');
  });

  it('recognises a rejected plan window and an API rate limit, and nothing else', () => {
    expect(isUsageLimit({ kind: 'plan_usage', status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: 1794355200 })).toEqual({ until: '2026-11-11T00:00:00.000Z' });
    expect(isUsageLimit({ kind: 'plan_usage', status: 'rejected', window: null, utilization: null, resetsAt: null })).toEqual({ until: null });
    expect(isUsageLimit({ kind: 'api_error', error: 'rate_limit' })).toEqual({ until: null });
    expect(isUsageLimit({ kind: 'plan_usage', status: 'allowed_warning', window: 'seven_day', utilization: 0.9, resetsAt: 1 })).toBeNull();
    expect(isUsageLimit({ kind: 'api_error', error: 'overloaded' })).toBeNull();
    expect(isUsageLimit({ kind: 'assistant_text', text: 'rate_limit' })).toBeNull();
  });
});
