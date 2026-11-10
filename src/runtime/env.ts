/**
 * The environment a session gets when the company runs on the claude.ai login.
 *
 * Claude Code prefers an API key, an auth token or a cloud provider over the stored login
 * whenever one of their variables is set, and it does so silently. So in subscription mode
 * the child never sees them. Variables left behind by a host Claude Code session go too,
 * so that a session started from inside one behaves like one started from a terminal.
 */

const REMOVED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];
const REMOVED_NAMES = new Set(['CLAUDECODE', 'AI_AGENT', 'AWS_BEARER_TOKEN_BEDROCK', 'CLOUD_ML_REGION']);
const KEPT_NAMES = new Set(['CLAUDE_CONFIG_DIR']);

function isRemoved(name: string): boolean {
  if (KEPT_NAMES.has(name)) return false;
  return REMOVED_NAMES.has(name) || REMOVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function subscriptionEnv(parent: Record<string, string | undefined>): {
  env: Record<string, string>;
  removed: string[];
} {
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isRemoved(name)) removed.push(name);
    else env[name] = value;
  }
  return { env, removed: removed.sort() };
}
