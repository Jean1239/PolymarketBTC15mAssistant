# Ideas & TODOs

## Trading API Layer (shared across bots)

Expor o trading layer atual como um servidor HTTP local (Express) com endpoints REST:

```
POST /order/buy   { tokenId, amount, price }
POST /order/sell  { tokenId, amount, price }
GET  /balance
GET  /position/:tokenId
```

**Motivação:** permite criar novos bots em Python (ou qualquer linguagem) sem reimplementar
autenticação EIP-712, L2 HMAC, GnosisSafe detection, order slippage logic — que já estão
testados e funcionando em `src/trading/`.

**Caso de uso imediato:** weather bot em Python que consome modelos de previsão do tempo
(Open-Meteo ensemble: GFS, ECMWF, ICON), calcula edge vs preços da Polymarket, e delega
execução de ordens para este servidor JS.

---

## Weather Bot (Python)

Bot separado (novo repositório Python) para apostar em mercados de clima na Polymarket.

**Fontes de forecast gratuitas:**
- Open-Meteo — 15+ modelos ensemble, horário, global, sem API key
- NOAA/NWS API — probabilistic forecasts para EUA

**Fluxo:**
1. Consumir Open-Meteo ensemble → distribuição de probabilidade para o evento
2. Puxar mercados de weather da Polymarket (Gamma API)
3. Calcular edge (modelo prob vs preço Polymarket)
4. Executar via Trading API Layer acima (ou `py-clob-client` diretamente)
