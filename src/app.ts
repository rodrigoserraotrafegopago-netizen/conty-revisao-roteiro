import type { DatabaseSync } from "node:sqlite";
import { type Context, Hono } from "hono";
import { type Clock, systemClock } from "./clock.ts";
import { DomainError } from "./errors.ts";
import { createScriptService } from "./scripts.ts";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("json_invalido", "O corpo precisa ser um JSON válido.", 400);
  }
}

export function createApp({ db, clock = systemClock }: { db: DatabaseSync; clock?: Clock }) {
  const scripts = createScriptService({ db, clock });
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json(error.toJSON(), error.status);
    console.error(error);
    return c.json({ error: "erro_interno", message: "Erro inesperado." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Criador
  app.post("/scripts", async (c) => c.json(scripts.create(await readJson(c)), 201));
  app.post("/scripts/:id/versions", async (c) =>
    c.json(scripts.submitVersion(c.req.param("id"), await readJson(c)), 201),
  );

  // Marca
  app.post("/scripts/:id/change-requests", async (c) =>
    c.json(scripts.requestChanges(c.req.param("id"), await readJson(c)), 201),
  );
  app.post("/scripts/:id/approve", (c) => c.json(scripts.approve(c.req.param("id"))));

  // Leitura
  app.get("/scripts/:id", (c) => c.json(scripts.getScript(c.req.param("id"))));
  app.get("/scripts/:id/versions/:number", (c) => {
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number < 1) {
      throw new DomainError("versao_invalida", "Número de versão inválido.", 400);
    }
    return c.json(scripts.getVersion(c.req.param("id"), number));
  });

  return app;
}
