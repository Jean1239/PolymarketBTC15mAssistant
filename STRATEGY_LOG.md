# Strategy Log — Polymarket BTC Assistant

Cada entrada documenta o estado da estratégia em um snapshot de logs, com parâmetros-chave e desempenho do paper-trading acumulado até aquele ponto. Os snapshots são os arquivos em `logs/archive/`.

**Nota sobre os dados:** os snapshots de curto prazo (< 20 trades) têm alta variância estatística e não são representativos.

---

## Comandos úteis

Rodar os bots (cada um lê `--env-file=.env` automaticamente):
```bash
npm start         # 15m bot
npm run start:5m  # 5m bot
```

**Gerar relatório de performance acumulada** (sempre que trocar parâmetros, rodar para confirmar o baseline):
```bash
npm run report
```
O comando lê `logs/dryrun_15m_trades.csv` e `logs/dryrun_5m_trades.csv` e imprime win rate, PnL, profit factor, breakdown por motivo de saída, por lado, maior streak de wins/losses, ROI máximo/mínimo e duração média. É o indicador mais rápido para saber se uma mudança de parâmetro moveu a estratégia na direção esperada.

**Fluxo recomendado ao mudar parâmetro:**
1. Arquivar os logs atuais em `logs/archive/<data>_pre-<mudança>/` e registrar um snapshot aqui.
2. Editar o parâmetro (via `.env` ou default em `src/config*.js`).
3. Rodar o bot por ≥ 24h para acumular amostra mínima (>20 trades).
4. Rodar `npm run report` e comparar com o snapshot anterior nesta tabela.

---


## v13 — 2026-05-17

**Ref:** `logs/cloud/polymarket-logs-selected-2026-05-17.zip` (primeira corrida real significativa: 196 trades 5m em ~70h entre 2026-05-14 14:20Z e 2026-05-17 12:45Z)
**Foco:** corrigir o gap de execução de ~$22 entre real e dry-run e parar o overfitting do filtro de hora bloqueada.

### Baseline da corrida real (antes desta mudança)

| Métrica | REAL (196) | DRY mesma janela (249) | DRY aligned (198 mkts compartilhados) | REAL aligned (195 mkts) |
|---|---|---|---|---|
| Invest | $196 | $249 | — | — |
| PnL | **−$8.36** | **+$13.57** | +$2.54 | −$7.36 |
| ROI | −4.27% | +5.45% | — | — |
| WR | 50.5% | 52.4% | 50.5% | 50.8% |

WR praticamente igual ⇒ sinal do modelo OK. Gap de ~$22 = **execução**.

### Cause-decomp do gap

1. **Slippage de entrada — $4.83 perdidos**
   - Real pagou avg **+1.27¢/trade** vs preço sim.
   - 154/194 mkts: real entrou mais caro. Drag nos 96 wins = $4.83 perdidos (menos shares por $).
   - Causa: `takerBuffer = 0.10` deixava FAK comer até +10¢ acima do sim. Em mercado [0.50–0.60], 10¢ ≈ meia banda.

2. **51 mercados perdidos — $12.96 EV evaporada**
   - Dry pegou, real pulou. Dry: 29W / 17L / 5 TP → +$12.96 a 63% WR.
   - Causas:
     - 49 skips por slippage>tolerância (15× a 2%, 34× a 5%)
     - 23× `FAK_no_match` (compra)
     - 10× `maker_not_allowed` (compra, só dia 14/05 — wallet config estabilizou depois)
     - 8× falhas na venda (`balance_short` + `FAK_no_match`)

3. **Fills fora da banda configurada — 23% dos trades**
   - `entryMaxMarketPrice_5M = 0.52` mas 46/196 trades fecharam ≥ 0.54.
   - Buffer largo + ausência de cap pós-limit deixou FAK preencher acima do entryMax. Limite teórico ignorado na prática.

4. **Filtro de horário bloqueado provavelmente overfit**
   - Análise combinada de 449 trades dry-run (cloud + arquivos locais) mostra **zero horas com p<0.05**. Todos os 95% CIs cruzam zero.
   - Power analysis: detectar Δ=$0.30/trade com poder 0.8 e SD≈$0.95 precisa **n≈79 trades por hora**. Atual: 7–21/hora.
   - Histórico thrasha: H19 e H20 estavam unblocked em runs antigos e geraram +$1.79 / +$5.00 (100% WR n=13/15). Estão bloqueadas hoje por noise de uma janela menor.

### Changes

- **`takerBuffer` default 0.10 → 0.05** (`src/config.js`). Mantém FAK vivo em jitter normal de book sem deixar slippage destruir a EV do sim. Override via `TRADE_TAKER_BUFFER`.
- **Pre-flight cap `simDecisionPrice + takerBuffer ≤ entryMaxMarketPrice`** (`src/trading/executor.js — executeRealBuy`). Aborta BUY antes de postar a ordem se o limit ultrapassar a banda. Sim já contabiliza a entrada virtual; cancelar a perna real espelha o caminho do skip-por-slippage. Wired em `src/index.js` e `src/index5m.js` (novo parâmetro `entryMaxMarketPrice` na chamada).
- **Post-fill warning** quando `avgFillPrice > entryMaxMarketPrice` (`executor.js`). Caso o pre-flight passe mas um partial fill atravesse múltiplos níveis de ask, registra a deriva no `trade_orders.log` (caso raro mas observável).
- **15m `blockedHoursUtc`** `[0,8,9,11,17,18,19,21,22]` → **`[]`** (`src/config.js`).
- **5m `blockedHoursUtc`** `[2,3,4,6,10,16,19,20]` → **`[]`** (`src/config5m.js`).
  - Decisão: parar de cortar horas até termos volume estatístico mínimo (~80 trades/hora). Filtros de preço, regime e sinal continuam ativos — eles têm n por bucket muito maior e base mecânica clara. Override manual via env continua disponível.
- **`CLAUDE.md`** atualizado para `TRADE_TAKER_BUFFER`, `TRADE_BLOCKED_HOURS_UTC`, `TRADE_BLOCKED_HOURS_UTC_5M`.

### Parâmetros — 15m (defaults pós-v13)

| Parâmetro | Valor | Mudança? |
|---|---|---|
| `tradeAmount` | $5 | — |
| `takerBuffer` | **0.05** | ✱ |
| `entryMinMarketPrice` | 0.50 | — |
| `entryMaxMarketPrice` | 0.58 | — |
| `slippageTolerancePct` | 0.02 | — |
| `signalFlipMinProb` | 0.58 | — |
| `stopLossMinProb` | 0.65 | — |
| `stopLossMinDurationS` | 240 | — |
| `flipCooldownS` | 60 | — |
| `flipConfirmTicks` | 2 | — |
| `disableSignalFlip` | true | — |
| `disableStopLoss` | false | — |
| `disableTimeDecay` | true | — |
| `btcVsPtbMinAbsUsd` | 5 | — |
| `blockedHoursUtc` | **[]** | ✱ |
| `blockedRegimes` | [CHOP,RANGE] | — |

### Parâmetros — 5m (defaults pós-v13)

| Parâmetro | Valor | Mudança? |
|---|---|---|
| `tradeAmount` | $5 | — |
| `takerBuffer` | **0.05** | ✱ |
| `entryMinMarketPrice` | 0.50 | — |
| `entryMaxMarketPrice` | 0.52 | — |
| `slippageTolerancePct` | 0.02 | — |
| `signalFlipMinProb` | 0.62 | — |
| `disableStopLoss` | true | — |
| `disableSignalFlip` | true | — |
| `disableTimeDecay` | true | — |
| `flipCooldownS` | 90 | — |
| `flipConfirmTicks` | 5 | — |
| `blockedHoursUtc` | **[]** | ✱ |

### Impacto esperado vs v12

| Mudança | Bot | Efeito projetado |
|---|---|---|
| takerBuffer 0.10→0.05 | ambos | Recupera ~$3 de drag por slippage em ~100 wins. Pode aumentar `FAK_no_match` em mercados com book esparso — trade-off aceito vs fill fora da banda. |
| Pre-flight cap entryMax | ambos | Zera fills acima do `entryMaxMarketPrice` (eram 23% no run real). Esses 46 trades em [0.54+] no run real geraram +$1.38 líquido, então o ganho líquido é pequeno — mas a estratégia volta a respeitar o seu próprio gate, simplificando análise futura. |
| blockedHoursUtc → [] | ambos | Aumenta volume de trades (~30% mais entradas no 5m). Sem corte estatisticamente injustificado. Permite acumular n suficiente pra próxima análise validar (ou rejeitar) hour-edges. |

### Não mudado (mas investigar depois)

- **Bias UP −$8.52 vs DOWN +$0.16** no 5m (n=101/95). Pode ser microstructure ou viés do scoreDirection5m. Precisa amostra maior; com volume novo de v13, refazer breakdown side×price-bucket em ~1 semana.
- **`FAK_no_match` (23×)**: book real ficou atrás do sim entre tick e order-send. Alternativas: GTC com TTL curto + cancel, ou retry com bump único. Não mexido — mudança arquitetural maior.

### Critério de validação

Próximo ciclo precisa coletar **≥ 300 trades reais** antes de qualquer novo ajuste de filtro temporal. Métrica de sucesso primária:
- Gap de PnL real vs dry aligned ≤ $5 absoluto.
- Zero entradas com fill > `entryMaxMarketPrice`.
- Slippage média real-vs-sim ≤ 0.5¢.

Se WR continuar em ~50% mas o gap fechar, o sinal é insuficiente e precisamos repensar `scoreDirection5m`. Se WR subir com gap fechado, execução era o gargalo dominante.

---

## v12 — 2026-05-04

### Changes
- **Bug fix — `blockedHoursUtc` não propagado no simulador** (`dryRun.js`): `createDryRunSimulator15m/5m` construíam `config` linha a linha mas omitiam `blockedHoursUtc`, que caía em `?? []`. 34% das entradas 15m e 33% das 5m ocorreram em horas bloqueadas — dados v11 são sujos por este bug. Corrigido adicionando `blockedHoursUtc: tradingConfig.blockedHoursUtc ?? [...]` às duas factory functions.
- **15m `disableTimeDecay` `false` → `true`** (`config.js`, novo campo): 143/291 trades (49%) saíram via TIME_DECAY com −$139.86. Elevar `entryMinMarketPrice` para 0.50 fez todos os trades qualificarem para o trigger (que exige entry ≥ $0.50). Mesmo padrão do 5m em v10 (433 TD = −$159). Non-TD trades: 148, +$100.22, 73.6% WR. Env var: `TRADE_DISABLE_TIME_DECAY`. Propagado ao `baseExitEvalArgs` em `index.js` (estava ausente).
- **15m `blockedHoursUtc`** `[0,2,4,8,11,17,18,21]` → `[0,8,9,11,17,18,19,21,22]`: liberados H02 (+$1.81) e H04 (+$2.32); adicionados H09 (−$6.75), H19 (−$7.36), H22 (−$4.27).
- **5m `blockedHoursUtc`** `[2,3,6,10,16,19,20,21]` → `[2,3,4,6,10,16,19,20]`: liberado H21 (+$10.49, melhor hora — bloqueada por engano); adicionado H04 (−$8.43, pior hora não bloqueada).
- **Defaults das factory functions alinhados** (`dryRun.js`): todos os fallbacks `?? X` agora espelham os defaults de `config.js`/`config5m.js`.
- **`index5m.js`**: `disableTimeDecay ?? false` → `?? true` (fallback defensivo correto).

### Parameters — 15m bot (code defaults, no env overrides)

| Parameter | Value |
|---|---|
| tradeAmount | 5 |
| entryMinMarketPrice | 0.50 |
| entryMaxMarketPrice | 0.58 |
| takeProfitPct | 20 |
| stopLossPct | 25 |
| signalFlipMinProb | 0.58 |
| stopLossMinProb | 0.65 |
| stopLossMinDurationS | 240 |
| flipCooldownS | 60 |
| flipConfirmTicks | 2 |
| disableSignalFlip | true |
| disableStopLoss | false |
| disableTimeDecay | true |
| btcVsPtbMinAbsUsd | 5 |
| blockedHoursUtc | [0,8,9,11,17,18,19,21,22] |
| blockedRegimes | [CHOP,RANGE] |
| highConvictionMultiplier | 2 |
| highConvictionMinProb | 0.70 |
| highConvictionEntryMin | 0.50 |
| highConvictionEntryMax | 0.52 |

### Parameters — 5m bot (code defaults, no env overrides)

| Parameter | Value |
|---|---|
| tradeAmount | 5 |
| entryMinMarketPrice | 0.50 |
| entryMaxMarketPrice | 0.52 |
| takeProfitPct | 20 |
| stopLossPct | 25 |
| disableStopLoss | true |
| signalFlipMinProb | 0.62 |
| disableSignalFlip | true |
| disableTimeDecay | true |
| flipCooldownS | 90 |
| flipConfirmTicks | 5 |
| blockedHoursUtc | [2,3,4,6,10,16,19,20] |

### Baseline results (before this change)

v11 run — 2026-04-30 a 2026-05-04 (291 trades 15m / 592 trades 5m) — **dados sujos** (blockedHoursUtc bug ativo):

| Bot | Trades | WR | PnL | PF |
|---|---|---|---|---|
| 15m | 291 | 37.5% | −$39.64 | 0.76 |
| 5m | 592 | 55.1% | +$29.15 | 1.11 |

Exit reasons 15m: SETTLED_WIN 108 (+$128.43) · TIME_DECAY 143 (−$139.86) · STOP_LOSS 39 (−$28.41) · TAKE_PROFIT 1 (+$0.20)

Exit reasons 5m: SETTLED_WIN 298 (+$285.85) · SETTLED_LOSS 266 (−$266.00) · TAKE_PROFIT 28 (+$9.31)

Nota: 5m DOWN bias estrutural (DOWN 60.3% WR vs UP 49.7%, 5 dias consecutivos) — monitorar nos próximos runs.

### Estimated impact

- **Bug blockedHoursUtc**: +$19 (15m) / +$4 (5m) — trades em horas ruins bloqueados corretamente
- **disableTimeDecay 15m**: +$25 a +$66 (cenário realista a otimista com hold-to-settlement)
- **Blocked hours 15m**: +$18/5dias líquido (H09+H19+H22 bloqueados; H02+H04 liberados)
- **5m H21 liberado**: +$10/5dias
- **5m H04 bloqueado**: +$8/5dias
- **Combinado**: potencial reversão do 15m de −$39 para positivo; 5m mantém trajetória crescente

---

## Versão anterior — v11

**Ref:** `logs/cloud/extracted/today/` (análise do zip `polymarket-logs-2026-04-29.zip`)  
**Hash:** *(a ser preenchido após commit)*  
**Data:** 2026-04-29  
**Ambiente:** cloud — nenhuma env var definida, todos os parâmetros são os **defaults do código**

### Mudanças vs v10
Introduzidas após análise dos 209 trades 15m / 613 trades 5m do cloud run v10 (2026-04-27 a 2026-04-29):

1. **5m: desabilitar TIME_DECAY** (`disableTimeDecay = true` em config5m.js). 433 saídas TIME_DECAY geraram −$159.63 enquanto 161 SETTLED_WINs produziram +$154.79 (97.6% win rate). Mesmo padrão do stop-loss e signal-flip já desabilitados: early exit destrói o que seria resolução favorável. Configurável via `TRADE_DISABLE_TIME_DECAY_5M`.

2. **15m: subir `entryMinMarketPrice` de 0.45 → 0.50**. Faixa [0.45–0.50) teve win rate em settlement de 43–48% (abaixo de 50% = odds piores que cara ou coroa). Faixa [0.50–0.52) teve 94.7%; [0.55–0.60) teve 100%. O modelo discorda fortemente do mercado ao entrar barato — e o mercado está certo nessas situações.

3. **15m: novo filtro `btcVsPtbMinAbsUsd = 5`**. Bloqueia entradas quando |BTC − priceToBeat| < $5. Zona de indecisão concentrou 68% das entradas (142/209) com win rate 41.5% e PnL −$14.08. Quando BTC está claramente acima ou abaixo do PTB, o modelo acerta muito mais. Configurável via `TRADE_BTC_VS_PTB_MIN_USD`.

4. **15m: aumentar `stopLossMinDurationS` de 120 → 240s**. 18 dos 34 STOP_LOSSes dispararam exatamente na borda dos 120s. Análise hipotética sugere que segurar mais tempo seria melhor na maioria dos casos (consistente com o padrão 5m).

5. **15m: atualizar `blockedHoursUtc`**: `[0,1,2,5,6,15,16]` → `[0,2,4,8,11,17,18,21]`. Removidos H1,H5,H6,H15,H16 (positivos no período: H16 +$4.93, H15 +$2.81). Adicionados H4 (−$3.29), H8 (−$3.83), H11 (−$3.30), H17 (−$3.04), H18 (−$7.58), H21 (−$2.25).

6. **5m: atualizar `blockedHoursUtc`**: `[6,10,16,21,22,23]` → `[2,3,6,10,16,19,20,21]`. Removidos H22 (+$0.27), H23 (+$2.39). Adicionados H2 (−$3.93), H3 (−$4.92), H19 (−$1.03), H20 (−$2.89).

7. **15m: realinhar faixa de alta convicção**: `[0.45–0.50)` → `[0.50–0.52)`. A faixa anterior agora está fora do range de entrada permitido. A nova faixa coincide com o sweet spot de 94.7% win rate em settlement.

### Parâmetros — 15m
| Parâmetro | Valor | Env var |
|---|---|---|
| `tradeAmount` | $5 (base) | `POLYMARKET_TRADE_AMOUNT` |
| `takeProfitPct` | 20% | `TRADE_TAKE_PROFIT_PCT` |
| `stopLossPct` | 25% | `TRADE_STOP_LOSS_PCT` |
| `signalFlipMinProb` | 0.58 | `TRADE_SIGNAL_FLIP_PROB` |
| `stopLossMinProb` | 0.65 | `TRADE_SL_MIN_PROB` |
| `stopLossMinDurationS` | **240s** ✱ | `TRADE_SL_MIN_DURATION_S` |
| `flipCooldownS` | 60s | `TRADE_FLIP_COOLDOWN_S` |
| `flipConfirmTicks` | 2 | `TRADE_FLIP_CONFIRM_TICKS` |
| `ptbSafeMarginUsd` | 30 | `TRADE_PTB_SAFE_MARGIN_USD` |
| `disableStopLoss` | false | `TRADE_DISABLE_STOP_LOSS` |
| `disableSignalFlip` | true | `TRADE_DISABLE_SIGNAL_FLIP` |
| `entryMinMarketPrice` | **0.50** ✱ | `TRADE_ENTRY_MIN_PRICE` |
| `entryMaxMarketPrice` | 0.58 | `TRADE_ENTRY_MAX_PRICE` |
| `btcVsPtbMinAbsUsd` | **5** ✱ | `TRADE_BTC_VS_PTB_MIN_USD` |
| `blockedHoursUtc` | **[0,2,4,8,11,17,18,21]** ✱ | `TRADE_BLOCKED_HOURS_UTC` |
| `blockedRegimes` | [CHOP,RANGE] | `TRADE_BLOCKED_REGIMES` |
| `timeDecayMinLeftMin` | 1.5 min | `TRADE_TIME_DECAY_MIN_LEFT_MIN` |
| `timeDecayMinLossPct` | 5% | `TRADE_TIME_DECAY_MIN_LOSS_PCT` |
| `highConvictionMultiplier` | 2× | `TRADE_HIGH_CONVICTION_MULT` |
| `highConvictionMinProb` | 0.70 | `TRADE_HIGH_CONVICTION_MIN_PROB` |
| `highConvictionEntryMin` | **0.50** ✱ | `TRADE_HIGH_CONVICTION_ENTRY_MIN` |
| `highConvictionEntryMax` | **0.52** ✱ | `TRADE_HIGH_CONVICTION_ENTRY_MAX` |

### Parâmetros — 5m
| Parâmetro | Valor | Env var |
|---|---|---|
| `tradeAmount` | $5 (base) | `POLYMARKET_TRADE_AMOUNT` |
| `takeProfitPct` | 20% | `TRADE_TAKE_PROFIT_PCT` |
| `stopLossPct` | 25% | `TRADE_STOP_LOSS_PCT` |
| `signalFlipMinProb` | 0.62 | `TRADE_SIGNAL_FLIP_PROB` |
| `stopLossMinProb` | 0.65 | `TRADE_SL_MIN_PROB` |
| `stopLossMinDurationS` | 120s | `TRADE_SL_MIN_DURATION_S` |
| `flipCooldownS` | 90s | `TRADE_FLIP_COOLDOWN_S` |
| `flipConfirmTicks` | 5 | `TRADE_FLIP_CONFIRM_TICKS` |
| `ptbSafeMarginUsd` | 30 | `TRADE_PTB_SAFE_MARGIN_USD` |
| `disableStopLoss` | true | `TRADE_DISABLE_STOP_LOSS_5M` |
| `disableSignalFlip` | true | `TRADE_DISABLE_SIGNAL_FLIP_5M` |
| `disableTimeDecay` | **true** ✱ | `TRADE_DISABLE_TIME_DECAY_5M` |
| `entryMinMarketPrice` | 0.50 | `TRADE_ENTRY_MIN_PRICE_5M` |
| `entryMaxMarketPrice` | 0.52 | `TRADE_ENTRY_MAX_PRICE_5M` |
| `blockedHoursUtc` | **[2,3,6,10,16,19,20,21]** ✱ | `TRADE_BLOCKED_HOURS_UTC_5M` |
| `timeDecayMinLeftMin` | 2.5 min | `TRADE_TIME_DECAY_MIN_LEFT_MIN_5M` |
| `timeDecayMinLossPct` | 15% | `TRADE_TIME_DECAY_MIN_LOSS_PCT_5M` |
| `highConvictionMultiplier` | 1 (off) | `TRADE_HIGH_CONVICTION_MULT_5M` |

✱ = mudanças desta versão.

### Impacto esperado vs v10
| Mudança | Bot | Efeito projetado |
|---|---|---|
| disableTimeDecay | 5m | +$50 a +$150/67h (elimina −$159 de TIME_DECAY; assume 40–50% win rate held-to-settlement) |
| entryMin 0.45→0.50 | 15m | Elimina ~125 trades em [0.45–0.50) que somaram −$14.59 |
| btcVsPtb filter | 15m | Elimina ~68% das entradas em zona indecisa (win rate 41.5%); reduz volume mas melhora qualidade |
| SL duration 120→240s | 15m | Evita os 18 SLs na borda 120–180s; menor impacto absoluto |
| Blocked hours update | 15m | Libera H15,H16 (+$7.74); bloqueia H4,H8,H11,H17,H18,H21 (−$23.29) |
| Blocked hours update | 5m | Libera H22,H23 (+$2.66); bloqueia H2,H3,H19,H20 (−$10.77) |

### Mudanças de lógica (código — sem env var nova)
| Componente | Antes | Depois | Razão |
|---|---|---|---|
| `position.js — evaluateExit` | `disableTimeDecay` não existia | Novo param `disableTimeDecay = false`; TIME_DECAY pode ser suprimido | Espelha o mesmo padrão de disableStopLoss / disableSignalFlip |
| `dryRun.js — entry gate` | Price range + hour filter | + `btcVsPtbMinAbsUsd` filter | Filtro de PTB agora no simulator também |
| `executor.js — buy gate` | Price range + hour filter | + `btcVsPtbMinAbsUsd` filter; aceita `btcPrice`/`priceToBeat` no ctx | Live trading e simulator ficam simétricos |


---


## Versão atual — v10

**Ref:** `logs/archive/2026-04-26` (cloud run — baseline desta versão)  
**Hash:** `b03ec16`  
**Data:** 2026-04-27  
**Ambiente:** cloud — nenhuma env var definida, todos os parâmetros são os **defaults do código**

### Mudanças vs v9
Introduzidas após análise dos 110 trades 15m / 394 trades 5m da primeira rodada cloud (2026-04-26):

1. **Filtro de horário UTC — 15m** (`blockedHoursUtc`). Horas 00–02h, 05–06h, 15–16h UTC suprimem novas entradas. Análise mostrou PnL sistematicamente negativo nesses janelas: os 28 trades excluídos geraram −$21.64, enquanto os 82 restantes teriam gerado +$26.33 (vs +$4.68 total). Configurável via `TRADE_BLOCKED_HOURS_UTC`.

2. **Filtro de horário UTC — 5m** (`blockedHoursUtc` no config5m). Horas 06h, 10h, 16h, 21–23h UTC bloqueadas. Os 130 trades nesses horários geraram −$20.36; os 264 restantes +$18.78 (vs −$1.58 total). Configurável via `TRADE_BLOCKED_HOURS_UTC_5M`.

3. **Rebaixado teto de entrada 5m: 0.60 → 0.52** (`entryMaxMarketPrice`). Segmentação por faixa: entry ≥ 0.52 gerou −$11.44 em 219 trades; entry < 0.52 gerou +$9.86 em 175 trades. Entrar em preços mais altos significa pagar mais pelo mesmo sinal com maior rejeição do mercado. Configurável via `TRADE_ENTRY_MAX_PRICE_5M`.

4. **Filtro de regime no 15m — CHOP e RANGE bloqueados** (`blockedRegimes` em `edge.js`). A segunda metade dos trades (56–110) mostrou TIME_DECAY dobrando (6→12) e STOP_LOSS dobrando (5→11), sugerindo mercado choppier. Entradas em CHOP/RANGE têm menor direcionalidade e maior probabilidade de saída prematura. Retorna `NO_TRADE` com reason `regime_chop`/`regime_range`. Configurável via `TRADE_BLOCKED_REGIMES`.

5. **Filtro OFI exclusivo no 5m** (`edge5m.js`). Antes bloqueava só se HA **e** OFI fossem contrários à direção. Agora OFI sozinho com `|ofi_1m| > 0.05` é suficiente para bloquear. Racional: OFI é o sinal primário do modelo 5m — entrar contra o fluxo de ordens é noise, não edge, independente do que HA diz. Retorna reason `ofi_conflict`.

### Parâmetros — 15m
| Parâmetro | Valor | Env var |
|---|---|---|
| `tradeAmount` | $5 (base) | `POLYMARKET_TRADE_AMOUNT` |
| `takeProfitPct` | 20% | `TRADE_TAKE_PROFIT_PCT` |
| `stopLossPct` | 25% | `TRADE_STOP_LOSS_PCT` |
| `signalFlipMinProb` | 0.58 | `TRADE_SIGNAL_FLIP_PROB` |
| `stopLossMinProb` | 0.65 | `TRADE_SL_MIN_PROB` |
| `stopLossMinDurationS` | 120s | `TRADE_SL_MIN_DURATION_S` |
| `flipCooldownS` | 60s | `TRADE_FLIP_COOLDOWN_S` |
| `flipConfirmTicks` | 2 | `TRADE_FLIP_CONFIRM_TICKS` |
| `ptbSafeMarginUsd` | 30 | `TRADE_PTB_SAFE_MARGIN_USD` |
| `disableStopLoss` | false | `TRADE_DISABLE_STOP_LOSS` |
| `disableSignalFlip` | true | `TRADE_DISABLE_SIGNAL_FLIP` |
| `entryMinMarketPrice` | 0.45 | `TRADE_ENTRY_MIN_PRICE` |
| `entryMaxMarketPrice` | 0.58 | `TRADE_ENTRY_MAX_PRICE` |
| `blockedHoursUtc` | **[0,1,2,5,6,15,16]** ✱ | `TRADE_BLOCKED_HOURS_UTC` |
| `blockedRegimes` | **[CHOP,RANGE]** ✱ | `TRADE_BLOCKED_REGIMES` |
| `timeDecayMinLeftMin` | 1.5 min | `TRADE_TIME_DECAY_MIN_LEFT_MIN` |
| `timeDecayMinLossPct` | 5% | `TRADE_TIME_DECAY_MIN_LOSS_PCT` |
| `highConvictionMultiplier` | 2× | `TRADE_HIGH_CONVICTION_MULT` |
| `highConvictionMinProb` | 0.70 | `TRADE_HIGH_CONVICTION_MIN_PROB` |
| `highConvictionEntryMin` | 0.45 | `TRADE_HIGH_CONVICTION_ENTRY_MIN` |
| `highConvictionEntryMax` | 0.50 | `TRADE_HIGH_CONVICTION_ENTRY_MAX` |

### Parâmetros — 5m
| Parâmetro | Valor | Env var |
|---|---|---|
| `tradeAmount` | $5 (base) | `POLYMARKET_TRADE_AMOUNT` |
| `takeProfitPct` | 20% | `TRADE_TAKE_PROFIT_PCT` |
| `stopLossPct` | 25% | `TRADE_STOP_LOSS_PCT` |
| `signalFlipMinProb` | 0.62 | `TRADE_SIGNAL_FLIP_PROB` |
| `stopLossMinProb` | 0.65 | `TRADE_SL_MIN_PROB` |
| `stopLossMinDurationS` | 120s | `TRADE_SL_MIN_DURATION_S` |
| `flipCooldownS` | 90s | `TRADE_FLIP_COOLDOWN_S` |
| `flipConfirmTicks` | 5 | `TRADE_FLIP_CONFIRM_TICKS` |
| `ptbSafeMarginUsd` | 30 | `TRADE_PTB_SAFE_MARGIN_USD` |
| `disableStopLoss` | true | `TRADE_DISABLE_STOP_LOSS_5M` |
| `disableSignalFlip` | true | `TRADE_DISABLE_SIGNAL_FLIP_5M` |
| `entryMinMarketPrice` | 0.50 | `TRADE_ENTRY_MIN_PRICE_5M` |
| `entryMaxMarketPrice` | **0.52** ✱ | `TRADE_ENTRY_MAX_PRICE_5M` |
| `blockedHoursUtc` | **[6,10,16,21,22,23]** ✱ | `TRADE_BLOCKED_HOURS_UTC_5M` |
| `timeDecayMinLeftMin` | 2.5 min | `TRADE_TIME_DECAY_MIN_LEFT_MIN_5M` |
| `timeDecayMinLossPct` | 15% | `TRADE_TIME_DECAY_MIN_LOSS_PCT_5M` |
| `highConvictionMultiplier` | 1 (off) | `TRADE_HIGH_CONVICTION_MULT_5M` |

✱ = mudanças desta versão. Todos os valores acima são **defaults hardcoded no código** — o ambiente cloud não define nenhuma env var. As colunas "Env var" indicam como sobrescrever localmente se necessário.

### Mudanças de lógica (sem env var)
| Componente | Antes | Depois | Razão |
|---|---|---|---|
| `edge5m.js` — filtro de alinhamento | Bloqueava se HA **e** OFI contrários | Bloqueia se OFI contrário (sozinho) | OFI é sinal primário; HA secundário. Exigir ambos era permissivo demais |
| `edge.js` — `decide()` | Sem filtro de regime | Aceita `regime` + `blockedRegimes`; bloqueia CHOP/RANGE por default | CHOP/RANGE têm direcionalidade insuficiente para sinal confiável |
| `dryRun.js` — gate de BUY | Price range + cooldown | + UTC hour filter | Espelha a mesma lógica do executor live |
| `executor.js` — gate de compra | Price range check | + UTC hour filter com mensagem de status | Consistência com simulator |

### Desempenho do baseline (cloud run 2026-04-26 — pré-mudanças v10)
| Bot | Trades | Win | Loss | Win Rate | PnL | Profit Factor | Max DD | Pior streak |
|---|---|---|---|---|---|---|---|---|
| 15m | 110 | 49 | 61 | 44.5% | +$4.68 | 1.07 | $17.81 | 10 |
| 5m | 394 | 118 | 276 | 29.9% | −$1.58 | 0.98 | $16.04 | 17 |

### Exit reasons — 15m (baseline cloud)
| Razão | Count | Win% | PnL total | Avg/trade |
|---|---|---|---|---|
| SETTLED_WIN | 46 | 100% | +$73.93 | +$1.61 |
| SETTLED_LOSS | 27 | 0% | −$49.00 | −$1.81 |
| TIME_DECAY | 18 | 0% | −$12.96 | −$0.72 |
| STOP_LOSS | 16 | 0% | −$8.60 | −$0.54 |
| TAKE_PROFIT | 3 | 100% | +$1.32 | +$0.44 |

### Exit reasons — 5m (baseline cloud)
| Razão | Count | Win% | PnL total | Avg/trade |
|---|---|---|---|---|
| SETTLED_WIN | 110 | 100% | +$98.66 | +$0.90 |
| TAKE_PROFIT | 8 | 100% | +$2.75 | +$0.34 |
| TIME_DECAY | 276 | 0% | −$102.99 | −$0.37 |

### Análise de impacto estimado dos filtros v10 (contra baseline cloud)
| Filtro | Bot | Trades bloqueados | PnL recuperado |
|---|---|---|---|
| Horário UTC | 15m | 28 de 110 | ~+$21.64 (trades ruins evitados) |
| Horário UTC | 5m | 130 de 394 | ~+$20.36 (trades ruins evitados) |
| Entry max 0.52 | 5m | 219→175 entradas válidas | ~+$11.44 (entries ≥0.52 evitadas) |

Impacto simulado combinado: 15m +$4.68 → ~+$26 / 5m −$1.58 → ~+$19 (antes dos filtros de regime e OFI, sem dados suficientes para quantificar esses).

### Desempenho real da v10 (cloud run 2026-04-27 → 2026-04-29)

**Ref:** `logs/cloud/extracted/today/` (zip `polymarket-logs-2026-04-29.zip`)  
**Período:** 2026-04-27T02:30Z → 2026-04-29T22:18Z (~67h)

| Bot | Trades | Win | Loss | Win Rate | PnL | Profit Factor | Max DD | Pior streak |
|---|---|---|---|---|---|---|---|---|
| 15m | 209 | 96 | 113 | 45.9% | −$3.09 | 0.98 | $31.02 | 7 |
| 5m | 613 | 176 | 437 | 28.7% | −$4.76 | 0.97 | $18.17 | 13 |

#### Exit reasons — 15m
| Razão | Count | Win% | PnL total | Avg/trade |
|---|---|---|---|---|
| SETTLED_WIN | 87 | 100% | +$131.55 | +$1.51 |
| TAKE_PROFIT | 9 | 100% | +$2.84 | +$0.32 |
| STOP_LOSS | 34 | 0% | −$22.54 | −$0.66 |
| TIME_DECAY | 19 | 0% | −$14.94 | −$0.79 |
| SETTLED_LOSS | 60 | 0% | −$100.00 | −$1.67 |

#### Exit reasons — 5m
| Razão | Count | Win% | PnL total | Avg/trade |
|---|---|---|---|---|
| SETTLED_WIN | 161 | 100% | +$154.79 | +$0.96 |
| TAKE_PROFIT | 15 | 100% | +$4.07 | +$0.27 |
| SETTLED_LOSS | 4 | 0% | −$4.00 | −$1.00 |
| TIME_DECAY | 433 | 0% | **−$159.63** | −$0.37 |

#### PnL por dia (UTC)
| Data | 15m (N / WR / PnL) | 5m (N / WR / PnL) |
|---|---|---|
| 2026-04-27 | 80 / 53.8% / +$18.46 | 231 / 24.2% / −$11.24 |
| 2026-04-28 | 81 / 37.0% / **−$28.40** | 242 / 30.6% / +$1.56 |
| 2026-04-29 | 48 / 47.9% / +$6.85 | 140 / 32.9% / +$4.91 |

#### Diagnóstico — por que v10 ficou no negativo

**15m: SETTLED_LOSS é o principal dreno (60 trades, −$100)**
- 35 das 60 SETTLED_LOSS entraram abaixo de $0.48 (win rate em settlement: 48.5%)
- 22 entraram em [0.48–0.50) (win rate: 43.6%)
- Apenas 3 entraram em [0.50–0.52) (win rate: **94.7%** — filtro mínimo resolveria quase tudo)
- Acima de $0.50: settlement win rate é 82–100%. Abaixo: <50% (modelo discorda do mercado quando mercado está certo)

**5m: TIME_DECAY destruiu todo o PnL (433 trades, −$159.63)**
- 5m tinha `disableSignalFlip = true` e `disableStopLoss = true` desde v8
- TIME_DECAY era o único early exit ativo e consumiu −$159.63
- 97.6% settled win rate (161/165 settled) confirma: hold-to-settlement domina no 5m
- TIME_DECAY corta nas últimas 1.5 min quando a posição está perdendo — mas mesmo posições que estavam caindo frequentemente invertiam ou o mercado resolvia a favor do lado correto

**15m: horas bloqueadas desatualizadas**
- v10 bloqueou H1,H5,H6,H15,H16 — mas todos esses geraram PnL **positivo** no período (H16: +$4.93, H15: +$2.81)
- H4, H8, H11, H17, H18, H21 não estavam bloqueados e geraram −$3.29, −$3.83, −$3.30, −$3.04, −$7.58, −$2.25

**15m: entradas em zona de indecisão (|btc_vs_ptb| < $5)**
- 142 das 209 entradas (68%) ocorreram com BTC dentro de $5 do PTB → win rate 41.5%, PnL −$14.08
- Entradas com BTC >$20 abaixo do PTB: 75% win rate, +$8.52


---

## Snapshot: v9 — `d36b3f4`

**Data:** 2026-04-17 (local) / 2026-04-26 (cloud run que gerou o baseline de v10)  
**Baseline arquivado em:** `logs/archive/2026-04-17_pre-entry-filter-and-15m-flip-disable/`  
**Ambiente cloud:** nenhuma env var definida — parâmetros abaixo são os defaults do código naquele commit

### Mudanças vs v8
1. **Ativado filtro de preço de entrada em ambos os bots** (`entryMinMarketPrice` / `entryMaxMarketPrice`). Estava disponível mas desativado (0–1). Defaults agora baseados em análise por faixa de PnL.
2. **Desabilitado SIGNAL_FLIP no 15m** (`disableSignalFlip = true`). 25 flips causaram −$9.00 (51% dos trades) — mesmo padrão que justificou desabilitar no 5m.
3. **Endurecido TIME_DECAY no 5m**: `timeLeftMin < 2.5` + loss `> 15%` (antes: <1.5 + >5%). TIME_DECAY custou −$13.25 em 17 trades, a maioria com recuperação negligenciável no final.
4. **Sizing de alta convicção no 15m**: `highConvictionMultiplier = 2` quando entrada ∈ [0.45, 0.50] e prob do lado escolhido ≥ 0.70. Aproveita a faixa 0.45–0.49 que historicamente traz +$1.28 em 26 trades.

### Parâmetros — 15m
| Parâmetro | Valor | Origem |
|---|---|---|
| `tradeAmount` | $1 (base) | `POLYMARKET_TRADE_AMOUNT` |
| `takeProfitPct` | 20% | `TRADE_TAKE_PROFIT_PCT` |
| `stopLossPct` | 25% | `TRADE_STOP_LOSS_PCT` |
| `signalFlipMinProb` | 0.58 | `TRADE_SIGNAL_FLIP_PROB` |
| `stopLossMinProb` | 0.65 | `TRADE_SL_MIN_PROB` |
| `stopLossMinDurationS` | 120s | `TRADE_SL_MIN_DURATION_S` |
| `flipCooldownS` | 60s | `TRADE_FLIP_COOLDOWN_S` |
| `flipConfirmTicks` | 2 | `TRADE_FLIP_CONFIRM_TICKS` |
| `ptbSafeMarginUsd` | 30 | `TRADE_PTB_SAFE_MARGIN_USD` |
| `disableStopLoss` | false | `TRADE_DISABLE_STOP_LOSS` |
| `disableSignalFlip` | true ✱ | `TRADE_DISABLE_SIGNAL_FLIP` |
| `entryMinMarketPrice` | 0.45 ✱ | `TRADE_ENTRY_MIN_PRICE` |
| `entryMaxMarketPrice` | 0.58 ✱ | `TRADE_ENTRY_MAX_PRICE` |
| `timeDecayMinLeftMin` | 1.5 min | `TRADE_TIME_DECAY_MIN_LEFT_MIN` |
| `timeDecayMinLossPct` | 5% | `TRADE_TIME_DECAY_MIN_LOSS_PCT` |
| `highConvictionMultiplier` | 2× ✱ | `TRADE_HIGH_CONVICTION_MULT` |
| `highConvictionMinProb` | 0.70 | `TRADE_HIGH_CONVICTION_MIN_PROB` |
| `highConvictionEntryMin` | 0.45 | `TRADE_HIGH_CONVICTION_ENTRY_MIN` |
| `highConvictionEntryMax` | 0.50 | `TRADE_HIGH_CONVICTION_ENTRY_MAX` |

### Parâmetros — 5m
| Parâmetro | Valor | Origem |
|---|---|---|
| `tradeAmount` | $1 (base) | `POLYMARKET_TRADE_AMOUNT` |
| `takeProfitPct` | 20% | `TRADE_TAKE_PROFIT_PCT` |
| `stopLossPct` | 25% | `TRADE_STOP_LOSS_PCT` |
| `signalFlipMinProb` | 0.62 | `TRADE_SIGNAL_FLIP_PROB` |
| `stopLossMinProb` | 0.65 | `TRADE_SL_MIN_PROB` |
| `stopLossMinDurationS` | 120s | `TRADE_SL_MIN_DURATION_S` |
| `flipCooldownS` | 90s | `TRADE_FLIP_COOLDOWN_S` |
| `flipConfirmTicks` | 5 | `TRADE_FLIP_CONFIRM_TICKS` |
| `ptbSafeMarginUsd` | 30 | `TRADE_PTB_SAFE_MARGIN_USD` |
| `disableStopLoss` | true | `TRADE_DISABLE_STOP_LOSS_5M` |
| `disableSignalFlip` | true | `TRADE_DISABLE_SIGNAL_FLIP_5M` |
| `entryMinMarketPrice` | 0.50 ✱ | `TRADE_ENTRY_MIN_PRICE_5M` |
| `entryMaxMarketPrice` | 0.60 ✱ | `TRADE_ENTRY_MAX_PRICE_5M` |
| `timeDecayMinLeftMin` | 2.5 min ✱ | `TRADE_TIME_DECAY_MIN_LEFT_MIN_5M` |
| `timeDecayMinLossPct` | 15% ✱ | `TRADE_TIME_DECAY_MIN_LOSS_PCT_5M` |
| `highConvictionMultiplier` | 1 (off) | `TRADE_HIGH_CONVICTION_MULT_5M` |

✱ = mudanças desta versão. Valores são defaults hardcoded no código naquele commit — sem env var overrides.

### Desempenho (paper-trading acumulado — pré-mudança, via `npm run report`)
| Bot | Trades | Win | Loss | Win Rate | PnL | Profit Fac | Avg Win | Avg Loss |
|---|---|---|---|---|---|---|---|---|
| 15m | 51 | 15 | 36 | 29.4% | −$1.98 | 0.89 | +$1.06 | −$0.50 |
| 5m | 69 | 26 | 43 | 37.7% | −$12.01 | 0.69 | +$1.04 | −$0.91 |

### Exit reasons — 15m (pré-mudança)
| Razão | Count | PnL |
|---|---|---|
| SIGNAL_FLIP | **26** | **−$9.21** |
| SETTLED_WIN | 14 | +$15.44 |
| SETTLED_LOSS | 8 | −$8.00 |
| TAKE_PROFIT | 1 | +$0.50 |
| TIME_DECAY | 1 | −$0.36 |
| STOP_LOSS | 1 | −$0.35 |

### Exit reasons — 5m (pré-mudança)
| Razão | Count | PnL |
|---|---|---|
| SETTLED_LOSS | 25 | −$25.00 |
| SETTLED_WIN | 24 | +$26.33 |
| TIME_DECAY | **18** | **−$14.10** |
| TAKE_PROFIT | 2 | +$0.77 |

### PnL por faixa de preço de entrada (pré-mudança)
| Faixa | 15m PnL (trades) | 5m PnL (trades) |
|---|---|---|
| 0.30–0.39 | −$1.13 (2) | −$0.22 (3) |
| 0.40–0.44 | −$2.64 (10) | −$0.91 (8) |
| 0.45–0.49 | +$1.28 (26) | −$2.40 (28) |
| 0.50–0.54 | +$1.62 (6) | −$5.46 (21) |
| 0.55–0.59 | +$0.61 (3) | +$1.07 (3) |
| 0.60+ | −$0.50 (2) | −$1.23 (3) |

### Desempenho local acumulado (máquina WSL — até 2026-04-23)

**Parâmetros efetivos neste run** (código com defaults 0–1, mas `.env` sobrescrevia):
| Parâmetro | Valor no .env local |
|---|---|
| `TRADE_ENTRY_MIN_PRICE` | **0.40** |
| `TRADE_ENTRY_MAX_PRICE` | **0.85** |
| `disableSignalFlip` (15m) | false (default do código antigo) |
| `disableStopLoss` (5m) | true (hardcoded no config5m) |
| demais params | defaults do código antigo |

**Por que a diferença de +$18 vs o remoto (−$14)?**
O remoto rodou sem entry filter (0–1), entrando em todos os preços, inclusive faixas extremas (<0.40 e >0.85) onde o mercado já precificou muita certeza. O local filtrava para 0.40–0.85, evitando essas entradas ruins. O remote 15m acumulou 26 SIGNAL_FLIPs (−$9.21) — muitos vindos de entradas em preços extremos onde o sinal era noise.

**Hipótese para análise futura:** a faixa 0.40–0.85 parece capturar boa parte do alpha sem excesso de trades em zonas de baixa informação. Vale comparar com a nova faixa 0.45–0.58 (mais restritiva) para ver se o ganho de qualidade compensa a perda de volume.

| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 39 | 20 | 19 | 51.3% | +$4.96 |
| 5m | 188 | 92 | 96 | 48.9% | +$15.27 |

### Exit reasons — 5m (local acumulado)
| Razão | Count |
|---|---|
| SETTLED_WIN | 87 |
| SETTLED_LOSS | 50 |
| TIME_DECAY | 46 |
| TAKE_PROFIT | 5 |

---

## Snapshot: `2026-04-16_pre-disable-5m-stoploss`

**Mudança introduzida depois:** desabilitar stop-loss no 5m.

### Parâmetros — 5m (diferenças)
| Parâmetro | Valor |
|---|---|
| `disableStopLoss` | false ← principal diferença |
| `disableSignalFlip` | true |
| `signalFlipMinProb` | 0.62 |
| `flipConfirmTicks` | 5 |

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 44 | 22 | 22 | 50.0% | +$11.34 |
| 5m | 71 | 30 | 41 | 42.3% | +$4.52 |

### Exit reasons — 5m
| Razão | Count |
|---|---|
| STOP_LOSS | 26 |
| SETTLED_WIN | 26 |
| TIME_DECAY | 10 |
| SETTLED_LOSS | 5 |
| TAKE_PROFIT | 4 |

**Observação:** 26 stop-losses num total de 71 trades (37%) — muitas saídas prematuras. Análise revelou que hold-to-settlement era melhor na maioria dos casos.

---

## Snapshot: `2026-04-15_pre-outcome-api-and-ptb-guard`

**Mudança introduzida depois:** usar `outcomePrices` da API Polymarket para settlement; PTB safety guard (suprime SL/FLIP quando BTC está dentro de $30 do preço de referência).

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 16 | 4 | 12 | 25.0% | −$4.44 |
| 5m | 52 | 23 | 29 | 44.2% | +$2.28 |

---

## Snapshot: `2026-04-15_pre-late-start-guard`

**Mudança introduzida depois:** ignorar mercados onde o bot começou tarde (>30s após abertura) para evitar entrar sem dado de preço de referência.

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 2 | 2 | 0 | 100.0% | +$1.93 |
| 5m | 8 | 3 | 5 | 37.5% | −$0.44 |

*(amostra muito pequena)*

---

## Snapshot: `2026-04-15_pre-disable-5m-flip-and-sign-fixes`

**Mudança introduzida depois:** desabilitar SIGNAL_FLIP no 5m (`disableSignalFlip = true`); correções de formatação de sinal; estatísticas de trades nas notificações.

### Parâmetros relevantes — 5m (antes)
| Parâmetro | Valor |
|---|---|
| `disableSignalFlip` | false ← principal diferença |
| `signalFlipMinProb` | 0.62 |

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 44 | 13 | 31 | 29.5% | −$2.89 |
| 5m | 119 | 40 | 79 | 33.6% | +$2.68 |

**Observação:** 5m com SIGNAL_FLIP habilitado mas limiar em 0.62 ainda produzia muitas saídas ruins.

---

## Snapshot: `2026-04-14_pre-telegram-notify`

**Mudança introduzida depois:** notificações Telegram para eventos de trade.

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 19 | 12 | 7 | 63.2% | +$4.92 |
| 5m | 163 | 53 | 110 | 32.5% | +$18.82 |

**Observação:** melhor período documentado para o 15m (63% win rate). 5m com 163 trades é a maior amostra acumulada de um único período.

---

## Snapshot: `2026-04-13_pre-tightened-exits`

**Mudança introduzida depois:** apertar limiares de saída — elevar `signalFlipMinProb` 5m de 0.58→0.62, adicionar `flipConfirmTicks` 5m=5, aumentar `flipCooldownS` 5m de 60→90s.

### Parâmetros — 5m (antes do aperto)
| Parâmetro | Valor |
|---|---|
| `signalFlipMinProb` | 0.58 |
| `flipConfirmTicks` | 2 |
| `flipCooldownS` | 60s |
| `disableSignalFlip` | false |

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 94 | 32 | 62 | 34.0% | +$0.64 |
| 5m | 283 | 100 | 183 | 35.3% | +$28.73 |

### Exit reasons — 5m
| Razão | Count |
|---|---|
| SIGNAL_FLIP | 160 |
| SETTLED_WIN | 77 |
| TIME_DECAY | 18 |
| TAKE_PROFIT | 16 |
| STOP_LOSS | 6 |
| SETTLED_LOSS | 6 |

**Observação:** 160 SIGNAL_FLIPs com taxa de win 3.8% (de análise separada) — evidência clara de que o limiar de 0.58 era baixo demais para o 5m. PnL positivo apesar da estratégia ruim porque o volume era alto.

---

## Snapshot: `2026-04-09_pre-cooldown-sl-fix`

**Mudança introduzida depois:** cooldown pós-flip e guards de stop-loss (mínimo de idade de posição, prob mínima mais alta para SL).

### Parâmetros — antes do fix
| Parâmetro | Valor |
|---|---|
| `stopLossMinProb` | igual a `signalFlipMinProb` (sem guard separado) |
| `stopLossMinDurationS` | 0 (sem guard de idade) |
| `flipCooldownS` | 0 (sem cooldown) |

### Desempenho
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 93 | 34 | 59 | 36.6% | +$2.75 |
| 5m | 395 | 155 | 240 | 39.2% | +$42.54 |

**Observação:** maior volume de trades documentado (395 no 5m). PnL absoluto alto pelo volume, mas win rate baixa indica que muitos trades eram ruídos — o flip sem cooldown permitia re-entrar imediatamente após sair.

---

## Tabela consolidada — hash × parâmetros × resultados

Cada linha = uma versão de código (commit-pai do commit que introduziu a próxima mudança). Os parâmetros refletem os **defaults do código naquele commit**. O ambiente cloud nunca definiu env vars — todos os runs na nuvem usaram exatamente os defaults do código. Runs locais com `.env` são indicados explicitamente (ex: "8b local").

**Legenda:** `flip@X` = `signalFlipMinProb=X`; `CT=N` = `flipConfirmTicks=N`; `CD=Ns` = `flipCooldownS=N`; ⚠ = amostra insuficiente (< 20 trades).

### Parâmetros 15m por versão

| # | Hash | Data | flip | disableFlip | disableSL | SL guards | entry filter | highConvMult | TD | blockedHours | blockedRegimes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `a8e2101` | 07-abr | 0.58 | false | false | 0.58 / 0s | — | — | 1.5m / 5% | — | — |
| 2 | `45170e2` | 13-abr | 0.58 | false | false | 0.65 / 120s | — | — | 1.5m / 5% | — | — |
| 3 | `fe27514` | 14-abr | 0.58 | false | false | 0.65 / 120s | — | — | 1.5m / 5% | — | — |
| 4 | `2c0cbc7` | 15-abr | 0.58 | false | false | 0.65 / 120s | — | — | 1.5m / 5% | — | — |
| 5 | `fa9fc9b` | 15-abr | 0.58 | false | false | 0.65 / 120s | — | — | 1.5m / 5% | — | — |
| 6 | `577d5f4` | 15-abr | 0.58 | false | false | 0.65 / 120s | — | — | 1.5m / 5% | — | — |
| 7 | `83a4a7b` | 15-abr | 0.58 | false | false | 0.65 / 120s | — (+PTB $30) | — | 1.5m / 5% | — | — |
| 8a | `f821b16` (remoto) | 16-abr | 0.58 | false | false | 0.65 / 120s | 0–1 (off) | — | 1.5m / 5% | — | — |
| 8b | `f821b16` + `.env` local | 17-abr | 0.58 | false | false | 0.65 / 120s | **0.40–0.85** | — | 1.5m / 5% | — | — |
| 9 | `d36b3f4` | 24-abr | 0.58 | **true** | false | 0.65 / 120s | **0.45–0.58** | **2×** @ 0.45–0.50 / prob≥0.70 | 1.5m / 5% | — | — |
| **10** | `b03ec16` | 27-abr | 0.58 | true | false | 0.65 / 120s | 0.45–0.58 | 2× | 1.5m / 5% | **[0,1,2,5,6,15,16]** | **[CHOP,RANGE]** |

### Parâmetros 5m por versão

| # | Hash | Data | flip | CT | CD | disableFlip | disableSL | entry filter | TD | blockedHours | ofiFilter |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `a8e2101` | 07-abr | 0.58 | 1 | 0s | false | false | — | 1.5m / 5% | — | HA+OFI |
| 2 | `45170e2` | 13-abr | 0.58 | 3 | 90s | false | false | — | 1.5m / 5% | — | HA+OFI |
| 3 | `fe27514` | 14-abr | **0.62** | **5** | 90s | false | false | — | 1.5m / 5% | — | HA+OFI |
| 4 | `2c0cbc7` | 15-abr | 0.62 | 5 | 90s | false | false | — | 1.5m / 5% | — | HA+OFI |
| 5 | `fa9fc9b` | 15-abr | 0.62 | 5 | 90s | **true** | false | — | 1.5m / 5% | — | HA+OFI |
| 6 | `577d5f4` | 15-abr | 0.62 | 5 | 90s | true | false | — | 1.5m / 5% | — | HA+OFI |
| 7 | `83a4a7b` | 15-abr | 0.62 | 5 | 90s | true | false | — (+PTB $30) | 1.5m / 5% | — | HA+OFI |
| 8a | `f821b16` (remoto) | 16-abr | 0.62 | 5 | 90s | true | **true** | 0–1 (off) | 1.5m / 5% | — | HA+OFI |
| 8b | `f821b16` + `.env` local | 17-abr | 0.62 | 5 | 90s | true | true | **0.40–0.85** | 1.5m / 5% | — | HA+OFI |
| 9 | `d36b3f4` | 24-abr | 0.62 | 5 | 90s | true | true | **0.50–0.60** | **2.5m / 15%** | — | HA+OFI |
| **10** | `b03ec16` | 27-abr | 0.62 | 5 | 90s | true | true | **0.50–0.52** | 2.5m / 15% | **[6,10,16,21,22,23]** | **OFI only** |

### Resultados (paper-trading acumulado)

| # | Hash | Principal delta vs anterior | 15m (t / WR / PnL) | 5m (t / WR / PnL) |
|---|---|---|---|---|
| 1 | `a8e2101` | **Baseline** — sem cooldown, SL sem guards | 93 / 36.6% / **+$2.75** | 395 / 39.2% / **+$42.54** |
| 2 | `45170e2` | +SL guards (prob 0.65, duração 120s); +cooldown 60s/90s | 94 / 34.0% / +$0.64 | 283 / 35.3% / **+$28.73** |
| 3 | `fe27514` | Flip 5m endurecido: 0.58→0.62, CT 3→5 | 19 / 63.2% / +$4.92 ⚠ | 163 / 32.5% / **+$18.82** |
| 4 | `2c0cbc7` | Sem mudança de estratégia (só Telegram) | 44 / 29.5% / −$2.89 | 119 / 33.6% / +$2.68 |
| 5 | `fa9fc9b` | **disableSignalFlip=true** (5m) | 2 / 100% / +$1.93 ⚠ | 8 / 37.5% / −$0.44 ⚠ |
| 6 | `577d5f4` | +late-start guard | 16 / 25.0% / −$4.44 ⚠ | 52 / 44.2% / +$2.28 |
| 7 | `83a4a7b` | +outcome API settlement, +PTB safe margin $30 | 44 / 50.0% / **+$11.34** | 71 / 42.3% / +$4.52 |
| 8a | `f821b16` (remoto) | **disableStopLoss=true** (5m); sem entry filter | 51 / 29.4% / −$1.98 | 69 / 37.7% / −$12.01 |
| 8b | `f821b16` + `.env` local | idem + `.env` override: entry 0.40–0.85 | 39 / 51.3% / **+$4.96** | 188 / 48.9% / **+$15.27** |
| 9 | `d36b3f4` | entry filter 15m 0.45–0.58 / 5m 0.50–0.60; disableSignalFlip=true (15m); highConvMult=2× (15m); TD 5m 2.5m/15% | 110 / 44.5% / +$4.68 ☁ | 394 / 29.9% / −$1.58 ☁ |
| 10 | `b03ec16` ☁ | +blockedHours 15m+5m; entry max 5m 0.60→0.52; +blockedRegimes CHOP/RANGE (15m); OFI-only filter (5m) | 209 / 45.9% / −$3.09 | 613 / 28.7% / −$4.76 |
| **11** | *(pending)* | disableTimeDecay 5m; entryMin 15m 0.45→0.50; btcVsPtb filter $5 (15m); SL dur 120→240s; blocked hours 15m+5m revisados | **em curso** | **em curso** |

### Observações para fine-tuning

- **Maior 5m PnL absoluto** (v1, +$42.54) veio com params **mais frouxos** (flip@0.58, sem cooldown, sem guards) e **maior volume** (395 trades). Endurecer exits reduziu PnL proporcionalmente mais que o ruído que cortaram.
- **15m: melhor PnL documentado** foi v7 (+$11.34, 50% WR) — com flip 15m **ainda ON** e PTB guard recém-adicionado. O v9 está desabilitando flip 15m baseado em análise de v8 (51 trades remotos), mas v7 mostra que flip 15m pode funcionar com PTB guard ativo. Candidato a re-testar.
- **Entry filter 0.40–0.85 (v8b local)** gerou os melhores resultados recentes em ambos os bots. A nova faixa v9 (15m 0.45–0.58 / 5m 0.50–0.60) é bem mais restritiva — vale comparar se o ganho de qualidade supera a perda de volume.
- **Amostra mínima:** v3 (19 trades 15m), v5 (2 + 8), v6 (16 trades 15m) são ⚠ amostras insuficientes — conclusões a partir delas são ruído.
- **Rodar ≥ 24h e ≥ 20 trades por bot** antes de comparar novos params com estas linhas.

---

## Resumo comparativo (versão curta)

| # | Hash | 15m Trades | 15m Win% | 15m PnL | 5m Trades | 5m Win% | 5m PnL |
|---|---|---|---|---|---|---|---|
| 1 | `a8e2101` | 93 | 36.6% | +$2.75 | 395 | 39.2% | +$42.54 |
| 2 | `45170e2` | 94 | 34.0% | +$0.64 | 283 | 35.3% | +$28.73 |
| 3 | `fe27514` | 19 | 63.2% | +$4.92 | 163 | 32.5% | +$18.82 |
| 4 | `2c0cbc7` | 44 | 29.5% | −$2.89 | 119 | 33.6% | +$2.68 |
| 5 | `fa9fc9b` | 2 | 100% | +$1.93 | 8 | 37.5% | −$0.44 |
| 6 | `577d5f4` | 16 | 25.0% | −$4.44 | 52 | 44.2% | +$2.28 |
| 7 | `83a4a7b` | 44 | 50.0% | +$11.34 | 71 | 42.3% | +$4.52 |
| 8a | `f821b16` (remoto) | 51 | 29.4% | −$1.98 | 69 | 37.7% | −$12.01 |
| 8b | `f821b16` + `.env` local | 39 | 51.3% | +$4.96 | 188 | 48.9% | +$15.27 |
| 9 | `d36b3f4` ☁ | 110 | 44.5% | +$4.68 | 394 | 29.9% | −$1.58 |
| 10 | `b03ec16` ☁ | 209 | 45.9% | −$3.09 | 613 | 28.7% | −$4.76 |
| **11** | *(pending)* | — | — | — | — | — | — |

☁ = run em cloud (não local WSL)

### Principais decisões estratégicas e aprendizados

| Data | Decisão | Evidência |
|---|---|---|
| ~2026-04-09 | Adicionar cooldown pós-flip + guards de SL (prob mínima + idade mínima) | Re-entradas imediatas geravam ruído e trades de baixa qualidade |
| ~2026-04-13 | Elevar `signalFlipMinProb` 5m: 0.58→0.62; `flipConfirmTicks` 5m: 2→5 | 158 SIGNAL_FLIPs com 3.8% win rate — limiar muito baixo capturava blips transitórios |
| ~2026-04-15 | Desabilitar SIGNAL_FLIP no 5m por completo | Mesmo com 0.62, a taxa de exit prematuro ainda era alta demais |
| ~2026-04-16 | Desabilitar STOP_LOSS no 5m | 161 SL trades: 78% corretos mas 22% cortou winners; hold-to-settlement domina com 85% win rate settled |
| 2026-04-27 | Filtro de horário UTC — 15m: bloquear 00–02h, 05–06h, 15–16h | 28 trades nesses horários geraram −$21.64; restantes +$26.33. Horas ruins provavelmente refletem baixa liquidez (madrugada UTC) e abertura NY com volatilidade caótica |
| 2026-04-27 | Filtro de horário UTC — 5m: bloquear 06h, 10h, 16h, 21–23h | 130 trades ruins geraram −$20.36. 16h (abertura NY) e 21–23h (fim de tarde NY) são consistentemente negativos |
| 2026-04-27 | Rebaixar teto de entrada 5m de 0.60 → 0.52 | 219 trades com entry ≥ 0.52 geraram −$11.44 (−$0.052/trade); 175 trades < 0.52 geraram +$9.86 (+$0.056/trade). Preços mais altos refletem menor incerteza do mercado — menos edge disponível |
| 2026-04-27 | Bloquear entradas em regime CHOP e RANGE no 15m | Segunda metade da run v9 (trades 56–110) teve TIME_DECAY 6→12 e STOP_LOSS 5→11. CHOP/RANGE têm sinal direcional fraco — modelo oscila mais e saídas prematuras aumentam |
| 2026-04-27 | OFI-only filter no 5m: remover exigência de HA concordar com OFI | OFI é o sinal primário do modelo 5m. Exigir que AMBOS HA+OFI discordassem era permissivo demais. OFI sozinho com `|ofi_1m| > 0.05` é condição suficiente para bloquear |
| 2026-04-29 | Desabilitar TIME_DECAY no 5m (`disableTimeDecay = true`) | 433 exits TIME_DECAY = −$159.63; 97.6% settled win rate mostra que manter até o settlement domina. Mesmo padrão do stop-loss (v8) e signal-flip (v5) que também foram desabilitados |
| 2026-04-29 | Subir `entryMinMarketPrice` 15m: 0.45 → 0.50 | Win rate em settlement [0.45–0.50) = 43–48% (abaixo de 50%). [0.50–0.52) = 94.7%, [0.55–0.60) = 100%. Entradas baratas significam alta discordância modelo↔mercado, e o mercado costuma estar certo |
| 2026-04-29 | Filtro `btcVsPtbMinAbsUsd = 5` no 15m | 68% das entradas caíam em |btc_vs_ptb| < $5 com win rate 41.5% e PnL −$14.08. Entradas com clareza direcional (BTC longe do PTB) têm win rate 60–75% |
| 2026-04-29 | Aumentar `stopLossMinDurationS` 15m: 120 → 240s | 18/34 SLs dispararam em 120–180s (na borda); análise hipotética indica que manteriam gerariam melhor resultado na maioria |
| 2026-04-29 | Revisão de blocked hours 15m e 5m baseada em dados reais v10 | A lista v10 bloqueava horas positivas (H15, H16 com +$7.74 combinado) e deixava passar horas negativas. Atualização baseada no real performance hora-a-hora dos 67h de run |
