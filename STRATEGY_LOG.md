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

## Versão atual — v10

**Ref:** `logs/archive/2026-04-26` (cloud run — baseline desta versão)  
**Hash:** `b03ec16` (HEAD)  
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
| **10** | `b03ec16` | +blockedHours 15m+5m; entry max 5m 0.60→0.52; +blockedRegimes CHOP/RANGE (15m); OFI-only filter (5m) | **em curso** | **em curso** |

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
| **10** | `b03ec16` | — | — | — | — | — | — |

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
