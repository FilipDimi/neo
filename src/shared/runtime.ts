/**
 * What a session tells the engine, in the engine's own words.
 * Shared with the web app, so nothing here may import Node or the SDK.
 */
export type RuntimeEvent =
  | { kind: 'session_started'; sessionId: string; model: string; loginSource: string; tools: string[] }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_call'; id: string; tool: string; input: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean }
  /** One per finished turn: that turn's own tokens and cost, and the session's running cost (it carries over a resume). */
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; sessionCostUsd: number }
  /**
   * What one answer of the model has used, sent as it arrives. It is not the account: a turn that
   * finishes reports its own `usage`. It exists so that a turn the engine cuts short is still paid for.
   */
  | { kind: 'usage_so_far'; messageId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { kind: 'turn_finished'; sessionId: string; ok: boolean; reason: string; turns: number; denials: string[] }
  /** The subscription's own limit: sent on every session, and with status "rejected" at the limit. */
  | { kind: 'plan_usage'; status: string; window: string | null; utilization: number | null; resetsAt: number | null }
  | { kind: 'api_error'; error: string }
  | { kind: 'finished'; sessionId: string | null; ok: boolean; reason?: string };

export type ToolCall = { id: string; tool: string; input: unknown };
export type ToolDecision = { allow: boolean; reason?: string };
