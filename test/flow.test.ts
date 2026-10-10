import { describe, expect, it } from "vitest";
import type { VersionView } from "../src/scripts.ts";
import { json, setup } from "./helpers.ts";

const LAST_INSTANT_OF_MARCH_12_SP = "2026-03-13T02:59:59.999Z"; // 23:59:59.999 de 12/03 em São Paulo
const FIRST_INSTANT_OF_MARCH_13_SP = "2026-03-13T03:00:00.000Z"; // 00:00:00.000 de 13/03 em São Paulo

describe("fluxo de revisão", () => {
  it("segue envio, pedido de alteração, reenvio e aprovação com o estado sempre explícito", async () => {
    const t = setup();
    const created = await t.createScript("Versão 1");
    expect(created.status).toBe("in_review");
    expect(created.current_version).toBe(1);
    expect(created.allowed_actions).toEqual({ brand: ["request_changes", "approve"], creator: [] });

    const requested = await json(
      await t.post(`/scripts/${created.id}/change-requests`, {
        reason: "Trocar o gancho: começar mostrando o produto.",
        due_date: "2026-03-12",
      }),
    );
    expect(requested.status).toBe("changes_requested");
    expect(requested.allowed_actions).toEqual({ brand: [], creator: ["submit_version"] });
    expect(requested.open_change_request).toMatchObject({
      version: 1,
      reason: "Trocar o gancho: começar mostrando o produto.",
      due_date: "2026-03-12",
      answered_by_version: null,
    });

    t.setNow("2026-03-11T15:00:00.000Z");
    const resubmitted = await json(await t.post(`/scripts/${created.id}/versions`, { content: "Versão 2" }));
    expect(resubmitted.status).toBe("in_review");
    expect(resubmitted.current_version).toBe(2);
    expect(resubmitted.open_change_request).toBeNull();
    expect(resubmitted.versions[0]?.change_request).toMatchObject({ answered_by_version: 2, answered_on_time: true });

    const approved = await json(await t.post(`/scripts/${created.id}/approve`));
    expect(approved.status).toBe("approved");
    expect(approved.approved_at).toBe("2026-03-11T15:00:00.000Z");
    expect(approved.allowed_actions).toEqual({ brand: [], creator: [] });
    expect(approved.versions.map((v) => [v.number, v.status])).toEqual([
      [1, "changes_requested"],
      [2, "approved"],
    ]);
    expect(approved.history.map((e) => [e.type, e.actor, e.version])).toEqual([
      ["version_submitted", "creator", 1],
      ["changes_requested", "brand", 1],
      ["version_submitted", "creator", 2],
      ["approved", "brand", 2],
    ]);
  });

  it("guarda a versão antiga quando chega uma nova", async () => {
    const t = setup();
    const script = await t.createScript("Texto original da versão 1");
    await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: "2026-03-12" });
    await t.post(`/scripts/${script.id}/versions`, { content: "Texto da versão 2" });

    const v1 = await json<VersionView>(await t.get(`/scripts/${script.id}/versions/1`));
    expect(v1.content).toBe("Texto original da versão 1");
    expect(v1.status).toBe("changes_requested");
    expect(v1.change_request?.reason).toBe("Encurtar");

    const v2 = await json<VersionView>(await t.get(`/scripts/${script.id}/versions/2`));
    expect(v2.content).toBe("Texto da versão 2");
    expect(v2.status).toBe("in_review");
  });
});

describe("pedido de alteração", () => {
  it("sem motivo não passa", async () => {
    const t = setup();
    const script = await t.createScript();
    for (const body of [{ due_date: "2026-03-12" }, { reason: "   ", due_date: "2026-03-12" }]) {
      const res = await t.post(`/scripts/${script.id}/change-requests`, body);
      expect(res.status).toBe(422);
      expect((await json<{ error: string }>(res)).error).toBe("motivo_obrigatorio");
    }
    expect((await json(await t.get(`/scripts/${script.id}`))).status).toBe("in_review");
  });

  it("sem prazo, ou com prazo que não é um dia válido, não passa", async () => {
    const t = setup();
    const script = await t.createScript();
    const cases: Array<[unknown, string]> = [
      [undefined, "prazo_obrigatorio"],
      ["", "prazo_obrigatorio"],
      ["12/03/2026", "prazo_invalido"],
      ["2026-02-30", "prazo_invalido"],
      ["2026-03-12T23:59:00Z", "prazo_invalido"],
      [20260312, "prazo_invalido"],
    ];
    for (const [dueDate, code] of cases) {
      const res = await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: dueDate });
      expect(res.status).toBe(422);
      expect((await json<{ error: string }>(res)).error).toBe(code);
    }
    const after = await json(await t.get(`/scripts/${script.id}`));
    expect(after.status).toBe("in_review");
    expect(after.versions[0]?.change_request).toBeNull();
  });

  it("com prazo no dia de hoje vale até o último instante do dia em São Paulo, com o UTC já no dia seguinte", async () => {
    const t = setup();
    const script = await t.createScript();
    t.setNow(LAST_INSTANT_OF_MARCH_12_SP);
    const res = await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: "2026-03-12" });
    expect(res.status).toBe(201);
    expect((await json(res)).status).toBe("changes_requested");
  });

  it("com prazo que já passou não vale, a partir do primeiro instante do dia seguinte", async () => {
    const t = setup();
    const script = await t.createScript();
    t.setNow(FIRST_INSTANT_OF_MARCH_13_SP);
    const res = await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: "2026-03-12" });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ error: "prazo_vencido" });
    expect((await json(await t.get(`/scripts/${script.id}`))).status).toBe("in_review");
  });

  it("não abre um segundo pedido enquanto o primeiro espera o criador", async () => {
    const t = setup();
    const script = await t.createScript();
    await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: "2026-03-12" });
    const res = await t.post(`/scripts/${script.id}/change-requests`, {
      reason: "Outra coisa",
      due_date: "2026-03-12",
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "transicao_invalida", status: "changes_requested" });
  });
});

describe("reenvio do criador", () => {
  async function scriptWaitingCreator(dueDate: string) {
    const t = setup();
    const script = await t.createScript();
    await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: dueDate });
    return { t, id: script.id };
  }

  it("no último instante do dia do prazo conta como dentro do prazo", async () => {
    const { t, id } = await scriptWaitingCreator("2026-03-12");
    t.setNow(LAST_INSTANT_OF_MARCH_12_SP);
    const body = await json(await t.post(`/scripts/${id}/versions`, { content: "Versão 2" }));
    expect(body.versions[0]?.change_request?.answered_on_time).toBe(true);
  });

  it("no primeiro instante do dia seguinte é registrado como fora do prazo", async () => {
    const { t, id } = await scriptWaitingCreator("2026-03-12");
    t.setNow(FIRST_INSTANT_OF_MARCH_13_SP);
    const body = await json(await t.post(`/scripts/${id}/versions`, { content: "Versão 2" }));
    expect(body.status).toBe("in_review");
    expect(body.versions[0]?.change_request?.answered_on_time).toBe(false);
    expect(body.history.at(-1)?.detail).toMatchObject({ on_time: false });
  });

  it("não manda versão nova sem pedido de alteração", async () => {
    const t = setup();
    const script = await t.createScript();
    const res = await t.post(`/scripts/${script.id}/versions`, { content: "Versão 2 sem pedido" });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "transicao_invalida", status: "in_review" });
    expect((await json(await t.get(`/scripts/${script.id}`))).versions).toHaveLength(1);
  });
});

describe("aprovação", () => {
  it("encerra a revisão: roteiro aprovado não aceita nova versão, novo pedido nem nova aprovação", async () => {
    const t = setup();
    const script = await t.createScript();
    expect((await t.post(`/scripts/${script.id}/approve`)).status).toBe(200);

    const attempts = [
      () => t.post(`/scripts/${script.id}/versions`, { content: "Versão 2" }),
      () => t.post(`/scripts/${script.id}/change-requests`, { reason: "Mudei de ideia", due_date: "2026-03-12" }),
      () => t.post(`/scripts/${script.id}/approve`),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ error: "roteiro_aprovado", status: "approved" });
    }

    const after = await json(await t.get(`/scripts/${script.id}`));
    expect(after.status).toBe("approved");
    expect(after.versions).toHaveLength(1);
    expect(after.history.map((e) => e.type)).toEqual(["version_submitted", "approved"]);
  });

  it("não aprova versão que tem pedido de alteração aberto", async () => {
    const t = setup();
    const script = await t.createScript();
    await t.post(`/scripts/${script.id}/change-requests`, { reason: "Encurtar", due_date: "2026-03-12" });
    const res = await t.post(`/scripts/${script.id}/approve`);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "transicao_invalida", status: "changes_requested" });
  });

  it("o banco também recusa reabrir roteiro aprovado ou reescrever versão", async () => {
    const t = setup();
    const script = await t.createScript();
    await t.post(`/scripts/${script.id}/approve`);
    expect(() => t.db.prepare("UPDATE scripts SET status = 'in_review' WHERE id = ?").run(script.id)).toThrow(
      /aprovado não reabre/,
    );
    expect(() =>
      t.db.prepare("UPDATE script_versions SET content = 'outro' WHERE script_id = ?").run(script.id),
    ).toThrow(/imutável/);
  });
});

describe("erros de entrada", () => {
  it("responde 404 para roteiro inexistente", async () => {
    const t = setup();
    expect((await t.get("/scripts/nao-existe")).status).toBe(404);
    expect((await t.post("/scripts/nao-existe/approve")).status).toBe(404);
  });

  it("recusa roteiro sem conteúdo e corpo que não é JSON", async () => {
    const t = setup();
    const empty = await t.post("/scripts", { title: "Sem conteúdo", content: "  " });
    expect(empty.status).toBe(422);
    const notJson = await t.app.request("/scripts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
  });
});
