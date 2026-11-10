import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as store from '../../src/db/store.ts';
import { checkHealth, repoProblem, type Probes } from '../../src/supervisor/health.ts';
import { scripted } from '../fixtures/scriptedLink.ts';
import { gitIn, gitRepo, plus, repo, T0, team, tempDir, world, type World } from '../helpers.ts';

const fine: Probes = {
  diskFreeGb: async () => 80,
  login: async () => ({ loggedIn: true, authMethod: 'claude.ai', expiresAt: plus(T0, 3 * 86400).toISOString() }),
  repoProblem: async () => null,
  service: async () => true,
};
const input = (probe: Partial<Probes> = {}, over = {}) => ({ repos: [repo()], minFreeGb: 5, auth: 'subscription' as const, services: [{ name: 'postgres', kind: 'tcp' as const, target: '127.0.0.1:5432' }], dataDir: '/tmp', now: T0, probe: { ...fine, ...probe }, ...over });

describe('checkHealth', () => {
  it('reports a healthy machine with no failures', async () => {
    expect(await checkHealth(input())).toMatchObject({ diskFreeGb: 80, login: 'ok', repos: [{ repoId: 'repo1', ok: true, problem: null }], services: [{ name: 'postgres', ok: true }], failures: [] });
  });

  it('reports low disk as a company-wide failure', async () => {
    const report = await checkHealth(input({ diskFreeGb: async () => 2.5 }));
    expect(report.failures).toMatchObject([{ key: 'disk', scope: 'company', text: expect.stringContaining('2.5 GB') }]);
  });

  it('reports a login that is missing, and one that is not the subscription', async () => {
    expect((await checkHealth(input({ login: async () => ({ loggedIn: false, authMethod: 'none', expiresAt: null }) }))).failures).toMatchObject([{ key: 'login', scope: 'company' }]);
    const wrong = await checkHealth(input({ login: async () => ({ loggedIn: true, authMethod: 'api_key', expiresAt: null }) }));
    expect(wrong.login).toBe('wrong_method');
    expect(wrong.failures[0]!.text).toContain('api_key');
    // A company that runs on a key accepts a key.
    expect((await checkHealth(input({ login: async () => ({ loggedIn: true, authMethod: 'api_key', expiresAt: null }) }, { auth: 'api_key' }))).failures).toEqual([]);
  });

  it('warns when the login expires within a day, without failing', async () => {
    const report = await checkHealth(input({ login: async () => ({ loggedIn: true, authMethod: 'claude.ai', expiresAt: plus(T0, 3600).toISOString() }) }));
    expect(report.login).toBe('expiring');
    expect(report.failures).toMatchObject([{ key: 'login_expiring', scope: 'warning' }]);
  });

  it('fails only the repository that has a problem', async () => {
    const report = await checkHealth(input({ repoProblem: async (path) => (path === '/bad' ? 'a merge is in progress' : null) }, { repos: [repo(), repo({ id: 'repo2', path: '/bad' })] }));
    expect(report.failures).toMatchObject([{ key: 'repo:repo2', scope: { repoId: 'repo2' }, text: expect.stringContaining('a merge is in progress') }]);
  });

  it('reports a service that does not answer', async () => {
    expect((await checkHealth(input({ service: async () => false }))).failures).toMatchObject([{ key: 'service:postgres', scope: 'company' }]);
  });
});

describe('repoProblem', () => {
  it('does not fail a repository for a dirty checkout, and fails one mid-merge or missing', async () => {
    const dir = gitRepo();
    gitIn(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(`${dir}/README.md`, 'side\n');
    gitIn(dir, 'commit', '-qam', 'side');
    gitIn(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(`${dir}/README.md`, 'main\n');
    gitIn(dir, 'commit', '-qam', 'main');
    fs.writeFileSync(`${dir}/untracked.txt`, 'dirty\n');
    expect(await repoProblem(dir)).toBeNull();
    try {
      gitIn(dir, 'merge', 'side');
    } catch {
      // The conflict is the point.
    }
    expect(await repoProblem(dir)).toMatch(/merge/);
    expect(await repoProblem(`${dir}/nope`)).toMatch(/missing/);
    expect(await repoProblem(tempDir())).toMatch(/not a git repository/);
  });
});

describe('health in the supervisor', () => {
  let open: World | undefined;
  afterEach(async () => {
    await open?.sup.stop();
    open = undefined;
  });
  const withProbes = (probes: Probes) => {
    const fake = scripted();
    const w = (open = world(fake.spawn, { repos: [repo({ path: gitRepo() })], teams: [team({ selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: null }] })], options: { probes } }));
    return { w, fake };
  };

  it('pauses the company on a company-wide failure, raises one card, and lifts both when it passes', async () => {
    let free = 1;
    const { w, fake } = withProbes({ ...fine, diskFreeGb: async () => free });
    w.sup.createTask({ teamId: 'team1', title: 'T', brief: 'B', assigneeId: 'emp1' });
    await w.sup.checkHealth();
    await w.sup.checkHealth();
    expect(store.getCompany(w.db)?.paused).toEqual({ reason: 'health', until: null });
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'health', taskId: null, subject: { key: 'disk' } }]);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(0);
    free = 50;
    await w.sup.checkHealth();
    expect(store.getCompany(w.db)?.paused).toBeNull();
    expect(store.openDecisions(w.db)).toHaveLength(0);
    await w.sup.tick();
    expect(fake.workers).toHaveLength(1);
    expect(store.getHealth(w.db)).toMatchObject({ diskFreeGb: 50, failures: [] });
  });

  it('blocks only the tasks of a repository that has a problem', async () => {
    let problem: string | null = 'a rebase is in progress';
    const { w, fake } = withProbes({ ...fine, repoProblem: async () => problem });
    w.sup.createTask({ teamId: 'team1', title: 'In the repo', brief: 'B', assigneeId: 'emp1' });
    w.sup.createTask({ teamId: 'team1', title: 'No repo', brief: 'B', assigneeId: 'emp2', repoId: null });
    await w.sup.checkHealth();
    await w.sup.tick();
    expect(fake.workers.map((worker) => worker.job.firstTurn.includes('No repo'))).toEqual([true]);
    expect(store.getCompany(w.db)?.paused).toBeNull();
    problem = null;
    await w.sup.checkHealth();
    await w.sup.tick();
    expect(fake.workers).toHaveLength(2);
  });

  it('a warning raises a card and pauses nothing', async () => {
    const { w } = withProbes({ ...fine, login: async () => ({ loggedIn: true, authMethod: 'claude.ai', expiresAt: plus(T0, 600).toISOString() }) });
    await w.sup.checkHealth();
    expect(store.getCompany(w.db)?.paused).toBeNull();
    expect(store.openDecisions(w.db)).toMatchObject([{ kind: 'health', subject: { key: 'login_expiring' } }]);
  });
});
