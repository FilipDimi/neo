/**
 * Makes a recorded SDK message stream safe to commit as a test fixture.
 *
 * A raw recording names the account, the machine's paths, the connected services and the
 * installed skills. The sanitised copy keeps the shape of every message and the model's
 * words, and replaces everything that identifies the person or the machine.
 */

export type SanitiseOptions = {
  /** The real home directory; rewritten to /Users/someone. */
  homeDir: string;
  /** Other real paths to rewrite, real path to replacement (for example a temp project folder). */
  paths?: Record<string, string>;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Real ids start with a digit after the prefix (msg_01…); names such as msg_replay_v1 do not.
const API_ID = /\b(msg|toolu|req)_[0-9][A-Za-z0-9]+/g;
const IDENTITY_KEY = /^(account.*|.*email.*|organi[sz]ation.*|org_?(id|name|uuid)|user_?id)$/i;
const INVENTORY_LISTS = new Set(['mcp_servers', 'slash_commands', 'terminal_slash_commands', 'commands', 'agents', 'skills', 'plugins', 'plugin_errors']);

export function sanitise(messages: unknown[], options: SanitiseOptions): unknown[] {
  const sessions = new Map<string, string>();
  const uuids = new Map<string, string>();
  const apiIds = new Map<string, string>();
  const apiIdCounts = new Map<string, number>();
  const paths = Object.entries({ ...options.paths, [options.homeDir]: '/Users/someone' }).sort((a, b) => b[0].length - a[0].length);

  // Session ids are numbered first, so that sess-1 is the first session of the recording.
  walk(messages, (key, value) => {
    if (key === 'session_id' && typeof value === 'string' && !sessions.has(value.toLowerCase())) {
      sessions.set(value.toLowerCase(), `sess-${sessions.size + 1}`);
    }
  });

  const cleanString = (text: string): string => {
    let out = text;
    for (const [real, replacement] of paths) out = out.split(real).join(replacement);
    out = out.replace(UUID, (id) => {
      const known = sessions.get(id.toLowerCase()) ?? uuids.get(id.toLowerCase());
      if (known) return known;
      const placeholder = `uuid-${uuids.size + 1}`;
      uuids.set(id.toLowerCase(), placeholder);
      return placeholder;
    });
    return out.replace(API_ID, (id, prefix: string) => {
      const known = apiIds.get(id);
      if (known) return known;
      const count = (apiIdCounts.get(prefix) ?? 0) + 1;
      apiIdCounts.set(prefix, count);
      apiIds.set(id, `${prefix}-${count}`);
      return `${prefix}-${count}`;
    });
  };

  const clean = (value: unknown, key?: string): unknown => {
    if (key !== undefined && IDENTITY_KEY.test(key)) return '<redacted>';
    if (key === 'signature' && typeof value === 'string') return '<signature>';
    if (typeof value === 'string') return cleanString(value);
    if (Array.isArray(value)) {
      if (key !== undefined && INVENTORY_LISTS.has(key)) return [];
      const items = key === 'tools' ? value.filter((item) => typeof item !== 'string' || !item.startsWith('mcp__')) : value;
      return items.map((item) => clean(item));
    }
    if (value !== null && typeof value === 'object') {
      if (key === 'memory_paths') return {};
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    }
    return value;
  };

  return messages.map((message) => clean(message));
}

/** What a sanitised text still gives away: each needle found (case ignored), then any UUID. */
export function leaks(text: string, needles: string[]): string[] {
  const lower = text.toLowerCase();
  const found = needles.filter((needle) => needle !== '' && lower.includes(needle.toLowerCase()));
  return [...found, ...new Set(text.match(UUID) ?? [])];
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}
