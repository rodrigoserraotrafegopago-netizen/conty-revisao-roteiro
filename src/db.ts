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
  replaced_at TEXT,
  replaced_by TEXT
);
-- Um pedido ativo por versão; o substituído (prazo vencido) continua guardado.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_change_request_per_version
  ON change_requests (script_id, version_number) WHERE replaced_at IS NULL;

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

// Sem migrations: o schema tem versão, e um banco criado por outra versão é recusado com uma mensagem clara
// (em vez de falhar no meio de uma requisição).
const SCHEMA_VERSION = 2;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Outra conexão no mesmo arquivo espera a vez (até 5 s) em vez de falhar na hora com "database is locked".
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const empty = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get() === undefined;
  if (!empty && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${path} foi criado por outra versão do schema (${version}; esta é a ${SCHEMA_VERSION}). Não há migrations: apague o arquivo ou use outro DB_PATH.`,
    );
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
