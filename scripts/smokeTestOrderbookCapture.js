import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trimBook, booksChanged, buildLine, createOrderbookCapture } from "../src/backtest/orderbookCapture.js";

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

// booksChanged: detecta diferença entre dois snapshots aparados
const snapA = { up: { bids: [[0.5, 1]], asks: [] }, down: { bids: [], asks: [] } };
const snapB = { up: { bids: [[0.5, 1]], asks: [] }, down: { bids: [], asks: [] } };
const snapC = { up: { bids: [[0.5, 2]], asks: [] }, down: { bids: [], asks: [] } };
assert.equal(booksChanged(snapA, snapB), false, "snapshots iguais → false");
assert.equal(booksChanged(snapA, snapC), true, "size diferente → true");
assert.equal(booksChanged(null, snapA), true, "sem snapshot anterior → true");

console.log("OK booksChanged");

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
