# Strategy Log — Polymarket BTC Assistant

Cada entrada documenta o estado da estratégia em um snapshot de logs, com parâmetros-chave e desempenho do paper-trading acumulado até aquele ponto. Os snapshots são os arquivos em `logs/archive/`.

**Nota sobre os dados:** os snapshots de curto prazo (< 20 trades) têm alta variância estatística e não são representativos.

---

## Versão atual

**Ref:** `logs/` (live)  
**Data:** 2026-04-16 (em andamento)

### Mudança vs anterior
- 5m: stop-loss desabilitado (`disableStopLoss = true`). Análise de 161 trades SL mostrou 78% de saídas corretas, mas o 22% que cortou winners custou muito mais (SL real: −$75.65 vs hold-to-settlement: −$25.64). Taxa de win settled 5m é ~85%, logo hold até settlement é dominante.

### Parâmetros — 15m
| Parâmetro | Valor |
|---|---|
| `takeProfitPct` | 20% |
| `stopLossPct` | 25% |
| `signalFlipMinProb` | 0.58 |
| `stopLossMinProb` | 0.65 |
| `stopLossMinDurationS` | 120s |
| `flipCooldownS` | 60s |
| `flipConfirmTicks` | 2 |
| `disableStopLoss` | false |
| `disableSignalFlip` | false |

### Parâmetros — 5m
| Parâmetro | Valor |
|---|---|
| `takeProfitPct` | 20% |
| `stopLossPct` | 25% |
| `signalFlipMinProb` | 0.62 |
| `stopLossMinProb` | 0.65 |
| `stopLossMinDurationS` | 120s |
| `flipCooldownS` | 90s |
| `flipConfirmTicks` | 5 |
| `disableStopLoss` | **true** |
| `disableSignalFlip` | **true** |

### Desempenho (paper-trading acumulado)
| Bot | Trades | Win | Loss | Win Rate | PnL |
|---|---|---|---|---|---|
| 15m | 34 | 17 | 17 | 50.0% | +$4.73 |
| 5m | 105 | 49 | 56 | 46.7% | +$3.33 |

### Exit reasons — 5m
| Razão | Count |
|---|---|
| SETTLED_WIN | 49 |
| TIME_DECAY | 28 |
| SETTLED_LOSS | 28 |

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
