import { describe, expect, it } from 'vitest';
import { leaks, sanitise } from '../../src/runtime/sanitise.ts';

const S1 = '7f3c1d2e-aaaa-4bbb-8ccc-000000000001';
const S2 = '7f3c1d2e-aaaa-4bbb-8ccc-000000000002';
const U1 = '11111111-2222-4333-8444-555555555555';
const opts = { homeDir: '/Users/filip', paths: { '/private/tmp/spike-abc': '/tmp/project' } };

describe('sanitise', () => {
  it('replaces session ids with sess-N in order of first appearance, wherever they occur', () => {
    const out = sanitise(
      [
        { type: 'system', session_id: S1 },
        { type: 'result', session_id: S1, note: `resumed from ${S1}` },
        { type: 'system', session_id: S2 },
      ],
      opts,
    );
    expect(out).toEqual([
      { type: 'system', session_id: 'sess-1' },
      { type: 'result', session_id: 'sess-1', note: 'resumed from sess-1' },
      { type: 'system', session_id: 'sess-2' },
    ]);
  });

  it('replaces every other UUID with uuid-N, one placeholder per distinct value', () => {
    const out = sanitise([{ uuid: U1 }, { parent: U1, uuid: S2 }], opts);
    expect(out).toEqual([{ uuid: 'uuid-1' }, { parent: 'uuid-1', uuid: 'uuid-2' }]);
  });

  it('replaces message, tool-use and request ids', () => {
    const out = sanitise(
      [{ message: { id: 'msg_01AbCdEf' }, tool_use_id: 'toolu_01XyZ', request_id: 'req_011CabcDEF' }, { ref: 'toolu_01XyZ' }],
      opts,
    );
    expect(out).toEqual([{ message: { id: 'msg-1' }, tool_use_id: 'toolu-1', request_id: 'req-1' }, { ref: 'toolu-1' }]);
  });

  it('leaves a name that merely starts like an API id alone', () => {
    const out = sanitise([{ capabilities: ['msg_replay_v1', 'req_marker'] }], opts);
    expect(out).toEqual([{ capabilities: ['msg_replay_v1', 'req_marker'] }]);
  });

  it('rewrites the home directory and the named paths inside any string', () => {
    const out = sanitise([{ cwd: '/private/tmp/spike-abc', text: 'wrote /Users/filip/.claude/x and /private/tmp/spike-abc/a.txt' }], opts);
    expect(out).toEqual([{ cwd: '/tmp/project', text: 'wrote /Users/someone/.claude/x and /tmp/project/a.txt' }]);
  });

  it('redacts identity fields by key name, at any depth', () => {
    const out = sanitise([{ account: { email: 'a@b.c', organization: 'Acme', accountUuid: U1 }, user_id: 'u', orgName: 'Acme' }], opts);
    expect(out).toEqual([{ account: '<redacted>', user_id: '<redacted>', orgName: '<redacted>' }]);
  });

  it('empties the machine inventory and drops connector tools from the init message', () => {
    const out = sanitise(
      [
        {
          type: 'system',
          subtype: 'init',
          tools: ['Read', 'mcp__gmail__send', 'Bash'],
          mcp_servers: [{ name: 'gmail', status: 'connected' }],
          slash_commands: ['deploy'],
          agents: ['neo'],
          skills: ['dataviz'],
          plugins: [{ name: 'p', path: '/x' }],
          memory_paths: { auto: '/Users/filip/.claude/memory' },
          model: 'claude-haiku-5-5',
        },
      ],
      opts,
    );
    expect(out).toEqual([
      { type: 'system', subtype: 'init', tools: ['Read', 'Bash'], mcp_servers: [], slash_commands: [], agents: [], skills: [], plugins: [], memory_paths: {}, model: 'claude-haiku-5-5' },
    ]);
  });

  it('empties the command list of a commands_changed message', () => {
    const out = sanitise([{ type: 'system', subtype: 'commands_changed', commands: [{ name: 'deploy', description: 'Ship it' }] }], opts);
    expect(out).toEqual([{ type: 'system', subtype: 'commands_changed', commands: [] }]);
  });

  it('replaces thinking signatures, which are long opaque blobs', () => {
    const out = sanitise([{ content: [{ type: 'thinking', thinking: '', signature: 'EuYBCkYIBh…' }] }], opts);
    expect(out).toEqual([{ content: [{ type: 'thinking', thinking: '', signature: '<signature>' }] }]);
  });

  it('does not mutate its input', () => {
    const input = [{ session_id: S1, cwd: '/Users/filip' }];
    sanitise(input, opts);
    expect(input).toEqual([{ session_id: S1, cwd: '/Users/filip' }]);
  });
});

describe('leaks', () => {
  it('returns nothing for clean text', () => {
    expect(leaks('{"session_id":"sess-1","cwd":"/tmp/project"}', ['filip', 'a@b.c'])).toEqual([]);
  });

  it('reports each needle still present, ignoring case, and any surviving UUID', () => {
    expect(leaks(`{"cwd":"/Users/Filip","id":"${U1}"}`, ['filip', 'a@b.c'])).toEqual(['filip', U1]);
  });
});
