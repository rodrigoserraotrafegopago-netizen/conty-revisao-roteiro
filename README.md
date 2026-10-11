# Revisão de roteiro

[![ci](https://github.com/rodrigoserraotrafegopago-netizen/conty-revisao-roteiro/actions/workflows/ci.yml/badge.svg)](https://github.com/rodrigoserraotrafegopago-netizen/conty-revisao-roteiro/actions/workflows/ci.yml)

API do ciclo de roteiro entre criador e marca: o criador envia, a marca pede alteração (com motivo e prazo) ou aprova, o criador reenvia. Cada versão fica guardada com o próprio estado.

Node 22.13+ · TypeScript · Hono · SQLite (`node:sqlite`) · Vitest

```bash
npm install
npm test            # 26 testes
npm run dev         # http://127.0.0.1:3003
```

`npm run lint` e `npm run typecheck` também rodam no CI. Variáveis opcionais em `.env.example` (o `.env` é lido se existir).

## Estados

```
in_review ──request_changes (marca)──▶ changes_requested ──submit_version (criador)──▶ in_review
in_review ──approve (marca)──────────▶ approved
changes_requested, prazo vencido ──request_changes (marca)──▶ changes_requested, com novo pedido
```

`approved` é final. A máquina de estados está em `src/workflow.ts`. Toda resposta de roteiro traz `status`, `allowed_actions` por papel, o pedido de alteração aberto, todas as versões e o histórico, então quem consome a API não precisa deduzir o estado. Ação fora de hora devolve `409` com o estado atual e o que é permitido.

## Prazo

O prazo é um dia (`AAAA-MM-DD`) no fuso da marca, `America/Sao_Paulo`, e vale até 23:59:59.999 desse dia. A comparação é feita entre dias civis em São Paulo (`src/deadline.ts`): `2026-03-13T02:59:59.999Z` ainda é 12/03 lá, então o prazo `2026-03-12` vale; `2026-03-13T03:00:00.000Z` já não.

- Pedido de alteração sem motivo, sem prazo, com data inexistente ou com prazo vencido: `422`, nada muda.
- Pedido cujo prazo venceu continua aberto, mas vencido: aparece com `overdue: true`, o criador ainda pode respondê-lo e a marca pode trocá-lo por um novo, com outro prazo. O vencido fica guardado como substituído (`replaced_by`), e o histórico registra `change_request_renewed`. Antes de vencer, trocar o pedido devolve `409`.
- O criador ainda pode reenviar depois do prazo. A versão é aceita e marcada como fora do prazo (`answered_on_time: false`), para o roteiro não travar.

O relógio é injetado (`src/clock.ts`), e os testes cobrem exatamente esses dois instantes.

## Endpoints

| Método | Rota | Quem | |
| --- | --- | --- | --- |
| `POST` | `/scripts` | criador | cria o roteiro com a versão 1 |
| `POST` | `/scripts/:id/change-requests` | marca | `{ reason, due_date }` |
| `POST` | `/scripts/:id/versions` | criador | `{ content }` |
| `POST` | `/scripts/:id/approve` | marca | aprova a versão atual |
| `GET` | `/scripts/:id` | — | estado completo |
| `GET` | `/scripts/:id/versions/:n` | — | uma versão |

Erros seguem `{ "error": "<código>", "message": "<texto>" }`.

## Exemplos

Respostas reais, com campos repetidos cortados (`…`).

```bash
curl -s -X POST localhost:3003/scripts -H 'content-type: application/json' \
  -d '{"title":"Roteiro campanha protetor solar","content":"Gancho: você passa protetor do jeito errado."}'
```

```json
{
  "id": "f0c49ca3-547a-4ce0-a9b1-51e1368933e6",
  "status": "in_review",
  "current_version": 1,
  "allowed_actions": { "brand": ["request_changes", "approve"], "creator": [] },
  "open_change_request": null,
  "versions": [{ "number": 1, "status": "in_review", "content": "Gancho: você passa protetor do jeito errado.", "change_request": null }],
  "…": "…"
}
```

Pedido de alteração:

```bash
curl -s -X POST localhost:3003/scripts/$ID/change-requests -H 'content-type: application/json' \
  -d '{"reason":"Mostrar o produto nos 3 primeiros segundos.","due_date":"2026-12-31"}'
```

```json
{
  "status": "changes_requested",
  "allowed_actions": { "brand": [], "creator": ["submit_version"] },
  "open_change_request": {
    "version": 1,
    "reason": "Mostrar o produto nos 3 primeiros segundos.",
    "due_date": "2026-12-31",
    "due_rule": "vale até 23:59:59.999 de 2026-12-31 em America/Sao_Paulo",
    "answered_by_version": null
  },
  "…": "…"
}
```

Sem motivo, ou com prazo vencido, a resposta é `422`:

```json
{ "error": "motivo_obrigatorio", "message": "O motivo é obrigatório." }
```

```json
{ "error": "prazo_vencido", "message": "O prazo 2026-01-10 já passou em America/Sao_Paulo. Hoje lá é 2026-10-09." }
```

Depois do reenvio e da aprovação, a versão 1 continua lá, com o pedido que a fez mudar:

```json
{
  "status": "approved",
  "current_version": 2,
  "allowed_actions": { "brand": [], "creator": [] },
  "versions": [
    { "number": 1, "status": "changes_requested", "change_request": { "answered_by_version": 2, "answered_on_time": true, "…": "…" }, "…": "…" },
    { "number": 2, "status": "approved", "content": "Gancho: o protetor aparece logo no primeiro segundo.", "…": "…" }
  ],
  "history": [
    { "type": "version_submitted", "actor": "creator", "version": 1 },
    { "type": "changes_requested", "actor": "brand", "version": 1 },
    { "type": "version_submitted", "actor": "creator", "version": 2 },
    { "type": "approved", "actor": "brand", "version": 2 }
  ]
}
```

Nova versão num roteiro aprovado (`409`):

```json
{
  "error": "roteiro_aprovado",
  "message": "Roteiro aprovado encerra a revisão: não aceita nova versão, novo pedido de alteração nem nova aprovação.",
  "status": "approved",
  "allowed_actions": { "brand": [], "creator": [] }
}
```

## Decisões

- Reenvio atrasado é aceito e marcado, em vez de bloqueado; com o pedido vencido, a marca também tem saída (trocar o pedido). Ninguém fica preso esperando o outro.
- A marca não aprova com pedido de alteração aberto: espera o reenvio ou troca o pedido depois do prazo. Um "cancelar pedido" explícito seria o próximo passo.
- Aprovar de novo devolve `409`, não `200`. Para retry de rede, o certo seria `Idempotency-Key` nos `POST`.
- O banco também protege as regras principais: triggers impedem alterar o conteúdo de uma versão e reabrir um roteiro aprovado, e um índice único deixa só um pedido ativo por versão.
- Cada escrita começa pelo `UPDATE` condicionado ao estado lido. Se outra requisição mudou o roteiro antes (inclusive trocando ou respondendo o mesmo pedido), a resposta é `409 conflito`, e nada é gravado.
- Sem migrations: o schema tem versão (`PRAGMA user_version`), e um banco criado por uma versão anterior é recusado na subida, com a instrução de apagar o arquivo.

## Com mais tempo

- Autenticação: hoje o papel (marca ou criador) é implícito na rota.
- Fuso vindo do cadastro da marca (hoje é fixo em `America/Sao_Paulo`).
- Migrations versionadas no lugar de `CREATE TABLE IF NOT EXISTS`.
- Aviso de prazo chegando e paginação do histórico.

## Uso de IA

O código, os testes e esta documentação foram escritos com o Claude (Anthropic), a partir das minhas instruções. Acompanhei a sessão, defini o escopo e aprovei a publicação. Não revisei o código linha a linha.
