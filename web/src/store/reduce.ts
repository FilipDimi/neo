/**
 * The screen's whole state: what the snapshot gave, plus every event since, applied by the same
 * function the engine applies to its tables. Every view is a selector over this.
 */
import type { EventRow } from '../../../src/shared/events.ts';
import { changesOf, type TableName } from '../../../src/shared/project.ts';
import type { Company, Decision, Employee, HealthReport, Message, PlanUsage, Repo, Run, RunRequest, Task, Team } from '../../../src/shared/types.ts';

export type Spend = { company: number; byTeam: Record<string, number>; byEmployee: Record<string, number> };

export type Snapshot = {
  version: number;
  company: Company | null;
  repos: Repo[];
  teams: Team[];
  employees: Employee[];
  tasks: Task[];
  runs: Run[];
  requests: RunRequest[];
  decisions: Decision[];
  messages: Message[];
  health: HealthReport | null;
  planUsage: PlanUsage | null;
  spend: Spend;
  lastEventId: number;
  now: string;
};

export type Store = {
  version: number;
  /** False while the engine cannot be reached: what is shown may be stale, and the screen says so. */
  online: boolean;
  /** The engine speaks a newer version of the events than this page understands. */
  needsReload: boolean;
  company: Company | null;
  repos: Map<string, Repo>;
  teams: Map<string, Team>;
  employees: Map<string, Employee>;
  tasks: Map<string, Task>;
  runs: Map<string, Run>;
  requests: Map<string, RunRequest>;
  decisions: Map<string, Decision>;
  messages: Map<string, Message>;
  health: HealthReport | null;
  planUsage: PlanUsage | null;
  spend: Spend;
  lastEventId: number;
  /** The id of the last event about each task, so a view of one task knows when to look again. */
  taskSeq: Record<string, number>;
};

const byId = <T extends { id: string }>(rows: T[]): Map<string, T> => new Map(rows.map((row) => [row.id, row]));

export function fromSnapshot(snapshot: Snapshot): Store {
  return {
    version: snapshot.version,
    online: true,
    needsReload: false,
    company: snapshot.company,
    repos: byId(snapshot.repos),
    teams: byId(snapshot.teams),
    employees: byId(snapshot.employees),
    tasks: byId(snapshot.tasks),
    runs: byId(snapshot.runs),
    requests: byId(snapshot.requests),
    decisions: byId(snapshot.decisions),
    messages: byId(snapshot.messages),
    health: snapshot.health,
    planUsage: snapshot.planUsage,
    spend: snapshot.spend,
    lastEventId: snapshot.lastEventId,
    taskSeq: {},
  };
}

type MapTable = 'repos' | 'teams' | 'employees' | 'tasks' | 'runs' | 'requests' | 'decisions' | 'messages';
const MAPS: Partial<Record<TableName, MapTable>> = { repos: 'repos', teams: 'teams', employees: 'employees', tasks: 'tasks', runs: 'runs', run_requests: 'requests', decisions: 'decisions', messages: 'messages' };
/** Rows an event of a kind this page does not know may still carry, by the field that carries them. */
const CARRIED: Record<string, MapTable> = { repo: 'repos', team: 'teams', employee: 'employees', task: 'tasks', run: 'runs', request: 'requests', decision: 'decisions', message: 'messages' };
const KNOWN = new Set(['company_changed', 'repo_changed', 'team_changed', 'employee_changed', 'task_changed', 'run_requested', 'request_dropped', 'run_started', 'run_activity', 'run_event', 'gate_started', 'gate_finished', 'run_ended', 'decision_raised', 'decision_answered', 'message_sent', 'message_delivered', 'grant_changed', 'health_changed', 'plan_usage']);

export function reduce(store: Store, row: EventRow): Store {
  if (row.id <= store.lastEventId) return store; // already applied: a replay overlapped the snapshot
  const next: Store = { ...store, lastEventId: row.id, taskSeq: row.taskId ? { ...store.taskSeq, [row.taskId]: row.id } : store.taskSeq };
  const copied = new Set<MapTable>();
  const put = (table: MapTable, id: string, value: object | null) => {
    if (!copied.has(table)) {
      (next[table] as Map<string, unknown>) = new Map(next[table] as Map<string, unknown>);
      copied.add(table);
    }
    if (value === null) next[table].delete(id);
    else (next[table] as Map<string, unknown>).set(id, value);
  };

  const event = row.event as { kind: string } & Record<string, unknown>;
  if (!KNOWN.has(event.kind)) {
    // A newer engine: take the rows we recognise and leave the rest.
    for (const [field, table] of Object.entries(CARRIED)) {
      const carried = event[field] as { id?: unknown } | undefined;
      if (carried && typeof carried === 'object' && typeof carried.id === 'string') put(table, carried.id, carried);
    }
    if (event.company && typeof event.company === 'object') next.company = event.company as Company;
    return next;
  }

  for (const change of changesOf(row, (table, id) => (table === 'company' ? (store.company ?? undefined) : MAPS[table] ? store[MAPS[table]!].get(id) : undefined))) {
    const table = MAPS[change.table];
    if (table) put(table, change.id, change.row);
    else if (change.table === 'company') next.company = change.row as Company | null;
    else if (change.table === 'meta' && change.id === 'health') next.health = change.row as HealthReport;
    else if (change.table === 'meta' && change.id === 'planUsage') next.planUsage = change.row as PlanUsage;
  }
  if (row.event.kind === 'run_event' && row.event.event.kind === 'usage') {
    const { costUsd } = row.event.event;
    const { teamId, employeeId } = row.event;
    next.spend = {
      company: store.spend.company + costUsd,
      byTeam: { ...store.spend.byTeam, [teamId]: (store.spend.byTeam[teamId] ?? 0) + costUsd },
      byEmployee: { ...store.spend.byEmployee, [employeeId]: (store.spend.byEmployee[employeeId] ?? 0) + costUsd },
    };
  }
  return next;
}
