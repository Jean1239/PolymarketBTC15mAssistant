# Backtest Harness — Design

**Data:** 2026-05-22
**Status:** Aprovado (design) — pronto para plano de implementação
**Bot alvo:** 5m primeiro; harness genérico para 15m plugar depois

## Problema

Hoje toda mudança de estratégia (env vars, gates, pesos de scoring, indicadores)
é validada *depois* do deploy: roda em produção com dinheiro real, coleta logs
de nuvem, analisa CSVs à mão, tuna env vars. Ciclo lento e arriscado. O
`CLAUDE.md` está cheio de decisões tomadas sobre amostras pequenas (n≈10–30 por
hora) com risco claro de overfitting e listas de horas que "thrashavam" entre
análises.

Objetivo: poder **backtestar qualquer mudança de código ou estratégia antes do
deploy**, com fidelidade suficiente para confiar no resultado.

## Escopo

Quatro classes de mudança devem ser backtestáveis (todas escolhidas pelo usuário):

1. **Config / thresholds / gates** — bandas de entrada, regras de saída, horas/
   regimes bloqueados, gates de tempo.
2. **Engine / scoring** — pesos de `scoreDirection5m`, lógica de `decide5m`,
   `applyTimeAwareness5m`.
3. **Indicadores / períodos** — novos períodos de EMA, novo indicador, janela de
   RSI. Exige recomputar indicadores a partir de dados brutos.
4. **Modelo de fill / fee / slippage** — fills com profundidade de orderbook,
   parciais FAK, taker buffer.

**Forma:** harness CLI reutilizável + parameter sweep (grid-search) +
walk-forward (train/test).

**Verdict:** sem gate automático. O harness emite relatório completo (net P&L,
WR, por versão, por fase, drawdown, train vs test); o humano decide ship/no-ship.

### Realidade dos dados (restrição central)

| Dado | Recuperável retroativamente? |
|---|---|
| Klines 1m (preço, RSI, EMA, HA, VWAP) | Sim — Binance REST `fetchKlines` |
| Trades brutos (janela OFI) | Sim, com esforço — Binance `/api/v3/aggTrades` REST, janela recente |
| Profundidade de orderbook Polymarket | **Não** — sem API histórica. Tem de ser capturado ao vivo |
| `outcome` / `btc_at_settlement` | Sim — já gravado nos CSVs |

Consequência: backtest do **modelo de fill** só funciona em dados capturados
após o logger de orderbook entrar no ar. Por isso o logger é a Fase 0.

### Intervalo de tempo backtestável

Cada classe de mudança alcança um intervalo diferente, conforme o dado que
precisa:

| Classe de mudança | Dado necessário | Intervalo backtestável |
|---|---|---|
| Config / gates / engine | indicadores recordados nos CSV | toda a janela de logs existente — do log mais antigo (nuvem) até agora |
| Indicadores de preço (EMA/RSI/HA/VWAP) | klines Binance REST | anos pra trás; limite real = até onde a timeline de mercados nos CSV vai |
| OFI (order flow) | aggTrades brutos | recente via REST (semanas); histórico fundo via dumps diários `data.binance.vision` |
| **Modelo de fill / slippage** | profundidade de orderbook | **só do deploy da Fase 0 pra frente** — zero histórico |

Restrição que vale repetir: **backtest de fill é cego antes do deploy do
logger.** Quanto antes a Fase 0 subir, mais cedo a janela de 90 dias começa a
acumular.

## Abordagem escolhida — B: um caminho de código

Bot live e backtest chamam a **mesma** função `pipeline5m`. Difere só a *fonte*
de dados (driver live = streams; driver replay = dados históricos). Isso mata de
vez o drift sim/live (classe de bug recorrente — ver "sim/exec drift safety net"
no `CLAUDE.md`), porque não existem dois caminhos de orquestração para divergir.

Os módulos `src/indicators/` e `src/engines/` já são funções puras. Só a
*orquestração* em `src/index5m.js` (linhas ~151–188: cálculo de indicadores +
scoring + edge + decide) está emaranhada com o I/O dos streams. A abordagem B
extrai essa orquestração uma única vez.

Alternativas descartadas:
- **A — Replay puro de CSV:** só cobre config + engine-quando-indicadores-iguais.
  É, na prática, a Fase 1 da abordagem B.
- **C — Engine de backtest standalone:** duplica a orquestração → diverge do bot
  real com o tempo. Reintroduz exatamente o bug que se quer matar.

## Arquitetura

```
                      ┌─────────────────┐
  driver LIVE   ──────▶│                 │
  (streams)            │  pipeline5m()   │──▶ TickResult
  driver REPLAY ──────▶│  (função pura)  │   {rec, modelUp/Down, edge, ...}
  (dados históricos)   └─────────────────┘
```

### `pipeline5m(ctx, config) → TickResult`

Função pura. Sem I/O, sem rede. Recebe um `TickContext`, devolve um `TickResult`.

**`TickContext`** (montado pelo driver):

| Campo | Live | Replay |
|---|---|---|
| `klines1m[]` (OHLCV) | stream Binance | backfill Binance REST |
| `rawTrades[]` (janela OFI) | `binanceWsOfi` | aggTrades REST |
| `btcPrice`, `priceToBeat` | Chainlink WS | CSV gravado |
| `marketUp`, `marketDown`, `orderbook` | `fetchPolymarketSnapshot` | log capturado / CSV |
| `timeLeftMin`, `entryMinute`, `marketSlug`, `tickTimestamp` | derivado | CSV gravado |

**`TickResult`:** `{ rec, modelUp, modelDown, edgeUp, edgeDown, signal,
indicators{} }` — exatamente o que `dryRun.tick()` já consome hoje.

O `src/dryRun.js` já é replayável (`tick()` recebe valores prontos). Vira o
motor de simulação do backtest **sem mudança**.

### Layout de arquivos

```
src/backtest/
  pipeline5m.js        # função pura extraída de index5m.js
  orderbookCapture.js  # logger de profundidade (Fase 0)
  dataSource.js        # assembler de TickContext histórico (Fase 2)
  harness.js           # roda um backtest, coleta trades, gera resumo
  sweep.js             # grid-search sobre grade de params
  walkforward.js       # split train/test em folds rolantes
  report.js            # formata relatório (net, WR, por fase, drawdown)
scripts/
  backtest.js          # CLI
  smokeTestPipeline.js # golden test anti-drift
```

## Fases (ordem obrigatória)

### Fase 0 — Captura de orderbook

`src/backtest/orderbookCapture.js`. Engata no loop do `index5m.js`.
`fetchPolymarketSnapshot` já devolve `orderbook` — apenas serializar. Grava
JSONL append-only em `logs/orderbook_5m.jsonl`, uma linha por tick:

```
{ ts, slug, timeLeftMin, up:{bids:[[px,sz],...], asks:[...]}, down:{...} }
```

Fire-and-forget — não bloqueia o poll, zero impacto no bot. **Deve entrar no
ar primeiro** — é o único dado insubstituível.

**Decisões de gravação:**

- **Top-10 níveis por lado.** `summarizeOrderBook` já aceita `depthLevels`; o
  logger eleva para 10 e grava os níveis crus `[price, size]`. Fill model de
  trade de ~$5 nunca caminha mais que 1–2¢ de profundidade — capturar o book
  inteiro (~50 níveis) seria 4–5× o espaço sem ganho.
- **Dedup.** Grava a linha apenas quando o book mudou em relação ao tick
  anterior (mesmo mercado). Corta 3–5× — o book não muda a cada segundo.
- **Rotação diária + gzip.** Ao virar o dia-calendário, o arquivo do dia
  anterior é fechado e comprimido:
  ```
  logs/orderbook_5m.jsonl                ← dia corrente, sendo escrito
  logs/orderbook_5m_2026-05-21.jsonl.gz  ← dia anterior, fechado
  ```
  JSONL de orderbook comprime 8–12× (ladder de preço repetitivo).
- **Retenção 90 dias.** Os `.gz` com mais de 90 dias são podados
  automaticamente na rotação. Histórico de fill model = janela móvel de 90 dias.

### Estimativa de espaço em disco

Único consumidor contínuo novo é o `orderbook_5m.jsonl`. Demais dados são sob
demanda (ver Assembler) e transientes.

| Item | /dia | /mês | Pico (90d retenção) |
|---|---|---|---|
| Orderbook top-10 + gzip + dedup | ~1–2 MB | ~30–60 MB | **~150 MB** |
| Orderbook top-10 + gzip, sem dedup | ~6 MB | ~180 MB | ~540 MB |
| Saída de runs de backtest (`logs/backtest/`) | transiente | — | poucos MB/run |

Tudo vive no mesmo volume persistente dos CSV + `auth.db` (volume Coolify).
Com retenção de 90 dias o orderbook fica limitado a ~150 MB — não cresce sem
limite. **aggTrades histórico não é persistido** — buscado por janela e
descartado após a run (ver Assembler).

### Fase 1 — Extrair `pipeline5m`

Mover as linhas ~151–188 de `src/index5m.js` (indicadores + scoring + edge +
decide) para `src/backtest/pipeline5m.js`. `index5m.js` fica fino: monta o
`TickContext` a partir dos streams, chama `pipeline5m`, passa o `TickResult`
para display / `dryRun` / executor.

**Sem mudança de comportamento.** Refactor puro. Gate de aceite = golden test
(ver Verificação).

### Fase 2 — Assembler histórico

`src/backtest/dataSource.js`. Monta um iterator ordenado de `TickContext` para
um intervalo de tempo. Estratégia **híbrida** — minimiza re-fetch:

- timeline, `btcPrice`, `priceToBeat`, `marketSlug`, `timeLeft`, `outcome`,
  `btc_at_settlement` → CSVs gravados (`dryrun_5m.csv` / `signals_5m.csv`).
- `klines1m[]` → backfill Binance REST (`fetchKlines`, paginado).
- `rawTrades[]` → **nova** função: Binance `/api/v3/aggTrades` REST, paginada
  por tempo.
- `orderbook` → JSONL capturado na Fase 0; em janelas pré-captura, fallback
  para o preço recordado (`market_up`/`market_down`), marcado por-trade.

### Fase 3 — Harness + sweep

CLI `scripts/backtest.js`, exposta como `npm run backtest`.

```
npm run backtest -- --bot=5m --from=2026-05-15 --to=2026-05-22 \
  --config=variants/cap050.json
```

**Fluxo:** `dataSource` → para cada tick `pipeline5m(ctx, config)` → alimenta
uma instância **fresca** do `dryRun` simulator (escreve em
`logs/backtest/<run-id>/`, nunca toca CSV de produção) → settlement → coleta
trades.

**Saída:** journal de trades + resumo — net P&L, WR, n, por fase
(EARLY/MID/LATE), por banda de preço de entrada, max drawdown. Fee model =
`src/fees.js`. Fill model: caminha o book se há profundidade; senão preço
recordado + `takerBuffer` (igual ao `dryRun` atual), modo marcado por-trade.

**Sweep** — `--sweep variants/grid.json`:

```json
{ "entryMaxMarketPrice": [0.49, 0.50, 0.51, 0.52],
  "entryMinTimeLeftMin": [3, 4, 5] }
```

Produto cartesiano, um backtest por combinação, matriz ranqueada por net P&L.

**Walk-forward** — `--walkforward`: divide a timeline em folds rolantes
(train/test). Relatório mostra **train vs test lado a lado**. Sem gate
automático; a tabela escancara combos que só brilham no train.

## Verificação (anti-drift)

O risco de morte da abordagem B é o refactor da Fase 1 mudar comportamento
silenciosamente.

**Golden test** — `scripts/smokeTestPipeline.js`, exposto como
`npm run smoke:pipeline`. Gate de aceite da Fase 1. Pega linhas do
`dryrun_5m.csv` gravado, alimenta os valores recordados no `pipeline5m`, e faz
`assert` de que `rec` / `model_up` / `model_down` de saída batem com as colunas
recordadas (tolerância de float). Prova: pipeline extraído ≡ bot live.

**Validação de indicador** (Fase 2) — re-fetch de klines de uma janela
conhecida, recomputa `ema_cross` / `rsi` / `vwap`, compara com as colunas
recordadas. OFI tem tolerância maior, **documentada**: aggTrades REST não é
idêntico bit-a-bit ao stream de trades ao vivo.

**`npm run backtest:verify`** — roda golden test + validação de indicador.
Agrega à família `smoke:*` existente.

## Não-objetivos (YAGNI)

- Sem gate de ship/no-ship automático — o usuário lê o relatório e decide.
- Sem suporte a 15m na primeira entrega — harness fica genérico, 15m pluga
  depois.
- Sem dashboard/UI para o backtest — saída é CSV + relatório de texto.
- Sem otimização bayesiana ou ML de hiperparâmetros — grid-search basta.

## Critérios de sucesso

1. `npm run smoke:pipeline` passa — pipeline extraído reproduz o bot live.
2. `npm run backtest` reproduz, sobre dados históricos, o net P&L do journal de
   trades real dentro de uma tolerância documentada.
3. Um sweep sobre `entryMaxMarketPrice` reproduz a conclusão do `CLAUDE.md` de
   que a banda 0.52 é tóxica — validação do harness contra uma decisão conhecida.
4. Logger de orderbook acumula `logs/orderbook_5m.jsonl` sem impacto no poll.
