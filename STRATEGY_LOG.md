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

## Versão atual

**Ref:** `logs/` (live)  
**Data:** 2026-04-17

### Mudanças vs anterior
Introduzidas após análise dos 51 trades 15m / 69 trades 5m registrados em 2026-04-17 (baseline arquivado em `logs/archive/2026-04-17_pre-entry-filter-and-15m-flip-disable/`):
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
| `disableSignalFlip` | **true** ✱ | `TRADE_DISABLE_SIGNAL_FLIP` |
| `entryMinMarketPrice` | **0.45** ✱ | `TRADE_ENTRY_MIN_PRICE` |
| `entryMaxMarketPrice` | **0.58** ✱ | `TRADE_ENTRY_MAX_PRICE` |
| `timeDecayMinLeftMin` | 1.5 min | `TRADE_TIME_DECAY_MIN_LEFT_MIN` |
| `timeDecayMinLossPct` | 5% | `TRADE_TIME_DECAY_MIN_LOSS_PCT` |
| `highConvictionMultiplier` | **2×** ✱ | `TRADE_HIGH_CONVICTION_MULT` |
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
| `disableStopLoss` | **true** | `TRADE_DISABLE_STOP_LOSS_5M` |
| `disableSignalFlip` | **true** | `TRADE_DISABLE_SIGNAL_FLIP_5M` |
| `entryMinMarketPrice` | **0.50** ✱ | `TRADE_ENTRY_MIN_PRICE_5M` |
| `entryMaxMarketPrice` | **0.60** ✱ | `TRADE_ENTRY_MAX_PRICE_5M` |
| `timeDecayMinLeftMin` | **2.5 min** ✱ | `TRADE_TIME_DECAY_MIN_LEFT_MIN_5M` |
| `timeDecayMinLossPct` | **15%** ✱ | `TRADE_TIME_DECAY_MIN_LOSS_PCT_5M` |
| `highConvictionMultiplier` | 1 (off) | `TRADE_HIGH_CONVICTION_MULT_5M` |

✱ = mudanças desta versão. Valores são defaults no código; `.env` sobrescreve se definido.

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

## Resumo comparativo

| Snapshot | 15m Trades | 15m Win% | 15m PnL | 5m Trades | 5m Win% | 5m PnL |
|---|---|---|---|---|---|---|
| `pre-cooldown-sl-fix` | 93 | 36.6% | +$2.75 | 395 | 39.2% | +$42.54 |
| `pre-tightened-exits` | 94 | 34.0% | +$0.64 | 283 | 35.3% | +$28.73 |
| `pre-telegram-notify` | 19 | 63.2% | +$4.92 | 163 | 32.5% | +$18.82 |
| `pre-disable-5m-flip` | 44 | 29.5% | −$2.89 | 119 | 33.6% | +$2.68 |
| `pre-outcome-api-ptb` | 16 | 25.0% | −$4.44 | 52 | 44.2% | +$2.28 |
| `pre-disable-5m-stoploss` | 44 | 50.0% | +$11.34 | 71 | 42.3% | +$4.52 |
| **atual** | 34 | 50.0% | +$4.73 | 105 | 46.7% | +$3.33 |

### Principais decisões estratégicas e aprendizados

| Data | Decisão | Evidência |
|---|---|---|
| ~2026-04-09 | Adicionar cooldown pós-flip + guards de SL (prob mínima + idade mínima) | Re-entradas imediatas geravam ruído e trades de baixa qualidade |
| ~2026-04-13 | Elevar `signalFlipMinProb` 5m: 0.58→0.62; `flipConfirmTicks` 5m: 2→5 | 158 SIGNAL_FLIPs com 3.8% win rate — limiar muito baixo capturava blips transitórios |
| ~2026-04-15 | Desabilitar SIGNAL_FLIP no 5m por completo | Mesmo com 0.62, a taxa de exit prematuro ainda era alta demais |
| ~2026-04-16 | Desabilitar STOP_LOSS no 5m | 161 SL trades: 78% corretos mas 22% cortou winners; hold-to-settlement domina com 85% win rate settled |
