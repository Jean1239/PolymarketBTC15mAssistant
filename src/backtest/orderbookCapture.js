import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

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

/**
 * Compara dois snapshots aparados ({up,down}). True se mudaram.
 */
export function booksChanged(prev, next) {
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(next);
}

/**
 * Serializa um tick de orderbook como uma linha JSON (sem newline).
 */
export function buildLine({ ts, slug, timeLeftMin, up, down }) {
  return JSON.stringify({ ts, slug, timeLeftMin, up, down });
}

/**
 * Logger append-only de profundidade de orderbook.
 * @param {object} opts
 * @param {string} [opts.dir="./logs"]            - diretório dos arquivos
 * @param {number} [opts.depthLevels=10]          - níveis capturados por lado
 * @param {number} [opts.retentionDays=90]        - dias de .gz mantidos (Task 5)
 * @param {string} [opts.fileBase="orderbook_5m"] - prefixo do arquivo (sem extensão)
 * @param {() => Date} [opts.now]                 - injeção de relógio (testes)
 */
export function createOrderbookCapture({
  dir = "./logs",
  depthLevels = 10,
  retentionDays = 90,
  fileBase = "orderbook_5m",
  now = () => new Date(),
} = {}) {
  const activePath = path.join(dir, `${fileBase}.jsonl`);
  let lastCombined = null;
  let lastSlug = null;
  let currentDate = null;

  const pruneRegex = new RegExp(`^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d{4}-\\d{2}-\\d{2})\\.jsonl\\.gz$`);

  function pruneOld() {
    const cutoff = now().getTime() - retentionDays * 86_400_000;
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      const m = pruneRegex.exec(f);
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
      fs.writeFileSync(path.join(dir, `${fileBase}_${prevDate}.jsonl.gz`), zlib.gzipSync(raw));
    }
    fs.writeFileSync(activePath, "");
    pruneOld();
  }

  function record({ slug, timeLeftMin, rawBook }) {
    if (!rawBook) return;
    const up = trimBook(rawBook.up, depthLevels);
    const down = trimBook(rawBook.down, depthLevels);
    const combined = { up, down };

    // dedup: dentro do mesmo mercado, pula se o book não mudou
    if (slug === lastSlug && !booksChanged(lastCombined, combined)) return;

    const today = now().toISOString().slice(0, 10);
    if (currentDate === null) {
      currentDate = today;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } else if (today !== currentDate) {
      rotate(currentDate);
      currentDate = today;
    }

    const line = buildLine({ ts: now().toISOString(), slug, timeLeftMin, up, down });
    fs.appendFileSync(activePath, line + "\n");
    lastCombined = combined;
    lastSlug = slug;
  }

  return { record };
}
