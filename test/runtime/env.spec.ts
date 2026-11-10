import { describe, expect, it } from 'vitest';
import { subscriptionEnv } from '../../src/runtime/env.ts';

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
