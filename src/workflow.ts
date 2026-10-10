import { DomainError } from "./errors.ts";

//   in_review ──request_changes──▶ changes_requested ──submit_version──▶ in_review
//   in_review ──approve──────────▶ approved (final)

export type ScriptStatus = "in_review" | "changes_requested" | "approved";
export type Action = "request_changes" | "approve" | "submit_version";
export type Actor = "brand" | "creator";

export const ACTIONS: Record<Action, { actor: Actor; from: ScriptStatus; to: ScriptStatus }> = {
  request_changes: { actor: "brand", from: "in_review", to: "changes_requested" },
  approve: { actor: "brand", from: "in_review", to: "approved" },
  submit_version: { actor: "creator", from: "changes_requested", to: "in_review" },
};

export function allowedActions(status: ScriptStatus): Record<Actor, Action[]> {
  const allowed: Record<Actor, Action[]> = { brand: [], creator: [] };
  for (const action of Object.keys(ACTIONS) as Action[]) {
    const rule = ACTIONS[action];
    if (rule.from === status) allowed[rule.actor].push(action);
  }
  return allowed;
}

const BLOCKED_MESSAGES: Partial<Record<`${ScriptStatus}:${Action}`, string>> = {
  "in_review:submit_version":
    "O roteiro está com a marca para revisão. Nova versão só depois de um pedido de alteração.",
  "changes_requested:request_changes": "Já existe um pedido de alteração aberto, aguardando a nova versão do criador.",
  "changes_requested:approve":
    "A versão atual tem pedido de alteração aberto. A marca aprova depois que o criador reenviar.",
};

export function assertCanTransition(status: ScriptStatus, action: Action): ScriptStatus {
  const rule = ACTIONS[action];
  if (rule.from === status) return rule.to;

  if (status === "approved") {
    throw new DomainError(
      "roteiro_aprovado",
      "Roteiro aprovado encerra a revisão: não aceita nova versão, novo pedido de alteração nem nova aprovação.",
      409,
      { status, allowed_actions: allowedActions(status) },
    );
  }
  throw new DomainError(
    "transicao_invalida",
    BLOCKED_MESSAGES[`${status}:${action}`] ?? `A ação ${action} não vale no estado ${status}.`,
    409,
    { status, allowed_actions: allowedActions(status) },
  );
}
