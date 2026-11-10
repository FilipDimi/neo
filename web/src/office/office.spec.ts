import { describe, expect, it } from 'vitest';
import { company, decision, employee, plus, run, T0, task, team } from '../../../test/rows.ts';
import { storyAt, storyEvents, storySnapshot, taskTitled } from '../fixtures/story.ts';
import { board } from '../model/select.ts';
import { fromSnapshot, reduce, type Snapshot, type Store } from '../store/reduce.ts';
import { FLOOR, rugs, seats, type Rect } from './layout.ts';
import { placement } from './placement.ts';
import { officeScene, type SceneNode } from './scene.ts';

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ version: 1, company: company(), repos: [], teams: [team()], employees: [employee()], tasks: [], runs: [], requests: [], decisions: [], messages: [], health: null, planUsage: null, spend: { company: 0, byTeam: {}, byEmployee: {} }, lastEventId: 1, now: T0.toISOString(), ...over });
const liveRun = (over = {}) => run({ leaseUntil: plus(T0, 900).toISOString(), ...over });
const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w + 0.01 && inner.y + inner.h <= outer.y + outer.h + 0.01;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const ofKind = (scene: SceneNode[], kind: SceneNode['kind']) => scene.filter((node) => node.kind === kind);
const personOf = (scene: SceneNode[], employeeId: string) => scene.find((node) => node.kind === 'person' && node.props.employeeId === employeeId)!;

describe('placement', () => {
  it('seats an idle employee at their desk with a dark screen and no bubble', () => {
    expect(placement('emp1', fromSnapshot(snapshot()), T0)).toEqual({ where: 'desk', screen: 'dark', bubble: null, tone: 'plain', decisionId: null, taskId: null });
  });

  it('lights the screen and shows the activity while a run is live', () => {
    const store = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [liveRun({ activity: 'docking the glass row' })] }));
    expect(placement('emp1', store, T0)).toMatchObject({ where: 'desk', screen: 'lit', bubble: 'docking the glass row', tone: 'plain', taskId: 'task1' });
  });

  it("falls back to the task's title when the run has set no activity, and says when it is a briefing", () => {
    const working = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1', title: 'Roster 503' })], runs: [liveRun()] }));
    expect(placement('emp1', working, T0).bubble).toBe('Roster 503');
    const briefing = fromSnapshot(snapshot({ tasks: [task({ state: 'briefing', title: 'Life as a pass stack' })], runs: [liveRun({ mode: 'brief' })] }));
    expect(placement('emp1', briefing, T0).bubble).toBe('briefing Life as a pass stack');
  });

  it('puts the author of a task in review in the meeting room before the review run starts', () => {
    const { store, now } = storyAt('c2_in_review');
    expect(placement('c2', store, now)).toMatchObject({ where: 'meeting', tone: 'review', taskId: taskTitled(store, 'C2 Person page from the roster')!.id });
    expect(placement('c2', store, now).bubble).toMatch(/^review · C2 Person page.* · \d+ lines$/);
    expect(placement('ios-lead', store, now).where).toBe('desk');
  });

  it('brings the lead into the meeting room while its review run is live', () => {
    const { store, now } = storyAt('review_running');
    expect(placement('ios-lead', store, now)).toMatchObject({ where: 'meeting', tone: 'review' });
    expect(placement('c2', store, now).where).toBe('meeting');
  });

  it("puts an employee whose lease card is open on the couch, with the decision's id", () => {
    const { store, now } = storyAt('lease_card');
    const card = [...store.decisions.values()].find((d) => d.kind === 'lease')!;
    expect(placement('nh', store, now)).toEqual({ where: 'stuck', screen: 'dark', bubble: 'silent 10 min · twice', tone: 'stuck', decisionId: card.id, taskId: card.taskId });
  });

  it('stuck wins over review, and review over working', () => {
    const tasks = [task({ id: 'blocked', state: 'blocked', blockedFrom: 'running', assigneeId: 'emp1' }), task({ id: 'reviewed', state: 'review', assigneeId: 'emp1' }), task({ id: 'worked', state: 'running', assigneeId: 'emp1' })];
    const runs = [run({ id: 'r0', taskId: 'reviewed', outcome: 'done', diffLines: 5 }), liveRun({ id: 'r1', taskId: 'worked' })];
    const card = decision({ taskId: 'blocked', kind: 'question', employeeId: 'emp1' });
    expect(placement('emp1', fromSnapshot(snapshot({ tasks, runs, decisions: [card] })), T0)).toMatchObject({ where: 'stuck', decisionId: 'dec1', bubble: 'has a question' });
    expect(placement('emp1', fromSnapshot(snapshot({ tasks: tasks.slice(1), runs })), T0).where).toBe('meeting');
    expect(placement('emp1', fromSnapshot(snapshot({ tasks: tasks.slice(2), runs })), T0).where).toBe('desk');
  });

  it('cuts a bubble at 40 characters', () => {
    const store = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [liveRun({ activity: 'x'.repeat(60) })] }));
    const bubble = placement('emp1', store, T0).bubble!;
    expect(bubble).toHaveLength(40);
    expect(bubble.endsWith('…')).toBe(true);
  });
});

describe('layout', () => {
  it('lays out one, two and three teams where the artboard has them', () => {
    expect(rugs(1)).toEqual([{ x: 92, y: 118, w: 470, h: 330 }]);
    expect(rugs(2)).toEqual([{ x: 92, y: 118, w: 470, h: 330 }, { x: 600, y: 118, w: 330, h: 330 }]);
    expect(rugs(3)).toEqual([{ x: 92, y: 118, w: 470, h: 330 }, { x: 600, y: 118, w: 330, h: 330 }, { x: 92, y: 490, w: 300, h: 220 }]);
  });

  it('seats four members and a lead where the artboard has them', () => {
    const { desks, lead, scale } = seats({ x: 92, y: 118, w: 470, h: 330 }, 4, true);
    expect(scale).toBe(1);
    expect(desks).toEqual([{ x: 120, y: 160, w: 120, h: 56 }, { x: 300, y: 160, w: 120, h: 56 }, { x: 120, y: 320, w: 120, h: 56 }, { x: 300, y: 320, w: 120, h: 56 }]);
    expect(lead).toEqual({ x: 470, y: 240, w: 70, h: 120 });
  });

  it('fits one to six teams of one to twelve people without overlap', () => {
    for (let teamCount = 1; teamCount <= 6; teamCount++) {
      const all = rugs(teamCount);
      expect(all).toHaveLength(teamCount);
      for (const rug of all) expect(inside(rug, FLOOR), `rug of ${teamCount}`).toBe(true);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!), `rugs ${i} and ${j} of ${teamCount}`).toBe(false);
      for (const rug of all) {
        for (const members of [1, 2, 5, 9, 12]) {
          const seated = seats(rug, members, true);
          const boxes = [...seated.desks, seated.lead!];
          expect(seated.desks).toHaveLength(members);
          for (const box of boxes) expect(inside(box, rug), `${members} in a rug of ${teamCount}`).toBe(true);
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!), `desks ${i},${j}: ${members} in a rug of ${teamCount}`).toBe(false);
        }
      }
    }
  });
});

describe('officeScene', () => {
  it('gives every employee exactly one person node, inside the floor', () => {
    for (const mark of ['start', 'parts_running', 'review_running', 'cards_open']) {
      const { store, now } = storyAt(mark);
      const people = ofKind(officeScene(store, now), 'person');
      expect(people.map((p) => p.props.employeeId).sort(), mark).toEqual([...store.employees.keys()].sort());
      for (const p of people) expect(inside(p, FLOOR), `${String(p.props.employeeId)} at ${mark}`).toBe(true);
    }
  });

  it('draws a rug per team with its name, and a lit monitor for exactly the people who are running', () => {
    const { store, now } = storyAt('parts_running');
    const scene = officeScene(store, now);
    expect(ofKind(scene, 'rug').map((r) => r.props.label)).toEqual(expect.arrayContaining(['Engineering · iOS', 'Engineering · Rust', 'Marketing', 'Meeting room', 'Chief of staff', 'Stuck corner', 'Kitchen']));
    const lit = ofKind(scene, 'monitor').filter((m) => m.props.lit).map((m) => m.props.employeeId);
    expect(lit.sort()).toEqual([...store.runs.values()].filter((r) => r.outcome === 'running').map((r) => r.employeeId).sort());
    expect(ofKind(scene, 'bubble').length).toBe(lit.length);
  });

  it('a lead wears white, the chief of staff wears dark, and a team shares one shirt colour', () => {
    const { store, now } = storyAt('start');
    const scene = officeScene(store, now);
    expect(personOf(scene, 'ios-lead').props.shirt).toBe('#F4F4F6');
    expect(personOf(scene, store.company!.chiefOfStaffId!).props.shirt).toBe('#2A2A2E');
    expect(personOf(scene, 'mo').props.shirt).toBe(personOf(scene, 'a6').props.shirt);
    expect(personOf(scene, 'mo').props.shirt).not.toBe(personOf(scene, 'ap').props.shirt);
  });

  it('the tray and the wall board read the number of open decisions', () => {
    const { store, now } = storyAt('cards_open');
    const scene = officeScene(store, now);
    expect(ofKind(scene, 'tray')[0]!.props).toMatchObject({ count: 4, label: '4 for you' });
    expect(String(ofKind(scene, 'wallboard')[0]!.props.sentence)).toContain('Four things on your desk.');
    const quiet = officeScene(storyAt('start').store, now);
    expect(ofKind(quiet, 'tray')[0]!.props).toMatchObject({ count: 0, label: 'nothing for you' });
  });

  it("the wall board's counts match the board's columns", () => {
    for (const mark of ['parts_running', 'cards_open', 'cards_answered']) {
      const { store, now } = storyAt(mark);
      const counts = ofKind(officeScene(store, now), 'wallboard')[0]!.props.counts as { label: string; count: number }[];
      expect(counts.map((c) => c.label)).toEqual(['queued', 'briefing', 'running', 'review', 'stuck', 'done']);
      expect(counts.map((c) => c.count), mark).toEqual(board(store, now).map((column) => column.count));
    }
  });

  it('the wall board names the longest silence against the lease, and the spend by team', () => {
    const { store, now } = storyAt('parts_running');
    const sentence = String(ofKind(officeScene(store, plus(now, 40)), 'wallboard')[0]!.props.sentence);
    expect(sentence).toMatch(/^Longest silence on the floor 40 s against a 10-minute lease\./);
    expect(sentence).toMatch(/Spend today \$\d+\.\d\d of \$40/);
    expect(String(ofKind(officeScene(storyAt('start').store, now), 'wallboard')[0]!.props.sentence)).toMatch(/^Nobody is running right now\./);
  });

  it('puts a Decide button in the stuck corner that carries the decision, and none when nobody is stuck', () => {
    const { store, now } = storyAt('lease_card');
    const scene = officeScene(store, now);
    const card = [...store.decisions.values()].find((d) => d.kind === 'lease')!;
    expect(ofKind(scene, 'button').map((b) => b.props)).toEqual([expect.objectContaining({ label: 'Decide', decisionId: card.id })]);
    expect(ofKind(officeScene(storyAt('start').store, now), 'button')).toEqual([]);
  });

  it('says in the kitchen why the company is paused', () => {
    const { store, now } = storyAt('paused');
    const kitchen = officeScene(store, now).find((node) => node.kind === 'label' && node.id === 'kitchen-line')!;
    expect(String(kitchen.props.text)).toMatch(/paused/);
    const normal = officeScene(storyAt('start').store, now).find((node) => node.id === 'kitchen-line')!;
    expect(normal.props.text).toBe('nobody here · everyone is at a desk');
  });

  it('replaying the story moves NH from desk to couch when the lease expires twice', () => {
    let store: Store = fromSnapshot(storySnapshot);
    const seen: string[] = [];
    for (const row of storyEvents) {
      store = reduce(store, row);
      const where = placement('nh', store, new Date(row.at)).where;
      if (seen.at(-1) !== where) seen.push(where);
    }
    expect(seen).toEqual(['desk', 'stuck']);
    const { store: after, now } = storyAt('lease_card');
    const nh = personOf(officeScene(after, now), 'nh');
    const couch = officeScene(after, now).find((node) => node.kind === 'couch')!;
    expect(Math.abs(nh.x - couch.x)).toBeLessThan(200);
    expect(nh.y).toBeLessThan(couch.y + couch.h);
    expect(nh.y).toBeGreaterThan(couch.y - 80);
  });

  it('seats two people at the meeting table during a review, and labels what is under review', () => {
    const { store, now } = storyAt('review_running');
    const scene = officeScene(store, now);
    const table = scene.find((node) => node.kind === 'table')!;
    for (const id of ['ios-lead', 'c2']) expect(Math.abs(personOf(scene, id).y - table.y)).toBeLessThan(120);
    expect(ofKind(scene, 'bubble').some((b) => /^review · C2 Person page/.test(String(b.props.text)))).toBe(true);
  });
});
