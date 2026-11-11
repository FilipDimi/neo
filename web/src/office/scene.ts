/**
 * The office as data: every rug, desk, person and bubble with its place, back to front.
 * The drawing layer turns each node into pixels and knows nothing else; replacing the artwork
 * never touches this file, and this file never touches the engine.
 */
import { countsCost, longestSilence } from '../../../src/shared/view.ts';
import { ago, initials, money, untilWhen } from '../format.ts';
import { board, liveRuns, openDecisions, spendToday } from '../model/select.ts';
import type { Store } from '../store/reduce.ts';
import { CHIEF, FLOOR, KITCHEN, MEETING, PALETTE, rugs, seats, SKIN, STUCK, WALL, type Rect } from './layout.ts';
import { placement, wrap, type Placement } from './placement.ts';

export type SceneKind = 'floor' | 'window' | 'rug' | 'label' | 'desk' | 'monitor' | 'chair' | 'person' | 'tag' | 'bubble' | 'whiteboard' | 'table' | 'couch' | 'lamp' | 'tray' | 'counter' | 'plant' | 'wallboard' | 'button';
export type SceneNode = Rect & { id: string; kind: SceneKind; props: Record<string, unknown> };

const node = (id: string, kind: SceneKind, rect: Rect, props: Record<string, unknown> = {}): SceneNode => ({ id, kind, ...rect, props });
const hash = (text: string): number => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
const WORDS = ['Nothing', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const LEAD_SHIRT = '#F4F4F6';
const CHIEF_SHIRT = '#2A2A2E';

/** Where a person stands relative to a member's desk, a lead's desk, the meeting table and the couch, at full size. */
type Offsets = { monitor: Point; chair: Point; person: Point; tag: Point & { w: number }; bubble: Point; side: 'left' | 'right'; /** How many letters fit before the next seat's bubble, at full size. */ say: number };
type Point = { x: number; y: number };
/** How much taller a bubble is for its second line. */
const BUBBLE_LINE = 13;
const AT_DESK: Offsets = { monitor: { x: 34, y: -14 }, chair: { x: 40, y: 64 }, person: { x: 48, y: 36 }, tag: { x: 26, y: 110, w: 68 }, bubble: { x: 104, y: 24 }, side: 'right', say: 28 };
// A lead's desk stands on end at the right of the rug; the bubble opens to the left of it.
const AT_LEAD_DESK: Offsets = { monitor: { x: 8, y: 60 }, chair: { x: 14, y: 146 }, person: { x: 22, y: 118 }, tag: { x: -2, y: 192, w: 76 }, bubble: { x: 68, y: 136 }, side: 'left', say: 22 };
const AT_CHIEF_DESK: Offsets = { monitor: { x: 16, y: -14 }, chair: { x: 26, y: 72 }, person: { x: 34, y: 44 }, tag: { x: 12, y: 118, w: 68 }, bubble: { x: 170, y: 60 }, side: 'right', say: 30 };
const CHIEF_DESK: Rect = { x: 470, y: 540, w: 160, h: 64 };
const STATUS = { stuck: 'stuck, needs you', meeting: 'in a review', lit: 'working', dark: 'idle' };
const MEETING_SEATS = [{ x: 1056, y: 216 }, { x: 1240, y: 216 }, { x: 1000, y: 296 }, { x: 1300, y: 296 }, { x: 1148, y: 216 }, { x: 1148, y: 372 }];
const COUCH_SEATS = [{ x: 908, y: 580 }, { x: 952, y: 580 }, { x: 996, y: 580 }, { x: 880, y: 580 }];

export function officeScene(store: Store, now: Date): SceneNode[] {
  const scene: SceneNode[] = [];
  const add = (...nodes: SceneNode[]) => void scene.push(...nodes);
  const staff = [...store.employees.values()].filter((employee) => !employee.fired);
  const chief = staff.find((employee) => employee.id === store.company?.chiefOfStaffId);
  const placed = new Map<string, Placement>(staff.map((employee) => [employee.id, placement(employee.id, store, now)]));
  const teams = [...store.teams.values()].filter((team) => !chief || team.id !== chief.teamId || staff.some((employee) => employee.teamId === team.id && employee.id !== chief.id));
  const decisions = openDecisions(store);
  const tagText = (name: string) => (name.length <= 9 ? name : initials(name));

  // ---------- the room ----------
  add(node('floor', 'floor', FLOOR));
  for (const [index, x] of [120, 400, 1120].entries()) add(node(`window:${index}`, 'window', { x, y: 52, w: 220, h: 22 }));

  // ---------- fixed rooms ----------
  add(node('rug:meeting', 'rug', MEETING, { label: 'Meeting room', style: 'meeting', labelColor: '#76D3CC' }));
  add(node('whiteboard', 'whiteboard', { x: 1010, y: 150, w: 300, h: 70 }), node('table', 'table', { x: 1030, y: 270, w: 260, h: 100 }));
  add(node('rug:chief', 'rug', CHIEF, { label: 'Chief of staff', style: 'room', fill: '#1F1A17', edge: '#2A2320', labelColor: '#7A6E66' }));
  add(node('rug:stuck', 'rug', STUCK, { label: 'Stuck corner', style: 'room', fill: '#2A1715', edge: '#3A1F1C', labelColor: '#E0625A' }));
  add(node('lamp', 'lamp', { x: 920, y: 506, w: 48, h: 74 }), node('couch', 'couch', { x: 870, y: 610, w: 160, h: 54 }));
  add(node('rug:kitchen', 'rug', KITCHEN, { label: 'Kitchen', style: 'room', fill: '#1A1A1C', edge: '#242426', labelColor: '#6F6F78' }));
  add(node('counter', 'counter', { x: 1140, y: 506, w: 190, h: 130 }));
  const paused = store.company?.paused;
  const until = paused?.until ? ` until ${untilWhen(paused.until, now)}` : '';
  const everyoneAtDesk = [...placed.values()].every((p) => p.where === 'desk');
  const kitchenLine = paused ? `paused: ${paused.reason === 'usage_limit' ? "the plan's usage limit" : paused.reason === 'health' ? 'the machine needs attention' : 'by you'}${until}` : everyoneAtDesk ? 'nobody here · everyone is at a desk' : 'nobody here';
  add(node('kitchen-line', 'label', { x: 1130, y: 640, w: 210, h: 14 }, { text: kitchenLine, color: paused ? '#F2C76B' : '#6F6F78', size: 10 }));
  for (const [index, spot] of [{ x: 998, y: 380 }, { x: 300, y: 560 }, { x: 1300, y: 600 }].entries()) add(node(`plant:${index}`, 'plant', { ...spot, w: 40, h: 64 }));

  // ---------- one seat per person ----------
  const meeting: string[] = [];
  const couch: string[] = [];
  const people = new Map<string, Record<string, unknown>>();
  // What people are saying goes on top of every seat, so a neighbour's desk never covers it.
  const bubbles: SceneNode[] = [];
  /** A desk with its screen and chair, and the person at it unless they are in the meeting room or on the couch. */
  function seat(employeeId: string, desk: Rect, scale: number, offsets: Offsets, shirt: string): void {
    const employee = store.employees.get(employeeId)!;
    const at = placed.get(employeeId)!;
    const lit = at.where === 'desk' && at.screen === 'lit';
    const place = (offset: Point, w: number, h: number): Rect => ({ x: desk.x + offset.x * scale, y: desk.y + offset.y * scale, w: w * scale, h: h * scale });
    add(node(`desk:${employeeId}`, 'desk', desk, { lead: offsets === AT_LEAD_DESK, scale }));
    add(node(`monitor:${employeeId}`, 'monitor', place(offsets.monitor, 52, 34), { lit, employeeId, scale, taskId: lit ? at.taskId : null, name: employee.name }));
    add(node(`chair:${employeeId}`, 'chair', place(offsets.chair, 40, 40), { scale }));
    const status = at.where === 'desk' ? STATUS[at.screen] : STATUS[at.where];
    const props = { employeeId, name: employee.name, shirt, skin: SKIN[hash(employeeId) % SKIN.length], where: at.where, tone: at.tone, status, saying: at.bubble, decisionId: at.decisionId, taskId: at.taskId };
    if (at.where === 'meeting') return void (meeting.push(employeeId), people.set(employeeId, props));
    if (at.where === 'stuck') return void (couch.push(employeeId), people.set(employeeId, props));
    add(node(`person:${employeeId}`, 'person', place(offsets.person, 24, 46), { ...props, scale }));
    add(node(`tag:${employeeId}`, 'tag', { ...place(offsets.tag, offsets.tag.w, 18), h: 18 }, { text: tagText(employee.name), tone: lit ? 'active' : 'idle' }));
    if (at.bubble) {
      const anchor = place(offsets.bubble, 0, 0);
      // As many letters a line as fit before the next seat's bubble, on two lines: the second grows upwards, away from the desk.
      const said = wrap(at.bubble, Math.max(12, Math.floor(offsets.say * scale)));
      const h = 22 + (said.length - 1) * BUBBLE_LINE;
      bubbles.push(node(`bubble:${employeeId}`, 'bubble', { x: anchor.x, y: anchor.y - (h - 22), w: 0, h }, { text: said.join('\n'), tone: 'plain', side: offsets.side, taskId: at.taskId }));
    }
  }

  const rects = rugs(teams.length);
  for (const [index, team] of teams.entries()) {
    const rug = rects[index]!;
    const palette = PALETTE[index % PALETTE.length]!;
    const lead = staff.find((employee) => employee.id === team.leadId && employee.id !== chief?.id);
    const members = staff.filter((employee) => employee.teamId === team.id && employee.id !== lead?.id && employee.id !== chief?.id);
    add(node(`rug:${team.id}`, 'rug', rug, { label: team.name, style: 'team', fill: palette.rug, edge: palette.edge, labelColor: palette.label }));
    const seated = seats(rug, members.length, Boolean(lead));
    for (const [i, member] of members.entries()) seat(member.id, seated.desks[i]!, seated.scale, AT_DESK, palette.shirt);
    if (lead && seated.lead) seat(lead.id, seated.lead, seated.scale, AT_LEAD_DESK, LEAD_SHIRT);
  }

  // The chief of staff: a wider desk with a tray of envelopes, one per decision waiting for the user.
  if (chief) seat(chief.id, CHIEF_DESK, 1, AT_CHIEF_DESK, CHIEF_SHIRT);
  add(node('tray', 'tray', { x: 560, y: 534, w: 56, h: 74 }, { count: decisions.length, label: decisions.length === 0 ? 'nothing for you' : `${decisions.length} for you` }));

  // ---------- the meeting room and the stuck corner ----------
  for (const [index, employeeId] of meeting.entries()) {
    const spot = MEETING_SEATS[index % MEETING_SEATS.length]!;
    const props = people.get(employeeId)!;
    add(node(`person:${employeeId}`, 'person', { x: spot.x, y: spot.y, w: 24, h: 46 }, { ...props, scale: 1 }));
    add(node(`tag:${employeeId}`, 'tag', { x: spot.x - 24, y: index < 2 ? 388 : spot.y + 50, w: 72, h: 18 }, { text: tagText(String(props.name)), tone: 'review' }));
  }
  const reviews = [...new Set(meeting.map((id) => placed.get(id)!.bubble).filter((bubble): bubble is string => bubble !== null))];
  for (const [index, text] of reviews.slice(0, 2).entries()) bubbles.push(node(`bubble:review:${index}`, 'bubble', { x: 1060, y: 412 + index * 24, w: 0, h: 22 }, { text, tone: 'review', side: 'none', taskId: placed.get(meeting.find((id) => placed.get(id)!.bubble === text)!)!.taskId }));

  // On the couch: a run that went silent first, then whoever has waited longest. The button is the first one's card.
  const cardOf = (employeeId: string) => store.decisions.get(placed.get(employeeId)!.decisionId ?? '');
  couch.sort((a, b) => Number(cardOf(b)?.kind === 'lease') - Number(cardOf(a)?.kind === 'lease') || (cardOf(a)?.askedAt ?? '').localeCompare(cardOf(b)?.askedAt ?? ''));
  for (const [index, employeeId] of couch.entries()) {
    const spot = COUCH_SEATS[index % COUCH_SEATS.length]!;
    const props = people.get(employeeId)!;
    const at = placed.get(employeeId)!;
    add(node(`person:${employeeId}`, 'person', { x: spot.x, y: spot.y, w: 24, h: 46 }, { ...props, scale: 1 }));
    add(node(`tag:${employeeId}`, 'tag', { x: spot.x - 22, y: 670, w: 68, h: 18 }, { text: tagText(String(props.name)), tone: 'stuck' }));
    if (index === 0) {
      if (at.bubble) bubbles.push(node(`bubble:${employeeId}`, 'bubble', { x: 940, y: 560, w: 0, h: 22 }, { text: at.bubble, tone: 'stuck', side: 'right', taskId: at.taskId }));
      add(node('button:decide', 'button', { x: 960, y: 630, w: 62, h: 24 }, { label: 'Decide', decisionId: at.decisionId, name: props.name }));
    }
  }
  if (couch.length > 1) add(node('label:stuck-more', 'label', { x: 850, y: 690, w: 200, h: 14 }, { text: `${couch.length} people are waiting on you`, color: '#E0625A', size: 10 }));

  add(...bubbles);

  // ---------- the wall board ----------
  const columns = board(store, now);
  const colour: Record<string, string> = { running: '#F5B700', review: '#76D3CC', blocked: '#E0625A', done: '#7CF0BF' };
  const counts = columns.map((column) => ({ label: column.key === 'blocked' ? 'stuck' : column.key, count: column.count, color: colour[column.key] ?? '#F4F4F6' }));
  const silence = longestSilence(liveRuns(store), now);
  const spend = spendToday(store, now);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const failed = [...store.tasks.values()].filter((task) => task.kind === 'work' && task.state === 'failed' && task.updatedAt >= midnight).length;
  const things = decisions.length === 0 ? 'Nothing on your desk.' : `${WORDS[decisions.length] ?? decisions.length} thing${decisions.length === 1 ? '' : 's'} on your desk.`;
  const sentence = [
    silence ? `Longest silence on the floor ${ago(new Date(now.getTime() - silence.seconds * 1000).toISOString(), now)} against a ${silence.leaseMinutes}-minute lease.` : 'Nobody is running right now.',
    countsCost(store.company) ? `Spend today ${money(spend.company)} of ${money(store.company?.dailyCapUsd ?? 0, true)}${spend.byTeam.length > 0 ? `: ${spend.byTeam.map((team) => `${team.name} ${money(team.usd)}`).join(', ')}` : ''}.` : '',
    failed > 0 ? `${failed} task${failed === 1 ? '' : 's'} failed today.` : '',
    things,
  ]
    .filter(Boolean)
    .join(' ');
  add(node('wallboard', 'wallboard', WALL, { counts, sentence }));
  return scene;
}
