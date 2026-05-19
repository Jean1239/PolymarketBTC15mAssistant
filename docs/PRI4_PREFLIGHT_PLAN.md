# Pri 4 — Pre-flight `calculateMarketPrice` no executor

Plano de execução. Aplicar quando quiser (não bloqueante; depende dos triggers em "Quando aplicar").

## Goal
Antes de submeter FAK, perguntar ao SDK qual fill price efetivo para o size pretendido. Rejeitar entry se fora da banda ou slippage > tolerância. Logar expected vs actual.

## Files a tocar
- `src/trading/orders.js` — wrapper `estimateFillPrice(client, tokenId, side, dollarAmount, orderType="FAK")`.
- `src/trading/executor.js` — chamar wrapper antes de `buyMarketOrder()`. Mesma lógica opcional para SELL (rejeição já existe via `slippageTolerancePct`; aqui ganho marginal).
- `src/config.js` — adicionar `preflightFillCheck` (bool). Reutilizar `slippageTolerancePct` + `entryMaxMarketPrice`.
- `src/trading/realTradeLog.js` — adicionar coluna `expected_fill_price` ao CSV.
- `CLAUDE.md` — documentar nova env var na tabela.

## Step-by-step

### 1. SDK lookup
Verificar assinatura exata em `node_modules/@polymarket/clob-client-v2/...` ou docs `/trading/clients/public#calculatemarketprice-6`:

```
client.calculateMarketPrice(tokenID, side, amount, orderType)
```

- `side` = "BUY" | "SELL"
- `amount` = dólares para BUY, shares para SELL (mesmo padrão do `createMarketOrder`)
- `orderType` = `OrderType.FAK`
- Retorna `number` (preço efetivo médio).

### 2. Wrapper em `orders.js`

```js
export async function estimateFillPrice({ client, tokenId, side, amount, orderType = OrderType.FAK }) {
  try {
    const price = await client.calculateMarketPrice(tokenId, side, amount, orderType);
    return { ok: true, price: Number(price) };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
```

Falha não trava trading — sinaliza para executor decidir.

### 3. Hook em `executor.js executeRealBuy`
Localizar bloco onde `simDecisionPrice` já está validado contra `entryMaxMarketPrice` (pre-flight cap atual). Adicionar APÓS esse cap, ANTES de `buyMarketOrder()`:

```js
if (CONFIG.trading.preflightFillCheck) {
  const est = await estimateFillPrice({ client, tokenId, side: "BUY", amount: invested });
  if (est.ok) {
    expectedFillPrice = est.price;
    const overBand = est.price > CONFIG.trading.entryMaxMarketPrice;
    const overSlip = (est.price - simDecisionPrice) / simDecisionPrice > CONFIG.trading.slippageTolerancePct;
    if (overBand || overSlip) {
      logSkip({ reason: overBand ? "preflight_band" : "preflight_slippage", est: est.price, sim: simDecisionPrice });
      return { ok: false, skipped: true, reason: "preflight" };
    }
  }
  // est.ok=false → log warning, prosseguir (fallback graceful).
}
```

### 4. Logging
- `./logs/trade_orders.log`: linha por skip com motivo + preço estimado.
- `real_*_trades.csv`: adicionar coluna `expected_fill_price` ao final do header (append-only para não quebrar leitores).
- Dashboard `logServer.js`: nenhuma mudança obrigatória — coluna nova aparece automaticamente em endpoints que leem CSV cru.

### 5. Config
Em `src/config.js trading`:

```js
preflightFillCheck: (process.env.TRADE_PREFLIGHT_FILL_CHECK ?? "true").toLowerCase() === "true",
```

Reutiliza `slippageTolerancePct` (já existe, default 0.02) e `entryMaxMarketPrice`.

Em `CLAUDE.md` tabela env:

| `TRADE_PREFLIGHT_FILL_CHECK` | `true` | Walk orderbook antes do FAK; skip BUY se fill efetivo > entryMax ou slippage > tolerância. Falha do SDK → fallback graceful (logado, prossegue). |

### 6. Test plan
- **Sanity unit** (sem mocks): rodar `node -e` chamando `estimateFillPrice` em market real, comparar com bestAsk do orderbook.
- **Dry-run live** (1 sessão): setar `TRADE_PREFLIGHT_FILL_CHECK=true` em prod, monitorar `trade_orders.log` por 24h. Verificar:
  - taxa de skip por `preflight_band` vs `preflight_slippage`.
  - se skip rate > 30% → tolerância muito apertada, afrouxar.
- **Comparar fill drift**: query `real_*_trades.csv` com vs sem flag. Median(`entry_price - expected_fill_price`) deve ficar < 0.5¢.

### 7. Rollback
- `TRADE_PREFLIGHT_FILL_CHECK=false` → desliga totalmente, código fica dormente.
- Reverter commit se logs mostrarem skips falsos por falhas transitórias do SDK (caso raro — wrapper já fallback).

## Edge cases

| Caso | Tratamento |
|---|---|
| SDK call falha (rate limit, timeout) | log warning, prosseguir com lógica atual. Não bloquear trades por problema infra. |
| Book vazio | SDK retorna NaN ou erro → fallback. Atual FAK já mata se sem liquidez. |
| Latência SDK > 200ms | Aceitável: bot poll 1s, sim já decidiu, +100-150ms até order send está dentro da janela do `slippageTolerancePct`. |
| Race: book muda entre estimativa e submit | `slippageTolerancePct` no executor pós-snapshot continua agindo. Pre-flight é primeira camada, não única. |
| SELL preflight | Skip nesse MR. Atual já tem `slippageTolerancePct` contra bestBid; SELL ROI já líquido após Pri 1+2. Marginal. |

## Critério de sucesso
- Median(actual_fill - expected_fill) < 0.5¢ over ≥50 fills.
- Zero trades real com fill > entryMaxMarketPrice (hoje 23%).
- Cum P&L melhora ≥ $0.10/trade vs baseline (proxy: 196 trades × ~$0.07 slippage cortado = ~$14 em ~200 trades).

## Esforço estimado
~1-2h código + 24h dry-run + commit. Total: meio dia útil.

## Quando aplicar
- Antes de subir `tradeAmount` $5 → $10+.
- Antes de aumentar `highConvictionMultiplier`.
- Se análise mostrar drift entry vs sim > 2¢ médio em runs futuros.

## Dependências
- Pri 1+2 (fee modeling) — feito em 2026-05-19, commit pendente.
- Pri 3 (`getClobMarketInfo.fd.r`) — opcional; útil só se expandir além de BTC. Não bloqueia Pri 4.
