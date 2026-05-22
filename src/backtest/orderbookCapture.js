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
