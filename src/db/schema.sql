-- Every state table keeps a row as the JSON of its type (src/shared/types.ts), so the schema
-- cannot drift from the types. The generated columns exist only to be searched and indexed.
CREATE TABLE IF NOT EXISTS company (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  team_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.teamId')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) VIRTUAL,
  team_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.teamId')) VIRTUAL,
  parent_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.parentId')) VIRTUAL,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.updatedAt')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL,
  employee_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.employeeId')) VIRTUAL,
  outcome TEXT GENERATED ALWAYS AS (json_extract(data, '$.outcome')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS run_requests (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL,
  answered_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.answeredAt')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  to_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.toId')) VIRTUAL,
  state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) VIRTUAL,
  at TEXT GENERATED ALWAYS AS (json_extract(data, '$.at')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.taskId')) VIRTUAL
);
-- The append-only log. Rows above change only through events written here, in the same transaction.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task_id TEXT, run_id TEXT, employee_id TEXT, team_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id);
CREATE INDEX IF NOT EXISTS events_kind_at ON events (kind, at);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks (state);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
CREATE INDEX IF NOT EXISTS runs_task ON runs (task_id);
CREATE INDEX IF NOT EXISTS runs_outcome ON runs (outcome);
CREATE INDEX IF NOT EXISTS decisions_open ON decisions (answered_at);
-- The company's record: numbered decisions, and the versions handed out for each repository's contract.
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  n INTEGER GENERATED ALWAYS AS (json_extract(data, '$.n')) VIRTUAL
);
CREATE TABLE IF NOT EXISTS contract_versions (
  id TEXT PRIMARY KEY, data TEXT NOT NULL,
  repo_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.repoId')) VIRTUAL
);
