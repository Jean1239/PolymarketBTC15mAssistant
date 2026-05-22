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
