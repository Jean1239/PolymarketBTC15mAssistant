# Papéis de stack, layout de log e container de captura — Design

**Data:** 2026-05-22
**Status:** Aprovado (design) — pronto para plano de implementação
**Relacionado:** [Backtest harness](2026-05-22-backtest-harness-design.md) (consome `capture/` e `meta/`)

## Problema

Três defeitos da configuração atual, todos pelo mesmo motivo conceitual: o bot é um *simulador-com-modo-real-opcional*, e os dados de todos os papéis caem flat no mesmo `logs/`.

1. **Captura duplicada.** Após a Fase 0 do harness, staging-sim e prod-real capturam o mesmo `orderbook_5m.jsonl` em dois volumes. Orderbook é independente de ambiente — uma cópia basta.
2. **Dado pré/pós trade real misturado em prod.** Volume de prod acumula CSVs da era paper e da era real lado a lado, sem separação fácil.
3. **Sem fallback silencioso pra paper.** Hoje, `POLYMARKET_LIVE_TRADING=false` num bot de prod degrada ele pra paper-trading — redundante com staging. Não se quer essa degradação: prod é real ou nada.

Bônus descoberto durante a discussão: **`real_*_trades.csv` não tem `config_hash` hoje**. A página `/strategies` do dashboard funciona pra sim mas **não pra real** — trades reais não podem ser agrupados por estratégia. O fix dobra neste spec.

## Escopo

Quatro entregas coesas, mesmo tema "separar papéis de stack de forma limpa":

1. **Modo de execução explícito** — `EXECUTION_MODE ∈ {paper, real}`, sem fallback.
2. **Layout de log por papel** — subdirs `capture/`, `sim/`, `real/`, `meta/`.
3. **Container de captura dedicado** — produtor único de orderbook (5m + 15m), volume isolado.
4. **`config_hash` no journal real** — habilita agrupamento de trade real por estratégia.

## Abordagem

**Módulo central `src/paths.js`** como fonte única de verdade para os ~20 paths de log espalhados hoje em `src/`, `scripts/`, `logServer.js`, `entrypoint.sh`. Próxima mudança de layout = um arquivo só.

Alternativas descartadas:
- Editar os literais no lugar — diff menor agora, mas o conhecimento de path continua espalhado; próxima mudança re-toca 20 lugares.
- Dirs por env var (`SIM_LOG_DIR`/`REAL_LOG_DIR`/`CAPTURE_LOG_DIR`) — layout é fixo, override por-deploy é over-engineering.

## Arquitetura — três papéis de stack

```
            ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
            │   capture    │    │    paper     │    │     real     │
            │  (staging,   │    │  (staging    │    │ (prod stack) │
            │  --profile)  │    │   bots)      │    │              │
            └──────────────┘    └──────────────┘    └──────────────┘
                   │                   │                   │
            polymarket_capture  polymarket_logs    polymarket_logs
              (vol isolado)      (vol staging)      (vol prod)
                   │                   │                   │
                capture/             sim/                 real/
                                     meta/                meta/
                                     archive/             archive/
```

- **`capture`** → produz só `capture/`. Único produtor de orderbook. Roda em staging via profile dedicado.
- **`paper`** → motor de decisão + journal paper. Produz `sim/` + `meta/`. Zero ordem real.
- **`real`** → motor de decisão + executor real + journal real. Produz `real/` + `meta/`. **Sem journal paper** (staging cobre isso).

Cada volume tem um único papel — ambiguidade zero ao puxar dado.

## `EXECUTION_MODE`

Novo env var ortogonal ao `BOT_MODE` existente. **Default `paper`** — stack sem config nunca opera dinheiro real por acidente.

- `paper`: inicializa o motor de decisão (`createDryRunSimulator*`) com journaling ligado. **Não** inicia `initTradingClient`/executor.
- `real`: exige `POLYMARKET_PRIVATE_KEY` válido. Se faltar/inválido → `console.error` + `process.exit(1)` no startup. Sem fallback. Inicia trading client + executor. Motor de decisão roda; journaling **paper desligado**, mas o tick log roda apontando pra `real/ticks_*.csv`.

`POLYMARKET_LIVE_TRADING` é **removido** (era o gate antigo). `EXECUTION_MODE=real` passa a ser o gate único de dinheiro real.

**O que cada modo escreve:**

| Artefato | `paper` | `real` |
|---|---|---|
| Motor de decisão (cérebro do sim) | roda | roda |
| `sim/signals_*.csv` | sim | não |
| `sim/dryrun_*.csv` (tick log) | sim | não |
| `sim/dryrun_*_trades.csv` (journal paper) | sim | não |
| `real/ticks_*.csv` (tick log do bot real) | não | sim |
| `real/real_*_trades.csv` (journal real) | não | sim |
| `real/trade_orders.log` · `trade_errors.log` | não | sim |
| `meta/strategy_versions_*.json` | sim | sim |
| Ordens reais na CLOB | não | sim |

O motor de decisão rodando nos dois modos é essencial — `executor.js` só manda ordem real quando o sim decidiu BUY/SELL no mesmo tick. Em `real` o sim continua sendo o cérebro; o que muda é o destino do tick CSV (`real/ticks_*.csv` em vez de `sim/dryrun_*.csv`) e a supressão do journal paper.

## Layout de log

```
logs/
  capture/   orderbook_5m.jsonl, orderbook_15m.jsonl,
             orderbook_*_<data>.jsonl.gz, pipeline_trace.jsonl
  sim/       signals.csv, signals_5m.csv,
             dryrun_15m.csv, dryrun_5m.csv,
             dryrun_15m_trades.csv, dryrun_5m_trades.csv
  real/      ticks_15m.csv, ticks_5m.csv,
             real_15m_trades.csv, real_5m_trades.csv,
             trade_orders.log, trade_errors.log
  meta/      strategy_versions_5m.json, strategy_versions_15m.json
  archive/   (inalterado — rotação do entrypoint + /api/logs/clear)
  auth.db    (raiz — não pertence a papel; é estado do dashboard)
```

**Decisões-chave:**
- **`strategy_versions_*.json` em `meta/`, não `sim/`.** O registry mapeia `config_hash → label/config` e decodifica hashes usados por trades sim **E** reais. Separar por modo destruiria a comparação staging-paper vs prod-real da mesma estratégia (mesmo `config_hash` → datasets cruzáveis). Registry é metadado compartilhado, papel próprio.
- **`real/ticks_*.csv`.** O dashboard `/api/live` precisa de um tick log no modo real (view ao vivo da posição). Mesma escrita do simulador, destino `real/` em vez de `sim/`. Nome `ticks_*.csv` em vez de `dryrun_*.csv` deixa o papel óbvio.
- **`auth.db` na raiz.** Estado do dashboard, não pertence a papel. Sem mudança.

## `src/paths.js`

Fonte única. Exporta:
- `LOG_ROOT` (default `./logs`, override via env `LOG_ROOT` se útil em testes).
- Subdirs: `CAPTURE_DIR`, `SIM_DIR`, `REAL_DIR`, `META_DIR`, `ARCHIVE_DIR`.
- Paths nomeados de cada arquivo (ver layout acima): `signals15m`, `signals5m`, `dryrun5m`, `dryrun5mTrades`, `strategyVersions5m`, `real5mTrades`, `tradeOrdersLog`, `tradeErrorsLog`, `orderbook5m`, `orderbook15m`, `pipelineTrace`, `ticks5m`, `ticks15m`, ...
- `mkdir -p` recursivo dos 5 subdirs no load do módulo.

Todo consumidor importa de `paths.js`. Hoje há ~20 literais `"./logs/..."` em: `src/index.js`, `src/index5m.js`, `src/dryRun.js`, `src/trading/{client,executor,orders,realTradeLog,redeem}.js`, `src/logServer.js`, `scripts/{auditRealFees,backfillFees}.js`. Todos passam a importar.

## `config_hash` no journal real

`src/trading/realTradeLog.js`:
- `TRADE_JOURNAL_HEADER` ganha `"config_hash"` ao fim.
- `createRealTradeLogger(csvPath, { configHash } = {})` recebe o hash. `recordExit(...)` o emite na linha.
- `index5m.js` (e `index.js`) já têm `strategyVersion.hash` em escopo — repassam: `createRealTradeLogger(paths.real5mTrades, { configHash: strategyVersion.hash })`.

Volumes existentes que já têm `real_*_trades.csv` sem essa coluna: as linhas antigas ficam com `config_hash` em branco. A migração no entrypoint (abaixo) detecta header sem `config_hash`, recria o arquivo com header novo e mantém as linhas históricas (campo `config_hash` vazio nelas).

## Container de captura

**`src/indexCapture.js`** — poll loop mínimo:
- Dois `createMarketResolver` (config 5m, config 15m).
- A cada tick: `fetchPolymarketSnapshot` 5m e 15m em paralelo; pra cada `poly.ok && poly.rawBook` válido, chama `orderbookCapture.record({ slug, timeLeftMin, rawBook })` no logger correspondente.
- Sem Binance, sem Chainlink, sem trading, sem `dryRun`, sem display.
- Reusa `src/backtest/orderbookCapture.js` (PR #7) inalterado.
- `process.on("SIGINT"/"SIGTERM")` graceful exit.

**Removida** a wiring de captura em `src/index5m.js` (linhas ~152-161 da Fase 0 Task 7) — captura passa a viver só no container dedicado.

**`entrypoint.sh`** ganha case `BOT_MODE=capture` → `node src/indexCapture.js`. Sem rotação de tick-CSV neste modo (a captura faz gzip diário por conta própria).

## Migração

`scripts/migrateLogLayout.js` — chamado pelo `entrypoint.sh` no start, antes do bot subir.

Mapa flat→subdir hardcoded (toda permutação de arquivo conhecido). Para cada entrada:
- Se `logs/<flat>` existe e `logs/<role>/<flat>` não existe → `rename` (move atômico).
- Se ambos existem → loga warning, deixa como está (não sobrescreve).
- Se nenhum existe → no-op.

**Idempotente.** Próximos starts não fazem nada.

Casos extras:
- `real_*_trades.csv` sem `config_hash` no header → backup pra `real_*_trades.csv.legacy`, recria com header novo + re-anexa linhas antigas com campo vazio. Idempotente (só roda se header for o velho).
- `auth.db` não move (já está na raiz, que é o destino).
- `archive/` não move.

## Dashboard (`logServer.js`)

- Import dos paths via `paths.js` — substitui os literais hoje em `LOGS_DIR`, `TRADE_FILES`, `dryrun_15m.csv` e `dryrun_5m.csv` hardcoded no `/api/live`, e a lista de arquivos de `/api/logs/clear`.
- `/api/files` lista nos subdirs (recursivo, mantém `name` relativo a `logs/` pra UI compatível).
- `/api/live`: paper-source dashboard lê `sim/dryrun_*.csv`; real-source dashboard lê `real/ticks_*.csv`. `DASHBOARD_TRADE_SOURCE` já existe e governa a escolha de journal — extende pra governar o tick log também.
- `/api/logs/clear`: arquiva os arquivos dos novos paths, não os antigos flat.
- `/api/strategies/{15m,5m}` lê de `meta/strategy_versions_*.json`.

## `docker-compose.yml`

- `EXECUTION_MODE: ${EXECUTION_MODE:-paper}` nas declarações `environment:` dos serviços `bot-15m` e `bot-5m`. Cada ambiente (staging/.env vs prod/.env) seta o valor; staging omite (cai no default `paper`), prod seta `real`.
- Serviço novo `capture`:
  ```yaml
  capture:
    build: .
    container_name: polymarket-capture
    restart: unless-stopped
    profiles: ["capture"]
    env_file: [{ path: .env, required: false }]
    environment:
      BOT_MODE: capture
    mem_limit: 256m
    volumes:
      - polymarket_capture:/app/logs
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
  ```
- Volume novo `polymarket_capture` declarado no bloco `volumes:`.
- Profile `capture` garante que `docker compose up` (sem profile) **não** sobe o container — staging sobe com `docker compose --profile capture up`, prod sem.
- `POLYMARKET_LIVE_TRADING` removido das documentações/comentários.

## Verificação

- **`smoke:paths`** (`scripts/smokeTestPaths.js`) — assert cada path nomeado resolve no subdir certo; `mkdir` é idempotente.
- **`smoke:migration`** (`scripts/smokeTestMigration.js`) — em temp dir: cria flat-files, roda migração, assert movidos; roda de novo, assert no-op; com header legado em `real_*_trades.csv`, assert reescrita preserva linhas.
- **`smoke:capture-bot`** (`scripts/smokeTestCaptureBot.js`) — sobe `indexCapture.js` em subprocesso ~60s contra mercados live, assert `capture/orderbook_*.jsonl` recebe linhas. Pulado se `SKIP_NET=1` (CI offline).
- **EXECUTION_MODE manual:** `EXECUTION_MODE=real` sem `POLYMARKET_PRIVATE_KEY` → exit 1; `paper` → sem trading client inicializado.
- **Sem regressão:** `smoke:strategy`, `smoke:pipeline`, `smoke:orderbook`, `smoke:bundle` seguem passando após o refactor dos paths.
- **`backtest:verify`** estendido para incluir `smoke:paths` + `smoke:migration`.

## Não-objetivos (YAGNI)

- Sem `EXECUTION_MODE=shadow` (real + paper journal simultâneo pra análise de drift). Útil mas a comparação cruzada via `config_hash` cobre o caso.
- Sem migração reversa (subdir→flat). Sentido único.
- Sem dashboard separado pra dado de captura — captura é input do harness offline, não da UI.
- Sem mudança no harness de backtest (Fases 2/3 lerão de `capture/` + `meta/` quando vierem — não muda nada aqui).

## Critérios de sucesso

1. Stack staging roda `EXECUTION_MODE=paper` + profile `capture` → produz `sim/` + `meta/` + (no volume `polymarket_capture`) `capture/`. Nada em `real/`.
2. Stack prod roda `EXECUTION_MODE=real` sem profile `capture` → produz `real/` + `meta/`. Nada em `sim/`. Sem `POLYMARKET_PRIVATE_KEY` válido → exit 1.
3. Volume de prod existente, após primeiro start com código novo → arquivos flat foram movidos pros subdirs; `real_*_trades.csv` ganhou coluna `config_hash`; dashboard segue funcional.
4. Volume de captura acumula `orderbook_5m.jsonl` e `orderbook_15m.jsonl` continuamente; `index5m.js` não escreve mais orderbook (captura saiu de lá).
5. Dashboard `/strategies` página agrupa trades **reais** por estratégia (config_hash em cada linha + registry em `meta/`).
6. `npm run backtest:verify` passa: paths + migration + golden pipeline + orderbook helpers.
