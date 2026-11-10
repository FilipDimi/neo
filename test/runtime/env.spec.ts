import { describe, expect, it } from 'vitest';
import { plainEnv, subscriptionEnv, withToolchains } from '../../src/runtime/env.ts';
import { sessionEnv } from '../../src/supervisor/jobs.ts';

describe('what a session or a gate inherits', () => {
  it('lets through what a build needs, and no secret the engine happened to be started with', () => {
    const kept = { PATH: '/bin', HOME: '/Users/x', USER: 'x', SHELL: '/bin/zsh', LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', TMPDIR: '/tmp/x', TZ: 'Europe/Skopje', CARGO_HOME: '/Users/x/.cargo', DEVELOPER_DIR: '/Applications/Xcode.app', HTTPS_PROXY: 'http://proxy:8080', https_proxy: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' };
    const secrets = { AWS_SECRET_ACCESS_KEY: 's', AWS_ACCESS_KEY_ID: 'a', GITHUB_TOKEN: 'g', GH_TOKEN: 'g', NPM_TOKEN: 'n', DATABASE_URL: 'postgres://u:p@h/db', OPENAI_API_KEY: 'o', SSH_AUTH_SOCK: '/tmp/agent.sock', MY_APP_SECRET: 'm', SENTRY_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' };
    expect(plainEnv({ ...kept, ...secrets })).toEqual(kept);
    expect(subscriptionEnv({ ...kept, ...secrets }).env).toEqual(kept);
  });

  it('passes on where the proxy is, without the user name and password in its address', () => {
    const env = plainEnv({ HTTPS_PROXY: 'http://filip:hunter2@proxy.example:8080', http_proxy: 'http://filip:hunter2@proxy.example:8080/', ALL_PROXY: 'socks5://u:hunter2@10.0.0.1:1080', HTTP_PROXY: 'filip:hunter2@proxy.example:8080', NO_PROXY: 'localhost,127.0.0.1' });
    expect(env).toEqual({ HTTPS_PROXY: 'http://proxy.example:8080', http_proxy: 'http://proxy.example:8080/', ALL_PROXY: 'socks5://10.0.0.1:1080', HTTP_PROXY: 'proxy.example:8080', NO_PROXY: 'localhost,127.0.0.1' });
    expect(JSON.stringify(env)).not.toContain('hunter2');
    // A password may itself have an @ in it: the host is what follows the last one.
    expect(plainEnv({ HTTPS_PROXY: 'http://filip:p@ssw0rd@proxy.example:8080/path' }).HTTPS_PROXY).toBe('http://proxy.example:8080/path');
    expect(plainEnv({ HTTPS_PROXY: 'http://proxy.example:8080/a@b' }).HTTPS_PROXY).toBe('http://proxy.example:8080/a@b');
  });

  it('adds the usual toolchain folders to the path when they are on this machine, after what was already on it', () => {
    const there = new Set(['/Users/x/.cargo/bin', '/opt/homebrew/bin', '/opt/homebrew/opt/rustup/bin']);
    const exists = (dir: string) => there.has(dir);
    expect(withToolchains({ PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/Users/x' }, exists).PATH).toBe('/usr/bin:/opt/homebrew/bin:/Users/x/.cargo/bin:/opt/homebrew/opt/rustup/bin');
    expect(withToolchains({ PATH: '/usr/bin', HOME: '/Users/x' }, () => false)).toEqual({ PATH: '/usr/bin', HOME: '/Users/x' });
    expect(withToolchains({ HOME: '/Users/x' }, exists).PATH).toBe('/Users/x/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin');
  });

  it('gives a company on an API key that key and nothing else new', () => {
    const parent = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example', GITHUB_TOKEN: 'g' };
    expect(sessionEnv({ auth: 'api_key' }, parent)).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' });
    expect(sessionEnv({ auth: 'subscription' }, parent)).toEqual({ PATH: '/bin' });
  });
});

describe('subscriptionEnv', () => {
  it('removes the API key and the auth token', () => {
    const { env } = subscriptionEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('removes cloud-provider switches, endpoints and credentials', () => {
    const { env } = subscriptionEnv({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_VERTEX_PROJECT_ID: 'p',
      ANTHROPIC_FOUNDRY_API_KEY: 'f',
      AWS_BEARER_TOKEN_BEDROCK: 'b',
      CLOUD_ML_REGION: 'us-east5',
      HOME: '/Users/x',
    });
    expect(env).toEqual({ HOME: '/Users/x' });
  });

  it('removes the variables a host Claude Code session leaves behind', () => {
    const { env } = subscriptionEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_AGENT_SDK_VERSION: '0.3.317',
      USER: 'x',
    });
    expect(env).toEqual({ USER: 'x' });
  });

  it('removes the other marks of a host session: its effort, its pid, the agent flag', () => {
    const { env } = subscriptionEnv({ CLAUDE_EFFORT: 'high', CLAUDE_PID: '42', CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1', AI_AGENT: 'claude-code', TERM: 'xterm' });
    expect(env).toEqual({ TERM: 'xterm' });
  });

  it('keeps the config directory override, which says where the login lives', () => {
    const { env } = subscriptionEnv({ CLAUDE_CONFIG_DIR: '/custom/.claude' });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/custom/.claude' });
  });

  it('reports the names it removed, sorted, and never the values', () => {
    const { removed } = subscriptionEnv({ PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'secret' });
    expect(removed).toEqual(['ANTHROPIC_API_KEY', 'CLAUDECODE']);
  });

  it('drops variables whose value is undefined', () => {
    const { env } = subscriptionEnv({ PATH: '/bin', EMPTY: undefined });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
