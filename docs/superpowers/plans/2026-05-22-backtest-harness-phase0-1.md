# Backtest Harness — Fase 0 + Fase 1 — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subir a captura de profundidade de orderbook (Fase 0) e extrair a lógica per-tick do `index5m.js` para um módulo puro `pipeline5m` compartilhado por bot live e backtest (Fase 1).

**Architecture:** Fase 0 grava `logs/orderbook_5m.jsonl` (top-10 níveis, dedup, rotação diária gzip, retenção 90 dias) sem impacto no poll. Fase 1 move o cálculo de indicadores + scoring + edge + decide para `src/backtest/pipeline5m.js` como função pura; `index5m.js` passa a montar um `TickContext` e chamar `runPipeline5m`. Um golden test prova que o pipeline extraído reproduz o comportamento do bot original.

**Tech Stack:** Node.js ESM, `node:assert/strict` para smoke tests (padrão do repo — sem test runner), `node:zlib` para gzip.

**Spec:** `docs/superpowers/specs/2026-05-22-backtest-harness-design.md`

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/backtest/orderbookCapture.js` (criar) | Helpers puros (`trimBook`, `booksChanged`, `buildLine`) + `createOrderbookCapture` (record, rotação, gzip, retenção) |
| `src/backtest/pipeline5m.js` (criar) | `runPipeline5m(ctx, config)` — função pura: indicadores → scoring → edge → decide → gate de alinhamento |
| `src/data/polymarket.js` (modificar) | Expor `rawBook` (livros crus) no retorno de `fetchPolymarketSnapshot` |
| `src/index5m.js` (modificar) | Instanciar a captura; hoist de `btcPrice`/`priceToBeat`; trace `BACKTEST_TRACE`; chamar `runPipeline5m` |
| `scripts/smokeTestOrderbookCapture.js` (criar) | Smoke test da Fase 0 |
| `scripts/smokeTestPipeline.js` (criar) | Golden test da Fase 1 |
| `test/fixtures/pipeline5m-golden.jsonl` (criar) | Fixture de ground-truth capturado do bot original |
| `package.json` (modificar) | Scripts `smoke:orderbook`, `smoke:pipeline` |

---

# FASE 0 — Captura de orderbook

## Task 1: Helper `trimBook`

**Files:**
- Create: `src/backtest/orderbookCapture.js`
- Create: `scripts/smokeTestOrderbookCapture.js`

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/smokeTestOrderbookCapture.js`:

```js
import assert from "node:assert/strict";
import { trimBook } from "../src/backtest/orderbookCapture.js";

// trimBook: ordena best-first e corta no depthLevels
const raw = {
  bids: [{ price: "0.48", size: "10" }, { price: "0.50", size: "5" }, { price: "0.49", size: "7" }],
  asks: [{ price: "0.53", size: "3" }, { price: "0.51", size: "8" }, { price: "0.52", size: "2" }],
};
const t = trimBook(raw, 2);
assert.deepEqual(t.bids, [[0.50, 5], [0.49, 7]], "bids: maior preço primeiro, cortado em 2");
assert.deepEqual(t.asks, [[0.51, 8], [0.52, 2]], "asks: menor preço primeiro, cortado em 2");

// trimBook: descarta níveis não-numéricos e trata book vazio/ausente
const dirty = { bids: [{ price: "x", size: "1" }, { price: "0.4", size: "2" }], asks: [] };
assert.deepEqual(trimBook(dirty, 10).bids, [[0.4, 2]], "níveis inválidos descartados");
assert.deepEqual(trimBook(null, 10), { bids: [], asks: [] }, "book ausente → vazio");

console.log("OK trimBook");
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: FAIL — `Cannot find module '.../src/backtest/orderbookCapture.js'`

- [ ] **Step 3: Implementar `trimBook`**

Criar `src/backtest/orderbookCapture.js`:

```js
/**
 * Normaliza e corta um livro cru da CLOB nos top-N níveis, best-first.
 * @param {{bids?:Array, asks?:Array}} rawBook - níveis {price, size}
 * @param {number} depthLevels - quantos níveis manter por lado
 * @returns {{bids:Array<[number,number]>, asks:Array<[number,number]>}}
 */
export function trimBook(rawBook, depthLevels = 10) {
  const bids = Array.isArray(rawBook?.bids) ? rawBook.bids : [];
  const asks = Array.isArray(rawBook?.asks) ? rawBook.asks : [];
  const norm = (lvl) => [Number(lvl.price), Number(lvl.size)];
  const valid = ([p, s]) => Number.isFinite(p) && Number.isFinite(s);
  return {
    bids: bids.map(norm).filter(valid).sort((a, b) => b[0] - a[0]).slice(0, depthLevels),
    asks: asks.map(norm).filter(valid).sort((a, b) => a[0] - b[0]).slice(0, depthLevels),
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: PASS — imprime `OK trimBook`

- [ ] **Step 5: Commit**

```bash
git add src/backtest/orderbookCapture.js scripts/smokeTestOrderbookCapture.js
git commit -m "feat(backtest): add trimBook orderbook helper"
```

---

## Task 2: Helper `booksChanged`

**Files:**
- Modify: `src/backtest/orderbookCapture.js`
- Modify: `scripts/smokeTestOrderbookCapture.js`

- [ ] **Step 1: Adicionar o teste que falha**

Acrescentar a `scripts/smokeTestOrderbookCapture.js`, antes da última linha de log, e atualizar o import do topo para `import { trimBook, booksChanged } from "../src/backtest/orderbookCapture.js";`:

```js
// booksChanged: detecta diferença entre dois snapshots aparados
const snapA = { up: { bids: [[0.5, 1]], asks: [] }, down: { bids: [], asks: [] } };
const snapB = { up: { bids: [[0.5, 1]], asks: [] }, down: { bids: [], asks: [] } };
const snapC = { up: { bids: [[0.5, 2]], asks: [] }, down: { bids: [], asks: [] } };
assert.equal(booksChanged(snapA, snapB), false, "snapshots iguais → false");
assert.equal(booksChanged(snapA, snapC), true, "size diferente → true");
assert.equal(booksChanged(null, snapA), true, "sem snapshot anterior → true");

console.log("OK booksChanged");
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: FAIL — `booksChanged is not a function`

- [ ] **Step 3: Implementar `booksChanged`**

Acrescentar a `src/backtest/orderbookCapture.js`:

```js
/**
 * Compara dois snapshots aparados ({up,down}). True se mudaram.
 */
export function booksChanged(prev, next) {
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(next);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: PASS — imprime `OK booksChanged`

- [ ] **Step 5: Commit**

```bash
git add src/backtest/orderbookCapture.js scripts/smokeTestOrderbookCapture.js
git commit -m "feat(backtest): add booksChanged dedup helper"
```

---

## Task 3: Helper `buildLine`

**Files:**
- Modify: `src/backtest/orderbookCapture.js`
- Modify: `scripts/smokeTestOrderbookCapture.js`

- [ ] **Step 1: Adicionar o teste que falha**

Atualizar o import para `import { trimBook, booksChanged, buildLine } from "../src/backtest/orderbookCapture.js";` e acrescentar antes da última linha:

```js
// buildLine: serializa uma linha JSONL (sem newline)
const line = buildLine({
  ts: "2026-05-22T12:00:00.000Z", slug: "btc-updown-5m-1",
  timeLeftMin: 3.2, up: { bids: [[0.5, 1]], asks: [] }, down: { bids: [], asks: [] },
});
const parsed = JSON.parse(line);
assert.equal(parsed.slug, "btc-updown-5m-1");
assert.equal(parsed.timeLeftMin, 3.2);
assert.deepEqual(parsed.up.bids, [[0.5, 1]]);
assert.equal(line.includes("\n"), false, "buildLine não inclui newline");

console.log("OK buildLine");
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: FAIL — `buildLine is not a function`

- [ ] **Step 3: Implementar `buildLine`**

Acrescentar a `src/backtest/orderbookCapture.js`:

```js
/**
 * Serializa um tick de orderbook como uma linha JSON (sem newline).
 */
export function buildLine({ ts, slug, timeLeftMin, up, down }) {
  return JSON.stringify({ ts, slug, timeLeftMin, up, down });
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: PASS — imprime `OK buildLine`

- [ ] **Step 5: Commit**

```bash
git add src/backtest/orderbookCapture.js scripts/smokeTestOrderbookCapture.js
git commit -m "feat(backtest): add buildLine JSONL serializer"
```

---

## Task 4: `createOrderbookCapture` — record + dedup + append

**Files:**
- Modify: `src/backtest/orderbookCapture.js`
- Modify: `scripts/smokeTestOrderbookCapture.js`

- [ ] **Step 1: Adicionar o teste que falha**

Atualizar o import para incluir `createOrderbookCapture` e acrescentar no fim (antes de nada — este bloco usa `fs`/`os`/`path`, adicione os imports no topo do arquivo de teste):

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// createOrderbookCapture: grava, dedup, e ignora book ausente
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obcap-"));
const cap = createOrderbookCapture({ dir: tmp, depthLevels: 5 });
const rawBook = {
  up:   { bids: [{ price: "0.5", size: "1" }], asks: [{ price: "0.6", size: "1" }] },
  down: { bids: [{ price: "0.4", size: "1" }], asks: [{ price: "0.5", size: "1" }] },
};
cap.record({ slug: "mkt-1", timeLeftMin: 4, rawBook });
cap.record({ slug: "mkt-1", timeLeftMin: 3, rawBook }); // book idêntico → dedup, não grava
cap.record({ slug: "mkt-1", timeLeftMin: 2, rawBook: null }); // sem book → ignora

const active = path.join(tmp, "orderbook_5m.jsonl");
let lines = fs.readFileSync(active, "utf8").trim().split("\n");
assert.equal(lines.length, 1, "dedup: book idêntico não gera segunda linha");

// book diferente → grava
const rawBook2 = JSON.parse(JSON.stringify(rawBook));
rawBook2.up.bids[0].size = "9";
cap.record({ slug: "mkt-1", timeLeftMin: 1, rawBook: rawBook2 });
lines = fs.readFileSync(active, "utf8").trim().split("\n");
assert.equal(lines.length, 2, "book alterado → nova linha");

// troca de mercado sempre grava, mesmo com book idêntico
cap.record({ slug: "mkt-2", timeLeftMin: 5, rawBook: rawBook2 });
lines = fs.readFileSync(active, "utf8").trim().split("\n");
assert.equal(lines.length, 3, "novo slug → nova linha");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK createOrderbookCapture record");
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: FAIL — `createOrderbookCapture is not a function`

- [ ] **Step 3: Implementar `createOrderbookCapture` (sem rotação ainda)**

Acrescentar a `src/backtest/orderbookCapture.js` (adicione no topo do arquivo: `import fs from "node:fs"; import path from "node:path";`):

```js
/**
 * Logger append-only de profundidade de orderbook.
 * @param {object} opts
 * @param {string} [opts.dir="./logs"]       - diretório dos arquivos
 * @param {number} [opts.depthLevels=10]     - níveis capturados por lado
 * @param {number} [opts.retentionDays=90]   - dias de .gz mantidos (Task 5)
 * @param {() => Date} [opts.now]            - injeção de relógio (testes)
 */
export function createOrderbookCapture({
  dir = "./logs",
  depthLevels = 10,
  retentionDays = 90,
  now = () => new Date(),
} = {}) {
  const activePath = path.join(dir, "orderbook_5m.jsonl");
  let lastCombined = null;
  let lastSlug = null;
  let currentDate = null;

  function record({ slug, timeLeftMin, rawBook }) {
    if (!rawBook) return;
    const up = trimBook(rawBook.up, depthLevels);
    const down = trimBook(rawBook.down, depthLevels);
    const combined = { up, down };

    // dedup: dentro do mesmo mercado, pula se o book não mudou
    if (slug === lastSlug && !booksChanged(lastCombined, combined)) return;

    if (currentDate === null) {
      currentDate = now().toISOString().slice(0, 10);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const line = buildLine({ ts: now().toISOString(), slug, timeLeftMin, up, down });
    fs.appendFileSync(activePath, line + "\n");
    lastCombined = combined;
    lastSlug = slug;
  }

  return { record };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: PASS — imprime `OK createOrderbookCapture record`

- [ ] **Step 5: Commit**

```bash
git add src/backtest/orderbookCapture.js scripts/smokeTestOrderbookCapture.js
git commit -m "feat(backtest): orderbook capture record with dedup"
```

---

## Task 5: Rotação diária, gzip e retenção

**Files:**
- Modify: `src/backtest/orderbookCapture.js`
- Modify: `scripts/smokeTestOrderbookCapture.js`

- [ ] **Step 1: Adicionar o teste que falha**

Acrescentar ao fim de `scripts/smokeTestOrderbookCapture.js` (adicione `import zlib from "node:zlib";` no topo):

```js
// Rotação: virada de dia gzipa o arquivo do dia anterior
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "obcap-rot-"));
let fakeNow = new Date("2026-05-20T23:59:00.000Z");
const cap2 = createOrderbookCapture({
  dir: tmp2, depthLevels: 5, retentionDays: 90, now: () => fakeNow,
});
const rb = {
  up:   { bids: [{ price: "0.5", size: "1" }], asks: [] },
  down: { bids: [], asks: [] },
};
cap2.record({ slug: "mkt-1", timeLeftMin: 4, rawBook: rb });

fakeNow = new Date("2026-05-21T00:01:00.000Z"); // vira o dia
const rb2 = JSON.parse(JSON.stringify(rb)); rb2.up.bids[0].size = "2";
cap2.record({ slug: "mkt-1", timeLeftMin: 3, rawBook: rb2 });

const gz = path.join(tmp2, "orderbook_5m_2026-05-20.jsonl.gz");
assert.ok(fs.existsSync(gz), "dia anterior foi gzipado");
const restored = zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8").trim();
assert.equal(restored.split("\n").length, 1, ".gz contém o tick do dia 20");
const activeNow = fs.readFileSync(path.join(tmp2, "orderbook_5m.jsonl"), "utf8").trim();
assert.equal(activeNow.split("\n").length, 1, "arquivo ativo só tem o tick do dia 21");

// Retenção: .gz mais velho que retentionDays é podado na rotação
fs.writeFileSync(path.join(tmp2, "orderbook_5m_2026-01-01.jsonl.gz"), zlib.gzipSync("x"));
fakeNow = new Date("2026-05-22T00:01:00.000Z"); // outra virada
cap2.record({ slug: "mkt-1", timeLeftMin: 2, rawBook: rb });
assert.ok(!fs.existsSync(path.join(tmp2, "orderbook_5m_2026-01-01.jsonl.gz")),
  ".gz com >90 dias foi podado");
assert.ok(fs.existsSync(path.join(tmp2, "orderbook_5m_2026-05-21.jsonl.gz")),
  ".gz recente foi mantido");

fs.rmSync(tmp2, { recursive: true, force: true });
console.log("OK rotação + retenção");
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: FAIL — `assert.ok(fs.existsSync(gz))` falha (rotação ainda não existe)

- [ ] **Step 3: Implementar rotação + retenção**

Em `src/backtest/orderbookCapture.js`, adicionar `import zlib from "node:zlib";` no topo. Dentro de `createOrderbookCapture`, acrescentar antes de `function record`:

```js
  function pruneOld() {
    const cutoff = now().getTime() - retentionDays * 86_400_000;
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      const m = /^orderbook_5m_(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignora */ }
      }
    }
  }

  function rotate(prevDate) {
    if (!fs.existsSync(activePath)) return;
    const raw = fs.readFileSync(activePath);
    if (raw.length > 0) {
      fs.writeFileSync(path.join(dir, `orderbook_5m_${prevDate}.jsonl.gz`), zlib.gzipSync(raw));
    }
    fs.writeFileSync(activePath, "");
    pruneOld();
  }
```

E dentro de `record`, substituir o bloco `if (currentDate === null) { ... }` por:

```js
    const today = now().toISOString().slice(0, 10);
    if (currentDate === null) {
      currentDate = today;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } else if (today !== currentDate) {
      rotate(currentDate);
      currentDate = today;
    }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node scripts/smokeTestOrderbookCapture.js`
Expected: PASS — imprime `OK rotação + retenção`

- [ ] **Step 5: Adicionar o npm script e commitar**

Em `package.json`, na seção `scripts`, adicionar:

```json
    "smoke:orderbook": "node scripts/smokeTestOrderbookCapture.js",
```

```bash
git add src/backtest/orderbookCapture.js scripts/smokeTestOrderbookCapture.js package.json
git commit -m "feat(backtest): daily gzip rotation + 90-day retention"
```

---

## Task 6: Expor `rawBook` em `fetchPolymarketSnapshot`

**Files:**
- Modify: `src/data/polymarket.js` (retorno de `fetchPolymarketSnapshot`, ~linha 104-110)

- [ ] **Step 1: Adicionar `rawBook` ao caso de sucesso**

Em `src/data/polymarket.js`, no bloco `try` onde `upBook`/`downBook` são obtidos, eles hoje só viram summaries. Declarar duas variáveis no escopo da função (junto de `let upBuy = null, downBuy = null;`):

```js
  let upBuy = null, downBuy = null;
  let upBookSummary = { ...emptyBook }, downBookSummary = { ...emptyBook };
  let upRawBook = null, downRawBook = null;
```

Dentro do `try`, após `summarizeOrderBook`, guardar os livros crus:

```js
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
    upRawBook = upBook;
    downRawBook = downBook;
```

- [ ] **Step 2: Incluir `rawBook` no objeto retornado**

Alterar o `return` final de `fetchPolymarketSnapshot`:

```js
  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: { up: upBuy ?? gammaYes, down: downBuy ?? gammaNo },
    orderbook: { up: upBookSummary, down: downBookSummary },
    rawBook: { up: upRawBook, down: downRawBook },
  };
```

O bloco `catch` deixa `upRawBook`/`downRawBook` em `null` — `createOrderbookCapture.record` já ignora `rawBook` cujos lados são `null` ao passar por `trimBook` (retorna `{bids:[],asks:[]}`); para evitar gravar linhas vazias, o caller (Task 7) só chama `record` quando `poly.rawBook.up` e `poly.rawBook.down` não são `null`.

- [ ] **Step 3: Verificar que o snapshot ainda carrega (sanity)**

Run: `node --env-file=.env -e "import('./src/data/polymarket.js').then(m => console.log(typeof m.fetchPolymarketSnapshot))"`
Expected: imprime `function` (módulo carrega sem erro de sintaxe)

- [ ] **Step 4: Commit**

```bash
git add src/data/polymarket.js
git commit -m "feat(data): expose raw order books from fetchPolymarketSnapshot"
```

---

## Task 7: Engatar a captura no `index5m.js`

**Files:**
- Modify: `src/index5m.js` (imports; `main()` setup ~linha 93; loop ~linha 138-145)

- [ ] **Step 1: Importar e instanciar a captura**

No topo de `src/index5m.js`, junto dos outros imports de `./backtest` (criar a linha):

```js
import { createOrderbookCapture } from "./backtest/orderbookCapture.js";
```

Em `main()`, logo após a criação do `dryRun` (`const dryRun = createDryRunSimulator5m(...)`, ~linha 97):

```js
  const orderbookCapture = createOrderbookCapture({ dir: "./logs", depthLevels: 10, retentionDays: 90 });
```

- [ ] **Step 2: Gravar o orderbook a cada tick**

No loop, logo após o `Promise.all` que resolve `poly` (~linha 145, após a linha que calcula `timeLeftMin`), adicionar:

```js
      // Backtest Fase 0: captura de profundidade de orderbook (fire-and-forget)
      if (poly.ok && poly.rawBook?.up && poly.rawBook?.down) {
        try {
          orderbookCapture.record({
            slug: String(poly.market?.slug ?? ""),
            timeLeftMin,
            rawBook: poly.rawBook,
          });
        } catch { /* nunca bloqueia o poll */ }
      }
```

- [ ] **Step 3: Smoke manual — rodar o bot e conferir o arquivo**

Run (durante um mercado 5m ativo, ~2 min): `timeout 120 npm run start:5m`
Depois: `wc -l logs/orderbook_5m.jsonl && head -1 logs/orderbook_5m.jsonl | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('slug',o.slug,'bids',o.up.bids.length)})"`
Expected: arquivo tem ≥1 linha; a primeira linha parseia como JSON com `slug` e `up.bids` (até 10 níveis).

- [ ] **Step 4: Commit**

```bash
git add src/index5m.js
git commit -m "feat(5m): wire orderbook depth capture into poll loop"
```

---

# FASE 1 — Extração do `pipeline5m`

A Fase 1 é um refactor de comportamento-zero. A defesa contra regressão é o **golden test**: um fixture de ground-truth capturado do bot original, que o `runPipeline5m` extraído precisa reproduzir.

## Task 8: Instrumentação de trace + captura do fixture

**Files:**
- Modify: `src/index5m.js` (hoist de `btcPrice`/`priceToBeat`; bloco de trace)
- Create: `test/fixtures/pipeline5m-golden.jsonl` (gerado por execução do bot)

- [ ] **Step 1: Hoist da resolução de `btcPrice` e `priceToBeat`**

Hoje o gate de alinhamento BTC (dentro do `if (rec.action === "ENTER" && CONFIG.trading.requireBtcAlignment)`) resolve `_btcPriceForGate` e `_ptbForGate` localmente. Para o pipeline puro (Task 9) esses valores precisam ser entradas. Resolvê-los **uma vez, antes do bloco de indicadores** (logo após o cálculo de `timeLeftMin`, ~linha 147):

```js
      // Resolvido uma vez por tick: entradas do pipeline puro (gate de alinhamento BTC).
      const btcPriceForTick = chainlink?.price ?? null;
      const slugForTick = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMsForTick = poly.ok && poly.market?.eventStartTime
        ? new Date(poly.market.eventStartTime).getTime()
        : null;
      const priceToBeatForTick = priceLatch.update({
        marketSlug: slugForTick,
        currentPrice: btcPriceForTick,
        marketStartMs: marketStartMsForTick,
        market: poly.market ?? null,
      });
```

Em seguida, no bloco existente do gate de alinhamento, **substituir** as variáveis locais `_btcPriceForGate`/`_ptbForGate`/`_slugForGate`/`_startMsForGate` e a chamada `priceLatch.update(...)` pelo uso direto de `btcPriceForTick` e `priceToBeatForTick`. O bloco fica:

```js
      if (rec.action === "ENTER" && CONFIG.trading.requireBtcAlignment) {
        if (btcPriceForTick !== null && priceToBeatForTick !== null) {
          const _btcVsPtb = btcPriceForTick - priceToBeatForTick;
          const _againstUp = rec.side === "UP" && _btcVsPtb < 0;
          const _againstDown = rec.side === "DOWN" && _btcVsPtb > 0;
          if (_againstUp || _againstDown) {
            rec = { action: "NO_TRADE", side: null, phase: rec.phase, reason: "side_against_btc" };
          }
        }
      }
```

`priceLatch.update` é idempotente por tick (latcha uma vez por mercado e devolve o valor latchado), então chamá-lo aqui em vez de dentro do `if` não muda o resultado — apenas o torna incondicional.

- [ ] **Step 2: Adicionar o bloco de trace `BACKTEST_TRACE`**

No topo de `src/index5m.js`, garantir `import fs from "node:fs";` (já existe). Logo após o bloco do gate de alinhamento (antes de `// ── Trading ──`), adicionar:

```js
      // Backtest Fase 1: trace de ground-truth para o golden test.
      if (process.env.BACKTEST_TRACE === "1") {
        try {
          const _traceLine = JSON.stringify({
            ctx: {
              klines1m, ofiData, lastPrice, timeLeftMin,
              marketUp, marketDown,
              btcPrice: btcPriceForTick, priceToBeat: priceToBeatForTick,
            },
            result: {
              rec,
              modelUp: timeAware.adjustedUp,
              modelDown: timeAware.adjustedDown,
              edgeUp: edge.edgeUp,
              edgeDown: edge.edgeDown,
            },
          });
          fs.appendFileSync("./logs/pipeline_trace.jsonl", _traceLine + "\n");
        } catch { /* trace é best-effort */ }
      }
```

- [ ] **Step 3: Rodar o bot com trace para gerar o fixture**

Run (durante um mercado 5m ativo, ~8-10 min, para capturar ticks com sinais variados): `BACKTEST_TRACE=1 timeout 600 npm run start:5m`

- [ ] **Step 4: Materializar o fixture**

Run:
```bash
mkdir -p test/fixtures
head -40 logs/pipeline_trace.jsonl > test/fixtures/pipeline5m-golden.jsonl
wc -l test/fixtures/pipeline5m-golden.jsonl
```
Expected: `test/fixtures/pipeline5m-golden.jsonl` com ~40 linhas. Cada linha = um `{ctx, result}` produzido pelo bot **original** — este é o ground-truth.

- [ ] **Step 5: Commit**

```bash
git add src/index5m.js test/fixtures/pipeline5m-golden.jsonl
git commit -m "feat(5m): hoist btc/ptb resolution + add BACKTEST_TRACE ground-truth dump"
```

---

## Task 9: Criar `runPipeline5m`

**Files:**
- Create: `src/backtest/pipeline5m.js`

- [ ] **Step 1: Implementar `runPipeline5m`**

Criar `src/backtest/pipeline5m.js`. O corpo é **exatamente** o cálculo das linhas ~150-213 do `index5m.js` (indicadores + sinal + edge + decide + gate), com os valores de `CONFIG`/`CONFIG.trading` recebidos via `config`:

```js
import { computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, slopeLast } from "../indicators/rsi.js";
import { computeHeikenAshi, countConsecutive } from "../indicators/heikenAshi.js";
import { computeEmaCross } from "../indicators/emaCross.js";
import { scoreOrderFlow } from "../indicators/orderFlow.js";
import { computeMomentum, scoreMomentum } from "../indicators/momentum.js";
import { scoreDirection5m, applyTimeAwareness5m } from "../engines/probability5m.js";
import { computeEdge, decide5m } from "../engines/edge5m.js";

/**
 * Pipeline puro per-tick do bot 5m. Sem I/O, sem rede.
 * @param {object} ctx   - TickContext: dados do tick (live ou replay)
 *   {Array}  klines1m   - candles OHLCV 1m da Binance
 *   {object} ofiData    - estado do order-flow (saída de ofiStream.getOfi())
 *   {number} lastPrice  - último preço spot Binance
 *   {number} timeLeftMin
 *   {number|null} marketUp, marketDown - preços Polymarket
 *   {number|null} btcPrice  - preço Chainlink BTC/USD
 *   {number|null} priceToBeat
 * @param {object} config - subconjunto de CONFIG (ver index5m.js)
 *   campos: vwapCandleWindow, vwapSlopeLookbackMinutes, rsiPeriod,
 *           emaCrossFast, emaCrossSlow, candleWindowMinutes,
 *           trading: { feeRate, entryMinTimeLeftMin, requireBtcAlignment }
 * @returns {object} TickResult
 */
export function runPipeline5m(ctx, config) {
  const { klines1m, ofiData, lastPrice, timeLeftMin, marketUp, marketDown,
          btcPrice, priceToBeat } = ctx;

  // ── Indicadores ──
  const vwapCandles = klines1m.slice(-config.vwapCandleWindow);
  const allCloses   = klines1m.map((c) => c.close);

  const vwapSeries = computeVwapSeries(vwapCandles);
  const vwapNow    = vwapSeries[vwapSeries.length - 1];
  const lookback   = config.vwapSlopeLookbackMinutes;
  const vwapSlope  = vwapSeries.length >= lookback
    ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
    : null;
  const vwapDist   = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

  const rsiNow = computeRsi(allCloses, config.rsiPeriod);
  const rsiSeries = [];
  for (let i = 0; i < allCloses.length; i++) {
    const r = computeRsi(allCloses.slice(0, i + 1), config.rsiPeriod);
    if (r !== null) rsiSeries.push(r);
  }
  const rsiSlope = slopeLast(rsiSeries, 3);

  const emaCross       = computeEmaCross(allCloses, config.emaCrossFast, config.emaCrossSlow);
  const ha             = computeHeikenAshi(klines1m.slice(-10));
  const consec         = countConsecutive(ha);
  const momentum       = computeMomentum(klines1m);
  const momentumScore  = scoreMomentum(momentum);
  const orderFlowScore = scoreOrderFlow(ofiData);

  // ── Sinal ──
  const scored = scoreDirection5m({
    orderFlow: orderFlowScore, momentumScore, emaCross,
    rsi: rsiNow, rsiSlope,
    heikenColor: consec.color, heikenCount: consec.count,
    price: lastPrice, vwap: vwapNow, vwapSlope,
  });

  const timeAware = applyTimeAwareness5m(scored.rawUp, timeLeftMin, config.candleWindowMinutes);
  const edge = computeEdge({
    modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
    marketYes: marketUp, marketNo: marketDown,
  });
  const ofi1mVal = ofiData.ofi1m?.ofi ?? null;

  let rec = decide5m({
    remainingMinutes: timeLeftMin,
    edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
    modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
    marketUp, marketDown,
    heikenColor: consec.color, ofi1m: ofi1mVal,
    feeRate: config.trading.feeRate,
    minTimeLeftMin: config.trading.entryMinTimeLeftMin,
  });

  // ── Gate de alinhamento BTC ──
  if (rec.action === "ENTER" && config.trading.requireBtcAlignment
      && btcPrice !== null && priceToBeat !== null) {
    const btcVsPtb = btcPrice - priceToBeat;
    const againstUp   = rec.side === "UP"   && btcVsPtb < 0;
    const againstDown = rec.side === "DOWN" && btcVsPtb > 0;
    if (againstUp || againstDown) {
      rec = { action: "NO_TRADE", side: null, phase: rec.phase, reason: "side_against_btc" };
    }
  }

  return {
    rec,
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown,
    edgeUp: edge.edgeUp,
    edgeDown: edge.edgeDown,
    scored,
    timeAware,
    edge,
    indicators: {
      rsi: rsiNow, rsiSlope, emaCross,
      haColor: consec.color, haCount: consec.count,
      vwap: vwapNow, vwapDistPct: vwapDist, vwapSlope,
      momentum, momentumScore, orderFlowScore, ofi1m: ofi1mVal,
    },
  };
}
```

- [ ] **Step 2: Verificar que o módulo carrega**

Run: `node -e "import('./src/backtest/pipeline5m.js').then(m => console.log(typeof m.runPipeline5m))"`
Expected: imprime `function`

- [ ] **Step 3: Commit**

```bash
git add src/backtest/pipeline5m.js
git commit -m "feat(backtest): extract runPipeline5m pure per-tick pipeline"
```

---

## Task 10: Golden test — `runPipeline5m` reproduz o fixture

**Files:**
- Create: `scripts/smokeTestPipeline.js`
- Modify: `package.json`

- [ ] **Step 1: Escrever o golden test**

Criar `scripts/smokeTestPipeline.js`. Lê o fixture, roda `runPipeline5m` em cada `ctx`, e compara com o `result` gravado. O `config` usado deve espelhar o `CONFIG` do `config5m.js`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import { runPipeline5m } from "../src/backtest/pipeline5m.js";
import { CONFIG } from "../src/config5m.js";

const FIXTURE = "./test/fixtures/pipeline5m-golden.jsonl";
const TOL = 1e-9; // tolerância de float

const pipelineConfig = {
  vwapCandleWindow: CONFIG.vwapCandleWindow,
  vwapSlopeLookbackMinutes: CONFIG.vwapSlopeLookbackMinutes,
  rsiPeriod: CONFIG.rsiPeriod,
  emaCrossFast: CONFIG.emaCrossFast,
  emaCrossSlow: CONFIG.emaCrossSlow,
  candleWindowMinutes: CONFIG.candleWindowMinutes,
  trading: {
    feeRate: CONFIG.trading.feeRate,
    entryMinTimeLeftMin: CONFIG.trading.entryMinTimeLeftMin,
    requireBtcAlignment: CONFIG.trading.requireBtcAlignment,
  },
};

function closeEnough(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOL;
  return a === b;
}

const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").filter(Boolean);
assert.ok(lines.length > 0, "fixture não vazio");

let checked = 0;
for (const line of lines) {
  const { ctx, result } = JSON.parse(line);
  const got = runPipeline5m(ctx, pipelineConfig);

  assert.equal(got.rec.action, result.rec.action, `rec.action tick ${checked}`);
  assert.equal(got.rec.side ?? null, result.rec.side ?? null, `rec.side tick ${checked}`);
  assert.equal(got.rec.reason ?? null, result.rec.reason ?? null, `rec.reason tick ${checked}`);
  assert.ok(closeEnough(got.modelUp, result.modelUp), `modelUp tick ${checked}`);
  assert.ok(closeEnough(got.modelDown, result.modelDown), `modelDown tick ${checked}`);
  assert.ok(closeEnough(got.edgeUp, result.edgeUp), `edgeUp tick ${checked}`);
  assert.ok(closeEnough(got.edgeDown, result.edgeDown), `edgeDown tick ${checked}`);
  checked++;
}

console.log(`OK golden pipeline5m — ${checked} ticks reproduzidos`);
```

- [ ] **Step 2: Rodar o golden test**

Run: `node scripts/smokeTestPipeline.js`
Expected: PASS — `OK golden pipeline5m — 40 ticks reproduzidos`.
Se FALHAR: o `runPipeline5m` divergiu do bot original. Comparar o campo apontado pelo `assert` com o cálculo correspondente no `index5m.js` e corrigir `pipeline5m.js` — **não** ajustar a tolerância nem o fixture.

- [ ] **Step 3: Registrar o npm script**

Em `package.json`, seção `scripts`:

```json
    "smoke:pipeline": "node scripts/smokeTestPipeline.js",
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smokeTestPipeline.js package.json
git commit -m "test(backtest): golden test asserting runPipeline5m reproduces live bot"
```

---

## Task 11: Refatorar `index5m.js` para usar `runPipeline5m`

**Files:**
- Modify: `src/index5m.js` (imports; bloco de indicadores/sinal ~linha 150-213)

- [ ] **Step 1: Importar `runPipeline5m`**

No topo de `src/index5m.js`, junto do import de `orderbookCapture`:

```js
import { runPipeline5m } from "./backtest/pipeline5m.js";
```

- [ ] **Step 2: Substituir o bloco de cálculo pela chamada ao pipeline**

Remover as seções `// ── Indicators ──`, `// ── Signal ──` e o `decide5m(...)` (linhas ~149-189 — todo o cálculo que foi movido para `pipeline5m.js`) e o bloco do gate de alinhamento BTC (~linha 196-214). Substituir tudo por:

```js
      // ── Pipeline (compartilhado com o backtest) ───────────────────────────
      const pipelineConfig = {
        vwapCandleWindow: CONFIG.vwapCandleWindow,
        vwapSlopeLookbackMinutes: CONFIG.vwapSlopeLookbackMinutes,
        rsiPeriod: CONFIG.rsiPeriod,
        emaCrossFast: CONFIG.emaCrossFast,
        emaCrossSlow: CONFIG.emaCrossSlow,
        candleWindowMinutes: CONFIG.candleWindowMinutes,
        trading: {
          feeRate: CONFIG.trading.feeRate,
          entryMinTimeLeftMin: CONFIG.trading.entryMinTimeLeftMin,
          requireBtcAlignment: CONFIG.trading.requireBtcAlignment,
        },
      };
      const marketUp   = poly.ok ? poly.prices.up   : null;
      const marketDown = poly.ok ? poly.prices.down  : null;

      const pipeline = runPipeline5m(
        {
          klines1m, ofiData, lastPrice, timeLeftMin,
          marketUp, marketDown,
          btcPrice: btcPriceForTick, priceToBeat: priceToBeatForTick,
        },
        pipelineConfig,
      );

      const rec        = pipeline.rec;
      const scored     = pipeline.scored;
      const timeAware  = pipeline.timeAware;
      const edge       = pipeline.edge;
```

> Variáveis que o restante do loop (display, dryRun, executor) ainda consome —
> `rsiNow`, `consec`, `emaCross`, `momentum`, `momentumScore`, `vwapNow`,
> `vwapSlope`, `vwapDist`, `ofi1mVal` — devem ser religadas a partir de
> `pipeline.indicators`. Adicionar logo abaixo:

```js
      const rsiNow        = pipeline.indicators.rsi;
      const emaCross      = pipeline.indicators.emaCross;
      const momentum      = pipeline.indicators.momentum;
      const momentumScore = pipeline.indicators.momentumScore;
      const vwapNow       = pipeline.indicators.vwap;
      const vwapSlope     = pipeline.indicators.vwapSlope;
      const vwapDist      = pipeline.indicators.vwapDistPct;
      const ofi1mVal      = pipeline.indicators.ofi1m;
      const consec        = { color: pipeline.indicators.haColor, count: pipeline.indicators.haCount };
```

> Conferir, com busca no arquivo, quais desses nomes o restante do loop
> realmente referencia; manter apenas os usados (o linter/execução acusa
> `is not defined` se faltar algum). `rec` não pode mais ser `let` reatribuído
> pelo gate — o gate agora vive dentro de `runPipeline5m`.

- [ ] **Step 3: Rodar o golden test (garante que o pipeline não mudou)**

Run: `node scripts/smokeTestPipeline.js`
Expected: PASS — `OK golden pipeline5m — 40 ticks reproduzidos` (o fixture é de antes do refactor; continuar passando prova paridade).

- [ ] **Step 4: Smoke manual — o bot roda sem erro**

Run: `timeout 90 npm run start:5m`
Expected: o painel renderiza, sem `ReferenceError`/`is not defined`. Conferir que `logs/dryrun_5m.csv` ganhou linhas novas com colunas de indicador preenchidas (não vazias).

- [ ] **Step 5: Commit**

```bash
git add src/index5m.js
git commit -m "refactor(5m): drive tick loop through shared runPipeline5m"
```

---

## Task 12: Verificação de paridade end-to-end + `backtest:verify`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Re-capturar trace com o código já refatorado**

Run (mercado 5m ativo, ~5 min): `BACKTEST_TRACE=1 timeout 300 npm run start:5m`

- [ ] **Step 2: Rodar o golden test contra o fixture original**

Run: `node scripts/smokeTestPipeline.js`
Expected: PASS. O `index5m.js` refatorado produz o mesmo trace de antes → o golden test (fixture pré-refactor) continua válido. Paridade end-to-end confirmada.

- [ ] **Step 3: Adicionar o agregador `backtest:verify`**

Em `package.json`, seção `scripts`:

```json
    "backtest:verify": "npm run smoke:orderbook && npm run smoke:pipeline",
```

- [ ] **Step 4: Rodar o agregador**

Run: `npm run backtest:verify`
Expected: PASS nos dois — `OK rotação + retenção` ... `OK golden pipeline5m`.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(backtest): add backtest:verify aggregate smoke script"
```

---

## Self-review (preenchido)

**Cobertura do spec (Fases 0 e 1):**
- Fase 0 captura de orderbook (top-10, dedup, gzip diário, retenção 90d) → Tasks 1-7 ✅
- `rawBook` exposto pela camada de dados → Task 6 ✅
- Fase 1 `pipeline5m` puro extraído → Task 9 ✅
- Golden test anti-drift → Tasks 8, 10 ✅
- `index5m.js` dirigido pelo pipeline compartilhado → Task 11 ✅
- `backtest:verify` agregando aos smoke tests → Task 12 ✅
- Fases 2 (assembler) e 3 (harness/sweep) → **fora deste plano**, planos próprios após a Fase 1 entrar (o `TickContext` da Task 9 é o contrato que esses planos consomem).

**Placeholders:** nenhum — todo passo tem código ou comando concreto.

**Consistência de tipos:** `trimBook`/`booksChanged`/`buildLine`/`createOrderbookCapture` usados com a mesma assinatura em teste e implementação. `runPipeline5m(ctx, config)` → `TickResult` consumido identicamente pelo golden test (Task 10) e pelo `index5m.js` (Task 11). Campo `rawBook: {up, down}` exposto na Task 6 e consumido na Task 7.

**Riscos conhecidos:**
- Tasks 8/12 exigem rodar o bot live durante um mercado 5m ativo para gerar o fixture/trace — é um passo manual legítimo (é um bot de trading).
- Reinício do bot através da virada de meia-noite pode mesclar um dia parcial no `.gz` seguinte — aceitável para fidelidade de backtest.
