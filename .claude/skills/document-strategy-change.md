---
name: document-strategy-change
description: Run after any change to strategy logic, engine parameters, config defaults, or trading rules. Dumps live defaults, appends a new version entry to STRATEGY_LOG.md, and updates CLAUDE.md if new env vars or logic changed.
---

# Document Strategy Change

Run this skill whenever you edit any of these files:
- `src/config.js` or `src/config5m.js`
- `src/engines/edge.js` or `src/engines/edge5m.js`
- `src/engines/probability.js` or `src/engines/probability5m.js`
- `src/engines/regime.js`
- `src/dryRun.js`
- `src/trading/executor.js`
- `src/trading/position.js`

## Steps

### 1. Dump live config defaults

Run both config files through Node to get the actual default values in effect:

```bash
node --input-type=module -e "
import cfg from './src/config.js';
console.log(JSON.stringify(cfg.trading, null, 2));
"
```

```bash
node --input-type=module -e "
import cfg from './src/config5m.js';
console.log(JSON.stringify(cfg.trading, null, 2));
"
```

Capture the output — these are the canonical values to document. Note: the cloud deployment runs **code defaults only** (no env var overrides), so what Node prints IS what runs in production.

### 2. Identify the new version number

Read the current `STRATEGY_LOG.md` and find the highest `## vN` heading. The new entry is `## v(N+1)`.

### 3. Write the STRATEGY_LOG.md entry

Append a new section at the top of the log (after the header) following this exact template:

```markdown
## v{N+1} — {YYYY-MM-DD}

### Changes
- {Bullet per logical change. Include: what changed, old value → new value, and rationale}

### Parameters — 15m bot (code defaults, no env overrides)
| Parameter | Value |
|---|---|
| tradeAmount | ... |
| entryMinMarketPrice | ... |
| entryMaxMarketPrice | ... |
| takeProfitPct | ... |
| stopLossPct | ... |
| signalFlipMinProb | ... |
| stopLossMinProb | ... |
| stopLossMinDurationS | ... |
| flipCooldownS | ... |
| blockedHoursUtc | ... |
| blockedRegimes | ... |

### Parameters — 5m bot (code defaults, no env overrides)
| Parameter | Value |
|---|---|
| tradeAmount | ... |
| entryMinMarketPrice | ... |
| entryMaxMarketPrice | ... |
| takeProfitPct | ... |
| stopLossPct | ... |
| disableStopLoss | ... |
| signalFlipMinProb | ... |
| disableSignalFlip | ... |
| flipCooldownS | ... |
| blockedHoursUtc | ... |

### Baseline results (before this change)
> Copy from the most recent dry-run analysis or the previous version's results section.
> If no fresh data is available, write: "No new data — see previous version."

### Estimated impact
- {What improvement or behavior change is expected and why}

---
```

Fill every `...` using the Node output from step 1. Do NOT leave any field blank or say "same as before" — always write the actual value.

### 4. Update CLAUDE.md if needed

- If you added a new env variable: add a row to the "Key environment variables" table.
- If you changed engine logic (new filter, new condition, disabled a feature): update the relevant engine description in the "Engines" section.
- If you changed executor/dryRun behavior: update those sections.

Do not rewrite CLAUDE.md wholesale — make targeted edits only.

### 5. Confirm

After writing, tell the user:
- Which version was added to STRATEGY_LOG.md
- Which CLAUDE.md sections were updated (if any)
- The key parameter values that changed

## Notes

- The log is append-only; never edit past versions.
- If the change is purely cosmetic (UI, display, logging format) and affects no strategy logic or parameters, skip this skill.
- If multiple related changes were made in one session, document them as a single version entry covering all changes.
