import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { BRAND_TIMEZONE, civilDate, describeDueDate, isValidCivilDate, isWithinDueDate } from "./deadline.ts";
import { DomainError } from "./errors.ts";
import { type Actor, allowedActions, assertCanTransition, type ScriptStatus } from "./workflow.ts";

type ScriptRow = {
  id: string;
  title: string;
  status: ScriptStatus;
  current_version: number;
  timezone: string;
  created_at: string;
  approved_at: string | null;
};

type VersionRow = {
  script_id: string;
  number: number;
  content: string;
  status: ScriptStatus;
  submitted_at: string;
};

type ChangeRequestRow = {
  id: string;
  script_id: string;
  version_number: number;
  reason: string;
  due_date: string;
  requested_at: string;
  answered_by_version: number | null;
  answered_at: string | null;
  answered_late: number | null;
  replaced_at: string | null;
  replaced_by: string | null;
};

type EventRow = {
  seq: number;
  type: string;
  actor: Actor;
  version_number: number;
  at: string;
  detail: string | null;
};

const MAX_TITLE = 200;
const MAX_CONTENT = 20_000;
const MAX_REASON = 2_000;

export type ChangeRequestView = {
  id: string;
  version: number;
  reason: string;
  due_date: string;
  due_rule: string;
  requested_at: string;
  answered_by_version: number | null;
  answered_at: string | null;
  answered_on_time: boolean | null;
  overdue: boolean;
  replaced_at: string | null;
  replaced_by: string | null;
};

export type VersionView = {
  number: number;
  status: ScriptStatus;
  submitted_at: string;
  content: string;
  change_request: ChangeRequestView | null;
};

export type ScriptView = {
  id: string;
  title: string;
  status: ScriptStatus;
  timezone: string;
  current_version: number;
  created_at: string;
  approved_at: string | null;
  allowed_actions: ReturnType<typeof allowedActions>;
  open_change_request: ChangeRequestView | null;
  versions: VersionView[];
  change_requests: ChangeRequestView[];
  history: Array<{
    seq: number;
    type: string;
    actor: Actor;
    version: number;
    at: string;
    detail: Record<string, unknown> | null;
  }>;
};

function invalid(code: string, message: string): never {
  throw new DomainError(code, message, 422);
}

function field(input: unknown, name: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[name] : undefined;
}

function requireText(value: unknown, field: { name: string; label: string; max: number }): string {
  if (typeof value !== "string" || value.trim() === "")
    invalid(`${field.name}_obrigatorio`, `${field.label} é obrigatório.`);
  if (value.length > field.max)
    invalid(`${field.name}_muito_longo`, `${field.label} passa de ${field.max} caracteres.`);
  return value;
}

const TITLE = { name: "titulo", label: "O título", max: MAX_TITLE };
const CONTENT = { name: "conteudo", label: "O conteúdo", max: MAX_CONTENT };
const REASON = { name: "motivo", label: "O motivo", max: MAX_REASON };

export function createScriptService({
  db,
  clock,
  newId = () => crypto.randomUUID(),
}: {
  db: DatabaseSync;
  clock: Clock;
  newId?: () => string;
}) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function loadScript(id: string): ScriptRow {
    const row = db.prepare("SELECT * FROM scripts WHERE id = ?").get(id) as ScriptRow | undefined;
    if (!row) throw new DomainError("roteiro_nao_encontrado", "Roteiro não encontrado.", 404);
    return row;
  }

  function conflict(): DomainError {
    return new DomainError("conflito", "O roteiro mudou de estado durante a operação. Consulte e tente de novo.", 409);
  }

  // UPDATE condicionado ao estado esperado: se outra requisição mudou o roteiro antes, esta falha em vez de sobrescrever.
  // Vem primeiro em cada transação, antes de qualquer outra escrita.
  function moveScript(
    id: string,
    from: ScriptStatus,
    to: ScriptStatus,
    extra: { currentVersion?: number; approvedAt?: string } = {},
  ) {
    const result = db
      .prepare(
        `UPDATE scripts
            SET status = ?, current_version = COALESCE(?, current_version), approved_at = COALESCE(?, approved_at)
          WHERE id = ? AND status = ?`,
      )
      .run(to, extra.currentVersion ?? null, extra.approvedAt ?? null, id, from);
    if (Number(result.changes) !== 1) throw conflict();
  }

  function recordEvent(
    scriptId: string,
    type: string,
    actor: Actor,
    version: number,
    at: string,
    detail?: Record<string, unknown>,
  ) {
    db.prepare(
      "INSERT INTO script_events (script_id, type, actor, version_number, at, detail) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(scriptId, type, actor, version, at, detail ? JSON.stringify(detail) : null);
  }

  function isOverdue(row: ChangeRequestRow, timeZone: string): boolean {
    const open = row.answered_by_version === null && row.replaced_at === null;
    return open && !isWithinDueDate(row.due_date, clock.now(), timeZone);
  }

  function activeChangeRequest(scriptId: string, version: number): ChangeRequestRow | undefined {
    return db
      .prepare("SELECT * FROM change_requests WHERE script_id = ? AND version_number = ? AND replaced_at IS NULL")
      .get(scriptId, version) as ChangeRequestRow | undefined;
  }

  // Pedido aberto da versão atual e se o prazo dele já venceu (aí a marca pode trocá-lo).
  function openRequestOf(script: ScriptRow): { row: ChangeRequestRow | undefined; overdue: boolean } {
    const row =
      script.status === "changes_requested" ? activeChangeRequest(script.id, script.current_version) : undefined;
    return { row, overdue: row !== undefined && isOverdue(row, script.timezone) };
  }

  function toChangeRequestView(row: ChangeRequestRow, timeZone: string): ChangeRequestView {
    return {
      id: row.id,
      version: row.version_number,
      reason: row.reason,
      due_date: row.due_date,
      due_rule: describeDueDate(row.due_date, timeZone),
      requested_at: row.requested_at,
      answered_by_version: row.answered_by_version,
      answered_at: row.answered_at,
      answered_on_time: row.answered_late === null ? null : row.answered_late === 0,
      overdue: isOverdue(row, timeZone),
      replaced_at: row.replaced_at,
      replaced_by: row.replaced_by,
    };
  }

  function getScript(id: string): ScriptView {
    const script = loadScript(id);
    const versions = db
      .prepare("SELECT * FROM script_versions WHERE script_id = ? ORDER BY number")
      .all(id) as VersionRow[];
    const changeRequests = db
      .prepare("SELECT * FROM change_requests WHERE script_id = ? ORDER BY requested_at, rowid")
      .all(id) as ChangeRequestRow[];
    const events = db
      .prepare(
        "SELECT seq, type, actor, version_number, at, detail FROM script_events WHERE script_id = ? ORDER BY seq",
      )
      .all(id) as EventRow[];

    const views = changeRequests.map((cr) => toChangeRequestView(cr, script.timezone));
    const byVersion = new Map(views.filter((cr) => cr.replaced_at === null).map((cr) => [cr.version, cr]));
    const open = script.status === "changes_requested" ? (byVersion.get(script.current_version) ?? null) : null;
    return {
      id: script.id,
      title: script.title,
      status: script.status,
      timezone: script.timezone,
      current_version: script.current_version,
      created_at: script.created_at,
      approved_at: script.approved_at,
      allowed_actions: allowedActions(script.status, open?.overdue ?? false),
      open_change_request: open,
      versions: versions.map((v) => ({
        number: v.number,
        status: v.status,
        submitted_at: v.submitted_at,
        content: v.content,
        change_request: byVersion.get(v.number) ?? null,
      })),
      change_requests: views,
      history: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        actor: e.actor,
        version: e.version_number,
        at: e.at,
        detail: e.detail ? (JSON.parse(e.detail) as Record<string, unknown>) : null,
      })),
    };
  }

  return {
    getScript,

    getVersion(id: string, number: number): VersionView {
      const view = getScript(id);
      const version = view.versions.find((v) => v.number === number);
      if (!version) throw new DomainError("versao_nao_encontrada", "Versão não encontrada.", 404);
      return version;
    },

    create(input: unknown): ScriptView {
      const title = requireText(field(input, "title"), TITLE).trim();
      const content = requireText(field(input, "content"), CONTENT);
      const id = newId();
      const now = clock.now().toISOString();

      transaction(() => {
        db.prepare(
          "INSERT INTO scripts (id, title, status, current_version, timezone, created_at) VALUES (?, ?, 'in_review', 1, ?, ?)",
        ).run(id, title, BRAND_TIMEZONE, now);
        db.prepare(
          "INSERT INTO script_versions (script_id, number, content, status, submitted_at) VALUES (?, 1, ?, 'in_review', ?)",
        ).run(id, content, now);
        recordEvent(id, "version_submitted", "creator", 1, now);
      });
      return getScript(id);
    },

    requestChanges(id: string, input: unknown): ScriptView {
      const script = loadScript(id);
      const { row: current, overdue: renewing } = openRequestOf(script);
      const next = assertCanTransition(script.status, "request_changes", renewing);

      const reason = requireText(field(input, "reason"), REASON).trim();
      const dueDate = field(input, "due_date");
      if (dueDate === undefined || dueDate === null || (typeof dueDate === "string" && dueDate.trim() === "")) {
        invalid("prazo_obrigatorio", "O prazo é obrigatório.");
      }
      if (typeof dueDate !== "string" || !isValidCivilDate(dueDate)) {
        invalid("prazo_invalido", "O prazo é um dia no formato AAAA-MM-DD, por exemplo 2026-03-12.");
      }

      const nowInstant = clock.now();
      if (!isWithinDueDate(dueDate, nowInstant, script.timezone)) {
        throw new DomainError(
          "prazo_vencido",
          `O prazo ${dueDate} já passou em ${script.timezone}. Hoje lá é ${civilDate(nowInstant, script.timezone)}.`,
          422,
        );
      }

      const now = nowInstant.toISOString();
      const changeRequestId = newId();
      transaction(() => {
        moveScript(id, script.status, next);
        if (renewing && current) {
          // Na troca o estado não muda; quem garante que ninguém trocou ou respondeu antes é esta condição.
          const replaced = db
            .prepare(
              `UPDATE change_requests SET replaced_at = ?, replaced_by = ?
                WHERE id = ? AND replaced_at IS NULL AND answered_by_version IS NULL`,
            )
            .run(now, changeRequestId, current.id);
          if (Number(replaced.changes) !== 1) throw conflict();
        }
        db.prepare(
          "INSERT INTO change_requests (id, script_id, version_number, reason, due_date, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(changeRequestId, id, script.current_version, reason, dueDate, now);
        db.prepare("UPDATE script_versions SET status = 'changes_requested' WHERE script_id = ? AND number = ?").run(
          id,
          script.current_version,
        );
        recordEvent(
          id,
          renewing ? "change_request_renewed" : "changes_requested",
          "brand",
          script.current_version,
          now,
          {
            change_request_id: changeRequestId,
            reason,
            due_date: dueDate,
            ...(renewing && current ? { replaces: current.id } : {}),
          },
        );
      });
      return getScript(id);
    },

    submitVersion(id: string, input: unknown): ScriptView {
      const script = loadScript(id);
      const next = assertCanTransition(script.status, "submit_version");
      const content = requireText(field(input, "content"), CONTENT);

      const openRequest = activeChangeRequest(id, script.current_version);
      if (!openRequest) throw new Error(`roteiro ${id} em changes_requested sem pedido de alteração`);

      const nowInstant = clock.now();
      const now = nowInstant.toISOString();
      const onTime = isWithinDueDate(openRequest.due_date, nowInstant, script.timezone);
      const number = script.current_version + 1;

      transaction(() => {
        moveScript(id, script.status, next, { currentVersion: number });
        const answered = db
          .prepare(
            `UPDATE change_requests SET answered_by_version = ?, answered_at = ?, answered_late = ?
              WHERE id = ? AND replaced_at IS NULL AND answered_by_version IS NULL`,
          )
          .run(number, now, onTime ? 0 : 1, openRequest.id);
        if (Number(answered.changes) !== 1) throw conflict();
        db.prepare(
          "INSERT INTO script_versions (script_id, number, content, status, submitted_at) VALUES (?, ?, ?, 'in_review', ?)",
        ).run(id, number, content, now);
        recordEvent(id, "version_submitted", "creator", number, now, {
          answers_change_request: openRequest.id,
          on_time: onTime,
        });
      });
      return getScript(id);
    },

    approve(id: string): ScriptView {
      const script = loadScript(id);
      const next = assertCanTransition(script.status, "approve", openRequestOf(script).overdue);
      const now = clock.now().toISOString();

      transaction(() => {
        moveScript(id, script.status, next, { approvedAt: now });
        db.prepare("UPDATE script_versions SET status = 'approved' WHERE script_id = ? AND number = ?").run(
          id,
          script.current_version,
        );
        recordEvent(id, "approved", "brand", script.current_version, now);
      });
      return getScript(id);
    },
  };
}
