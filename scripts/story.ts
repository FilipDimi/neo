/**
 * Records a company day: the real engine, in this process, on the scripted runtime, with a clock
 * the script moves. It writes web/src/fixtures/story.json: the snapshot before the first task,
 * every event after it, and named marks (an event id and a time) the web tests replay up to.
 *
 *   npm run story
 *
 * The day reaches every state the artboards draw: chat that becomes tasks, a briefing, work with
 * status lines and gates, a review with a send-back, a lease that expires twice, a merge card, a
 * refused write, a question, a failed task, and a usage-limit pause that lifts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/api/server.ts';
import { loadToken } from '../src/api/security.ts';
import { lastEventId, readEvents } from '../src/db/apply.ts';
import { paths } from '../src/db/dataDir.ts';
import { openDb } from '../src/db/open.ts';
import * as store from '../src/db/store.ts';
import { chat } from '../src/supervisor/chat.ts';
import { Supervisor } from '../src/supervisor/supervisor.ts';
import { demoPlay } from '../test/fixtures/demoRuntime.ts';
import { inProcess } from '../test/fixtures/inProcess.ts';
import { staged } from '../test/fixtures/staged.ts';
import { healthyProbes, seedDemoCompany } from './seed-demo.ts';

const OUT = path.resolve(import.meta.dirname, '../web/src/fixtures/story.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-story-')));
const dataDir = path.join(root, 'data');
const db = openDb(paths(dataDir).db);

// The clock: a Monday morning, moved only by the script.
let now = new Date(2026, 10, 9, 9, 0, 0);
const advance = (minutes: number) => void (now = new Date(now.getTime() + minutes * 60_000));

// Every pause in the play waits to be released, so the script can look at the company mid-run.
let waiting: (() => void)[] = [];
const wait = () => new Promise<void>((resolve) => waiting.push(resolve));
const release = () => {
  const held = waiting;
  waiting = [];
  for (const go of held) go();
};
const fixture = inProcess(staged(demoPlay(wait)));
seedDemoCompany({ db, dataDir, repoPath: path.join(root, 'repo'), now, leaseMinutes: 10 });
const sup = new Supervisor({ db, dataDir, now: () => now, spawn: fixture.spawn, probes: healthyProbes });
const app = await buildServer({ db, dataDir, supervisor: sup, port: 4317 });
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', authorization: `Bearer ${loadToken(paths(dataDir).token)}` };

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  await sup.settle();
};
const marks: { name: string; eventId: number; now: string }[] = [];
const mark = (name: string) => void marks.push({ name, eventId: lastEventId(db), now: now.toISOString() });

/** One tick; the runs it starts are held at their first pause, with their status lines set. */
async function tick(markName?: string): Promise<void> {
  await sup.tick();
  await flush();
  if (markName) mark(markName);
}
/** Lets every held run carry on to its end, a minute at a time. */
async function finish(): Promise<void> {
  for (let round = 0; round < 12; round++) {
    advance(1);
    release();
    await flush();
  }
}
/** Ticks and finishes until nothing is queued or running. Hung runs do not count. */
async function drain(hung = 0): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await tick();
    await finish();
    if (store.openRequests(db).length === 0 && store.liveRuns(db).length <= hung) return;
  }
}
const task = (input: Parameters<Supervisor['createTask']>[0]) => sup.createTask(input);
const answer = (kind: string, optionId: string) => {
  const card = store.openDecisions(db).find((d) => d.kind === kind);
  if (!card) throw new Error(`the story expected an open ${kind} card`);
  sup.answer(card.id, { optionId });
};

await sup.checkHealth();
const snapshot = JSON.parse((await app.inject({ method: 'GET', url: '/api/snapshot', headers })).body) as { lastEventId: number };
mark('start');

// 09:00  The user asks for two things in the chat. Neo writes two tasks.
chat(sup, 'Make the open seamless and fix the roster 503');
await tick('chat_routing'); // Neo at its desk, reading the message
await finish();
mark('chat_answered');

// The two leads brief; then parts are worked, three at a time.
await tick('briefing'); // both leads splitting
await finish();
await tick('parts_running'); // three seats busy, one part queued
await finish();
await tick('parts_in_review');
await drain();
mark('first_tasks_through'); // iOS merged into its track; Rust waits on a merge card

// 09:40  A task that will go silent, and one that will ask.
advance(15);
const nh = task({ teamId: 'ios', assigneeId: 'nh', title: 'Nav-hang recorder', brief: 'Record every navigation hang with its stack. HANG', priority: 1 });
task({ teamId: 'ios', assigneeId: 'a3', title: 'Life as a pass stack (D-199)', brief: 'Rebuild Life as a stack of passes. ASK' });
await tick('nh_running');
await finish();
advance(11);
await tick(); // NH's lease expires; the retry starts
advance(11);
await tick('lease_card'); // expired twice: the card, the couch

// 10:10  Marketing tries to write outside its folder. C2's work is sent back once.
task({ teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write the App Store description and save a copy. OUTSIDE' });
task({ teamId: 'ios', assigneeId: 'c2', title: 'C2 Person page from the roster', brief: 'Build the Person page from the roster endpoint. REDO', gates: ['tests'] });
await tick();
await finish();
mark('c2_in_review'); // the work is committed and green; the lead has not started reviewing
await tick('review_running'); // the lead and C2 in the meeting room
await drain(0);
mark('cards_open'); // lease, question, tool, merge

// 10:40  One task is cancelled. One runs into the plan's usage limit.
advance(10);
const doomed = task({ teamId: 'rust', assigneeId: 'pl', title: 'Re-run the 29 refused plain drafts', brief: 'Re-run them. HANG', capUsd: 2 });
await tick();
sup.cancelTask(doomed.id);
await flush();
task({ teamId: 'rust', assigneeId: 'ap', title: 'Roster 503 not-ready', brief: 'Return 503, not 500, while the roster warms up. LIMIT' });
await tick();
await finish();
mark('paused'); // the usage limit: one card, everything waits
answer('usage_limit', 'resume');
await tick('resumed');
await drain();

// 11:00  The user answers the cards.
advance(10);
answer('merge', 'merge');
answer('question', 'choice2');
answer('tool', 'keep_refused');
await drain();
mark('cards_answered'); // only NH's lease card is left
void nh;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const events = readEvents(db, snapshot.lastEventId, 100_000);
const tidy = (text: string) => text.split(root).join('/tmp/story');
fs.writeFileSync(OUT, `${tidy(JSON.stringify({ snapshot, marks, events }))}\n`);
console.log(`${events.length} events, ${marks.length} marks: ${marks.map((m) => m.name).join(', ')}`);
console.log(`open cards at the end: ${store.openDecisions(db).map((d) => d.kind).join(', ') || 'none'}`);
console.log(`tasks: ${store.listTasks(db).filter((t) => t.kind === 'work').map((t) => `${t.title} [${t.state}]`).join('; ')}`);
await app.close();
await sup.stop();
db.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
