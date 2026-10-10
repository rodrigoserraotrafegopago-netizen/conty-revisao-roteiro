import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { ScriptView } from "../src/scripts.ts";

/** App com banco em memória e relógio controlado pelo teste. */
export function setup(startAt = "2026-03-10T12:00:00.000Z") {
  let current = new Date(startAt);
  const db = openDatabase(":memory:");
  const app = createApp({ db, clock: { now: () => new Date(current) } });

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    app,
    db,
    post,
    get: (path: string) => app.request(path),
    setNow(iso: string) {
      current = new Date(iso);
    },
    async createScript(content = "Gancho: 3 erros ao lavar o carro em casa.") {
      const res = await post("/scripts", { title: "Roteiro campanha lava-rápido", content });
      if (res.status !== 201) throw new Error(`falhou ao criar roteiro: ${res.status}`);
      return (await res.json()) as ScriptView;
    },
  };
}

export async function json<T = ScriptView>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
