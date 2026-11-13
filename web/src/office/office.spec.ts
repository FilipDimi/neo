import { describe, expect, it } from 'vitest';
import { company, decision, employee, plus, run, T0, task, team } from '../../../test/rows.ts';
import { storyAt, storyEvents, storySnapshot, taskTitled } from '../fixtures/story.ts';
import { board } from '../model/select.ts';
import { fromSnapshot, reduce, type Snapshot, type Store } from '../store/reduce.ts';
import { FLOOR, rugs, seats, type Rect } from './layout.ts';
import { placement, wrap } from './placement.ts';
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

  it('says in a sentence what someone is on when the run has set no activity: working on it, or planning it', () => {
    const working = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1', title: 'Roster 503' })], runs: [liveRun()] }));
    expect(placement('emp1', working, T0).bubble).toBe('Working on Roster 503');
    const briefing = fromSnapshot(snapshot({ tasks: [task({ state: 'briefing', title: 'Life as a pass stack' })], runs: [liveRun({ mode: 'brief' })] }));
    expect(placement('emp1', briefing, T0).bubble).toBe('Planning Life as a pass stack');
  });

  it('says quietly that someone waits for the engine: a check that is running, or their turn, in their own words', () => {
    const at = (waiting: { on: 'gate' | 'lock'; what: string }) => placement('emp1', fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [liveRun({ activity: 'running the gate "tests"', waiting: { ...waiting, since: T0.toISOString() } })] })), T0);
    expect(at({ on: 'gate', what: 'tests' })).toMatchObject({ where: 'desk', screen: 'lit', tone: 'waiting', bubble: 'Waiting for the check "tests"', taskId: 'task1' });
    expect(at({ on: 'lock', what: 'the xcode lock, held by "Another task"' })).toMatchObject({ tone: 'waiting', bubble: 'Waiting for my turn' });
  });

  it('puts the author of a task in review in the meeting room before the review run starts', () => {
    const { store, now } = storyAt('c2_in_review');
    expect(placement('c2', store, now)).toMatchObject({ where: 'meeting', tone: 'review', taskId: taskTitled(store, 'C2 Person page from the roster')!.id });
    expect(placement('c2', store, now).bubble).toMatch(/^Reviewing C2 Person page/);
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
    expect(placement('nh', store, now)).toEqual({ where: 'stuck', screen: 'dark', bubble: 'Quiet for 10 min, twice', tone: 'stuck', decisionId: card.id, taskId: card.taskId });
  });

  it('stuck wins over review, and review over working', () => {
    const tasks = [task({ id: 'blocked', state: 'blocked', blockedFrom: 'running', assigneeId: 'emp1' }), task({ id: 'reviewed', state: 'review', assigneeId: 'emp1' }), task({ id: 'worked', state: 'running', assigneeId: 'emp1' })];
    const runs = [run({ id: 'r0', taskId: 'reviewed', outcome: 'done', diffLines: 5 }), liveRun({ id: 'r1', taskId: 'worked' })];
    const card = decision({ taskId: 'blocked', kind: 'question', employeeId: 'emp1' });
    expect(placement('emp1', fromSnapshot(snapshot({ tasks, runs, decisions: [card] })), T0)).toMatchObject({ where: 'stuck', decisionId: 'dec1', bubble: 'has a question' });
    expect(placement('emp1', fromSnapshot(snapshot({ tasks: tasks.slice(1), runs })), T0).where).toBe('meeting');
    expect(placement('emp1', fromSnapshot(snapshot({ tasks: tasks.slice(2), runs })), T0).where).toBe('desk');
  });

  it('keeps the whole of a status line: it is a sentence of up to 60 characters, and the room wraps it', () => {
    const said = 'Building the results list of the search page';
    const store = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [liveRun({ activity: said })] }));
    expect(placement('emp1', store, T0).bubble).toBe(said);
    const long = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [liveRun({ activity: 'x'.repeat(90) })] }));
    expect(placement('emp1', long, T0).bubble).toHaveLength(60);
  });

  it('wraps what is said onto two lines between words, and ends a third with an ellipsis', () => {
    expect(wrap('Drawing the toggles of the settings screen', 28)).toEqual(['Drawing the toggles of the', 'settings screen']);
    expect(wrap('docking the glass row', 28)).toEqual(['docking the glass row']);
    expect(wrap('Building the results list of the search page from the board and its empty state', 28)).toEqual(['Building the results list of', 'the search page from the…']);
    // A word longer than a line is the one thing that is cut.
    expect(wrap(`${'x'.repeat(40)} tail`, 28)).toEqual([`${'x'.repeat(27)}…`]);
    // A word too long for a line goes on a line of its own: the words before it are kept whole, and both lines are used.
    expect(wrap('Writing implementation of the login page', 12)).toEqual(['Writing', 'implementat…']);
    expect(wrap('fix the test internationalization now', 12)).toEqual(['fix the test', 'internation…']);
    expect(wrap('one two three four internationalization', 12)).toEqual(['one two', 'three four…']);
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

  // A team of people who are all saying the same long thing: the hardest case for the room.
  const crew = (count: number, said = 'Building the results list of the search page from the board') => {
    const employees = Array.from({ length: count }, (_, i) => employee({ id: `m${i}`, name: `M${i}` }));
    const tasks = employees.map((one, i) => task({ id: `t${i}`, title: `Task ${i}`, state: 'running', assigneeId: one.id }));
    const runs = employees.map((one, i) => liveRun({ id: `r${i}`, taskId: `t${i}`, employeeId: one.id, activity: said }));
    return officeScene(fromSnapshot(snapshot({ employees, tasks, runs })), T0);
  };
  const bubbleOf = (scene: SceneNode[], id: string) => scene.find((node) => node.id === `bubble:${id}`)!;
  /** The widest a bubble can come out: its longest line in the room's type, and its padding. */
  const widest = (bubble: SceneNode) => Math.max(...String(bubble.props.text).split('\n').map((line) => line.length)) * 6.2 + 22;

  const linesOf = (bubble: SceneNode) => String(bubble.props.text).split('\n');
  const part = (scene: SceneNode[], id: string) => scene.find((node) => node.id === id)!;

  it("puts what someone says over their own desk, with its tail down at them: never over a neighbour, never over the row above", () => {
    const scene = crew(4);
    for (const id of ['m0', 'm1', 'm2', 'm3']) {
      const bubble = bubbleOf(scene, id);
      const head = personOf(scene, id);
      expect(linesOf(bubble).length, id).toBeLessThanOrEqual(3);
      for (const line of linesOf(bubble)) expect(line.length, line).toBeLessThanOrEqual(24);
      expect(bubble.x).toBe(part(scene, `desk:${id}`).x);
      // It ends just above the speaker's head, where its tail points.
      expect(head.y - (bubble.y + bubble.h)).toBe(5);
      expect(bubble.props).toMatchObject({ side: 'right', tail: 'down', tailAt: head.x + head.w / 2 - bubble.x });
    }
    // All of what was said is there: at full size a seat holds a whole status line.
    expect(linesOf(bubbleOf(scene, 'm0')).join(' ')).toBe('Building the results list of the search page from the board');
    // It ends before the next desk, and the row below does not talk over the names of the row above.
    expect(bubbleOf(scene, 'm0').x + widest(bubbleOf(scene, 'm0'))).toBeLessThanOrEqual(part(scene, 'desk:m1').x);
    expect(bubbleOf(scene, 'm2').y).toBeGreaterThanOrEqual(part(scene, 'tag:m0').y + part(scene, 'tag:m0').h);
    // The first row leaves the rug's name alone: it is written 10 from the top of the rug, 12 tall.
    expect(bubbleOf(scene, 'm0').y).toBeGreaterThanOrEqual(part(scene, 'rug:team1').y + 22);
    // It grows upwards: a short one ends at the same place.
    const short = bubbleOf(crew(4, 'docking the glass row'), 'm0');
    expect(short.h).toBe(21);
    expect(short.y + short.h).toBe(bubbleOf(scene, 'm0').y + bubbleOf(scene, 'm0').h);
  });

  it("lays a lead's words over the far end of their own desk, clear of the last column of the team, and stops a member's words at the lead's desk", () => {
    const lead = employee({ id: 'lead', name: 'Lea' });
    const members = Array.from({ length: 4 }, (_, i) => employee({ id: `m${i}`, name: `M${i}` }));
    const said = 'Building the results list of the search page from the board';
    const tasks = [...members, lead].map((one, i) => task({ id: `t${i}`, title: `Task ${i}`, state: 'running', assigneeId: one.id }));
    const runs = [...members, lead].map((one, i) => liveRun({ id: `r${i}`, taskId: `t${i}`, employeeId: one.id, activity: said }));
    const scene = officeScene(fromSnapshot(snapshot({ teams: [team({ leadId: 'lead' })], employees: [...members, lead], tasks, runs })), T0);
    const leads = bubbleOf(scene, 'lead');
    const desk = part(scene, 'desk:lead');
    expect(leads.props).toMatchObject({ side: 'left', tail: 'down' });
    // It opens to the left from the rug's edge: its right end is fixed, its left end is as far as its words go.
    const left = leads.x - widest(leads);
    expect(leads.x).toBeGreaterThan(desk.x + desk.w);
    // Clear of the lead themselves, of the names of the last column, and of what the member beside the lead says.
    expect(leads.y + leads.h).toBeLessThanOrEqual(personOf(scene, 'lead').y);
    for (const id of ['m1', 'm3']) expect(left, id).toBeGreaterThanOrEqual(part(scene, `tag:${id}`).x + part(scene, `tag:${id}`).w);
    expect(overlap({ x: left, y: leads.y, w: widest(leads), h: leads.h }, { x: bubbleOf(scene, 'm3').x, y: bubbleOf(scene, 'm3').y, w: widest(bubbleOf(scene, 'm3')), h: bubbleOf(scene, 'm3').h })).toBe(false);
    expect(overlap({ x: left, y: leads.y, w: widest(leads), h: leads.h }, { x: bubbleOf(scene, 'm1').x, y: bubbleOf(scene, 'm1').y, w: widest(bubbleOf(scene, 'm1')), h: bubbleOf(scene, 'm1').h })).toBe(false);
    // The members of the last column stop at the lead's desk.
    for (const id of ['m1', 'm3']) expect(bubbleOf(scene, id).x + widest(bubbleOf(scene, id)), id).toBeLessThanOrEqual(desk.x);
  });

  it('on a rug of six and a lead, as in the demo, nobody talks over a name, a neighbour or the lead', () => {
    const lead = employee({ id: 'lead', name: 'Lea' });
    const members = Array.from({ length: 6 }, (_, i) => employee({ id: `m${i}`, name: `M${i}` }));
    const all = [...members, lead];
    const tasks = all.map((one, i) => task({ id: `t${i}`, title: `Task ${i}`, state: 'running', assigneeId: one.id }));
    const runs = all.map((one, i) => liveRun({ id: `r${i}`, taskId: `t${i}`, employeeId: one.id, activity: 'Building the results list of the search page from the board' }));
    const scene = officeScene(fromSnapshot(snapshot({ teams: [team({ leadId: 'lead' })], employees: all, tasks, runs })), T0);
    const box = (id: string): Rect => {
      const bubble = bubbleOf(scene, id);
      const w = widest(bubble);
      return { x: bubble.props.side === 'left' ? bubble.x - w : bubble.x, y: bubble.y, w, h: bubble.h };
    };
    const ids = all.map((one) => one.id);
    for (const id of ids) {
      // Nobody's words are over anybody's head or name, their own included.
      for (const other of ids) {
        expect(overlap(box(id), personOf(scene, other)), `${id} over ${other}`).toBe(false);
        expect(overlap(box(id), part(scene, `tag:${other}`)), `${id} over the name of ${other}`).toBe(false);
        if (other !== id) expect(overlap(box(id), box(other)), `${id} over what ${other} says`).toBe(false);
      }
      // The rug's name is written 8 from its top, 12 tall.
      expect(box(id).y, id).toBeGreaterThanOrEqual(part(scene, 'rug:team1').y + 20);
    }
  });

  // ---------- every rug, not only the artboard's ----------

  /** A bubble's box as the room reckons it: its longest line at 6.2 a letter and 22 of padding, opening left or right from where it stands. */
  const boxOf = (scene: SceneNode[], id: string): Rect => {
    const bubble = part(scene, `bubble:${id}`);
    const w = widest(bubble);
    return { x: bubble.props.side === 'left' ? bubble.x - w : bubble.x, y: bubble.y, w, h: bubble.h };
  };
  /** A company of teams, each `[members, has a lead]`, where the people named in `talking` (everyone, unless told) are at work and say the same thing. Team t's people are `m{t}_{i}` and `lead{t}`. */
  function office(shape: [members: number, lead: boolean][], talking?: string[], said = 'Building the results list of the search page from the board'): SceneNode[] {
    const teams = shape.map(([, led], t) => team({ id: `t${t}`, name: `Team ${t}`, leadId: led ? `lead${t}` : null }));
    const employees = teams.flatMap((one, t) => [...Array.from({ length: shape[t]![0] }, (_, i) => employee({ id: `m${t}_${i}`, name: `M${i}`, teamId: one.id })), ...(shape[t]![1] ? [employee({ id: `lead${t}`, name: 'Lea', teamId: one.id })] : [])]);
    const busy = employees.filter((one) => !talking || talking.includes(one.id));
    const tasks = busy.map((one) => task({ id: `task:${one.id}`, title: `Task of ${one.id}`, state: 'running', assigneeId: one.id, teamId: one.teamId }));
    const runs = busy.map((one) => liveRun({ id: `run:${one.id}`, taskId: `task:${one.id}`, employeeId: one.id, activity: said }));
    return officeScene(fromSnapshot(snapshot({ teams, employees, tasks, runs })), T0);
  }
  /** Everything wrong with where the bubbles of one rug lie: over a face, a name, each other, the rug's name or its edge. */
  function wrongs(scene: SceneNode[], rugId: string, ids: string[]): string[] {
    const rug = part(scene, rugId);
    const talking = ids.filter((id) => scene.some((node) => node.id === `bubble:${id}`));
    const out: string[] = [];
    for (const id of talking) {
      const box = boxOf(scene, id);
      for (const other of ids) {
        if (overlap(box, personOf(scene, other))) out.push(`${id} over ${other}`);
        if (overlap(box, part(scene, `tag:${other}`))) out.push(`${id} over the name of ${other}`);
        if (other !== id && talking.includes(other) && overlap(box, boxOf(scene, other))) out.push(`${id} over what ${other} says`);
      }
      if (box.y < rug.y || box.x < rug.x || box.x + box.w > rug.x + rug.w) out.push(`${id} off the rug`);
    }
    return out;
  }
  const team0 = (members: number, lead: boolean) => [...Array.from({ length: members }, (_, i) => `m0_${i}`), ...(lead ? ['lead0'] : [])];

  it('on rugs of every size, with everyone talking at once, nobody talks over a face, a name, a neighbour or the edge of the rug', () => {
    for (const lead of [false, true]) {
      for (const members of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]) {
        const scene = office([[members, lead]]);
        expect(wrongs(scene, 'rug:t0', team0(members, lead)), `${members} members${lead ? ' and a lead' : ''}`).toEqual([]);
      }
    }
    // The second and third rugs of the artboard's room are narrower and lower.
    for (const members of [1, 2, 3, 4, 5]) {
      const scene = office([[4, true], [members, true], [members, true]]);
      for (const t of [1, 2]) expect(wrongs(scene, `rug:t${t}`, [...Array.from({ length: members }, (_, i) => `m${t}_${i}`), `lead${t}`]), `${members} and a lead on rug ${t}`).toEqual([]);
    }
  });

  it("ends a row of bubbles under the band of the rug's name wherever a few words fit there, and never lies on the name while they fit beside it", () => {
    for (const [members, lead] of [[4, true], [6, true], [7, true]] as const) {
      const scene = office([[members, lead]]);
      const rug = part(scene, 'rug:t0');
      for (const id of team0(members, lead)) expect(boxOf(scene, id).y, `${id} of ${members}`).toBeGreaterThanOrEqual(rug.y + 20);
    }
    // A rug of nine: the last seat of the first row has room for eight letters under the band. It says a line more,
    // in the band, where the name is not.
    const nine = office([[9, false]]);
    const rug = part(nine, 'rug:t0');
    const written = { x: rug.x + 20, y: rug.y + 8, w: 'Team 0'.length * 7.6 + 4, h: 12 };
    for (const id of team0(9, false)) expect(overlap(boxOf(nine, id), written), id).toBe(false);
    expect(boxOf(nine, 'm0_3').y).toBeLessThan(rug.y + 20);
    expect(linesOf(part(nine, 'bubble:m0_3'))).toHaveLength(2);
  });

  it('on the third rug, which is low, a lead beside the first row talks above their own head and not over the member', () => {
    const scene = office([[4, true], [2, true], [1, true]]);
    expect(overlap(boxOf(scene, 'm2_0'), boxOf(scene, 'lead2'))).toBe(false);
    // The lead's whole sentence is there all the same.
    expect(linesOf(part(scene, 'bubble:lead2')).join(' ')).toBe('Building the results list of the search page from the board');
    const two = office([[4, true], [2, true], [2, true]]);
    const said = boxOf(two, 'm2_1');
    expect(said.x + said.w, "the member's words end before the lead's desk").toBeLessThanOrEqual(part(two, 'desk:lead2').x);
    expect(overlap(boxOf(two, 'lead2'), part(two, 'tag:m2_1'))).toBe(false);
  });

  it('says more of a sentence over a neighbour who is saying nothing, and keeps to its own seat beside one who talks', () => {
    const alone = boxOf(office([[6, false]], ['m0_0']), 'm0_0');
    const both = office([[6, false]], ['m0_0', 'm0_1']);
    const shown = (scene: SceneNode[], id: string) => linesOf(part(scene, `bubble:${id}`)).join(' ').length;
    expect(shown(office([[6, false]], ['m0_0']), 'm0_0')).toBeGreaterThan(shown(both, 'm0_0'));
    expect(alone.x + alone.w).toBeGreaterThan(part(both, 'desk:m0_1').x);
    expect(boxOf(both, 'm0_0').x + boxOf(both, 'm0_0').w).toBeLessThanOrEqual(part(both, 'desk:m0_1').x);
    // Never past the seat after the next.
    expect(alone.x + alone.w).toBeLessThanOrEqual(part(both, 'desk:m0_2').x);
  });

  it('on a crowded rug everyone says less, on one line; where not even a few letters fit, three dots or nothing, and the whole sentence stays one click away', () => {
    const crowded = office([[14, false]]);
    for (const id of team0(14, false)) expect(linesOf(part(crowded, `bubble:${id}`))).toHaveLength(1);
    // A room of five teams: the rugs are a third as wide, the seats tiny.
    const tiny = office([[12, true], [1, false], [1, false], [1, false], [1, false]]);
    expect(wrongs(tiny, 'rug:t0', team0(12, true))).toEqual([]);
    const bubbles = tiny.filter((node) => node.kind === 'bubble' && node.id.startsWith('bubble:m0_'));
    expect(bubbles.length).toBeGreaterThan(0);
    for (const bubble of bubbles) {
      expect(String(bubble.props.text).length <= 12 || bubble.props.text === '…').toBe(true);
      expect(bubble.props.full).toBe('Building the results list of the search page from the board');
    }
    expect(bubbles.some((bubble) => bubble.props.text === '…')).toBe(true);
  });

  it('gives a waiting run a quiet bubble', () => {
    const waitingRun = liveRun({ activity: 'running the gate "tests"', waiting: { on: 'gate' as const, what: 'tests', since: T0.toISOString() } });
    const scene = officeScene(fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [waitingRun] })), T0);
    expect(bubbleOf(scene, 'emp1').props).toMatchObject({ tone: 'waiting', text: 'Waiting for the check\n"tests"' });
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

  it("counts only today's failed tasks on the wall board, whatever older ones the page still holds", () => {
    const { store, now } = storyAt('cards_answered');
    const nextDay = new Date(now.getTime() + 24 * 3600_000);
    expect([...store.tasks.values()].some((task) => task.state === 'failed')).toBe(true);
    expect(String(ofKind(officeScene(store, now), 'wallboard')[0]!.props.sentence)).toMatch(/failed today/);
    expect(String(ofKind(officeScene(store, nextDay), 'wallboard')[0]!.props.sentence)).not.toMatch(/failed today/);
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
    expect(ofKind(scene, 'bubble').some((b) => /^Reviewing C2 Person page/.test(String(b.props.text)))).toBe(true);
  });
});
