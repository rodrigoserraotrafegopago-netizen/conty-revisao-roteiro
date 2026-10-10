import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_review', 'changes_requested', 'approved')),
  current_version INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS script_versions (
  script_id TEXT NOT NULL REFERENCES scripts(id),
  number INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_review', 'changes_requested', 'approved')),
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (script_id, number)
);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  version_number INTEGER NOT NULL,
  reason TEXT NOT NULL,
  due_date TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  answered_by_version INTEGER,
  answered_at TEXT,
  answered_late INTEGER,
  UNIQUE (script_id, version_number)
);

CREATE TABLE IF NOT EXISTS script_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  at TEXT NOT NULL,
  detail TEXT
);

-- Além da regra no código: versão enviada não muda nem some, e roteiro aprovado não muda de estado.
CREATE TRIGGER IF NOT EXISTS script_versions_content_is_immutable
BEFORE UPDATE OF content ON script_versions
BEGIN
  SELECT RAISE(ABORT, 'conteúdo de versão é imutável');
END;

CREATE TRIGGER IF NOT EXISTS script_versions_are_never_deleted
BEFORE DELETE ON script_versions
BEGIN
  SELECT RAISE(ABORT, 'versão de roteiro não é apagada');
END;

CREATE TRIGGER IF NOT EXISTS approved_script_never_reopens
BEFORE UPDATE OF status ON scripts
WHEN OLD.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'roteiro aprovado não reabre');
END;
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
