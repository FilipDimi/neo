/**
 * The environment a session or a gate gets: a short list of names, and nothing else.
 *
 * Two reasons. Claude Code prefers an API key, an auth token or a cloud provider over the stored
 * login whenever one of their variables is set, and it does so silently; so on the claude.ai
 * login the child never sees them. And whatever shell the engine was started from may hold
 * tokens for other things (a cloud account, a registry, a database): an employee's command
 * prints its environment as easily as anything else, so none of those are passed on either.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where things are and how to talk: never a credential. */
const KEPT_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'TMPDIR', 'TZ', 'LANG', 'LANGUAGE', '__CF_USER_TEXT_ENCODING',
  // Where the login lives, when it is not in the usual place.
  'CLAUDE_CONFIG_DIR',
  // How to reach the network from here, and which certificates to trust.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Where toolchains are installed.
  'DEVELOPER_DIR', 'SDKROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'GOPATH', 'GOROOT', 'JAVA_HOME', 'ANDROID_HOME', 'NVM_DIR', 'PNPM_HOME', 'BUN_INSTALL', 'PYENV_ROOT', 'VOLTA_HOME',
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);
const KEPT_PREFIXES = ['LC_'];

const isKept = (name: string): boolean => KEPT_NAMES.has(name) || KEPT_PREFIXES.some((prefix) => name.startsWith(prefix));

/** A proxy's address without the user name and password some setups write into it: where the proxy is can be known, its password cannot. */
const PROXIES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']);
const withoutLogin = (address: string): string => address.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?[^/@]*@/, '$1');

/** The parent's environment, cut down to the names above. */
export function plainEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const kept = Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined && isKept(entry[0]));
  return Object.fromEntries(kept.map(([name, value]) => [name, PROXIES.has(name) ? withoutLogin(value) : value]));
}

/**
 * The same environment with the usual toolchain folders on its path, where this machine has them.
 * The engine is often started from somewhere with a short path (a launcher, a service), and an
 * employee's `cargo` or `brew`-installed tool is then simply not found. They go after what was
 * already on the path, so nothing the user ordered is overridden.
 */
export function withToolchains(env: Record<string, string>, exists: (dir: string) => boolean = fs.existsSync): Record<string, string> {
  const home = env.HOME ?? os.homedir();
  const have = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const more = [path.join(home, '.cargo/bin'), '/opt/homebrew/opt/rustup/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'].filter((dir) => !have.includes(dir) && exists(dir));
  return more.length === 0 ? env : { ...env, PATH: [...have, ...more].join(path.delimiter) };
}

/** The same, with the names that were left out (never their values), for a log or a check. */
export function subscriptionEnv(parent: Record<string, string | undefined>): { env: Record<string, string>; removed: string[] } {
  const env = plainEnv(parent);
  const removed = Object.keys(parent).filter((name) => parent[name] !== undefined && !(name in env));
  return { env, removed: removed.sort() };
}
