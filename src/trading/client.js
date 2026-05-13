import { ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet, ethers } from "ethers";
import fs from "node:fs";

let _cached = null;

function logTrading(msg) {
  try {
    fs.mkdirSync("./logs", { recursive: true });
    fs.appendFileSync("./logs/trade_orders.log",
      `${new Date().toISOString()} [CLIENT] ${msg}\n`);
  } catch { /* ignore */ }
}

export async function initTradingClient(config) {
  if (_cached) return _cached;

  const { privateKey, funder, signatureType, tradeAmount, liveTradingEnabled } = config.trading;

  // Single gate: real orders require both a private key AND the explicit
  // POLYMARKET_LIVE_TRADING=true flag. Anything else stays paper-only.
  if (!privateKey || !liveTradingEnabled) {
    _cached = { ...config.trading, client: null, tradingEnabled: false, tradeAmount: 0, wallet: null };
    return _cached;
  }

  const _wallet = new Wallet(privateKey);
  // clob-client-v2 accepts either a viem WalletClient or an ethers-v5-style
  // signer with `_signTypedData` (renamed to `signTypedData` in ethers v6).
  // Expose the v5 method name as a shim around the v6 implementation.
  const signer = Object.assign(_wallet, {
    _signTypedData: (domain, types, value) => _wallet.signTypedData(domain, types, value),
    getAddress: () => Promise.resolve(_wallet.address),
  });
  let sigType = signatureType === 1
    ? SignatureTypeV2.POLY_PROXY
    : signatureType === 2
      ? SignatureTypeV2.POLY_GNOSIS_SAFE
      : SignatureTypeV2.EOA;

  // For EOA, funder should be undefined (not the signer address) so the library
  // uses signer address as maker directly.
  const funderAddr = sigType === SignatureTypeV2.EOA
    ? undefined
    : (funder || undefined);

  // Auto-detect: se funder é um contrato GnosisSafe mas o tipo está como POLY_PROXY,
  // corrige para POLY_GNOSIS_SAFE automaticamente.
  if (sigType === SignatureTypeV2.POLY_PROXY && funderAddr) {
    try {
      const provider = new ethers.JsonRpcProvider(
        "https://polygon-bor-rpc.publicnode.com",
        ethers.Network.from(137),
        { staticNetwork: ethers.Network.from(137) }
      );
      const code = await provider.getCode(funderAddr);
      if (code && code !== "0x" && code.length > 10) {
        const gsSafe = new ethers.Contract(funderAddr,
          ["function isOwner(address) view returns (bool)"],
          provider
        );
        try {
          const isOwner = await gsSafe.isOwner(_wallet.address);
          if (isOwner) {
            sigType = SignatureTypeV2.POLY_GNOSIS_SAFE;
            logTrading(`Auto-detectado: funder é GnosisSafe, usando POLY_GNOSIS_SAFE. Defina POLYMARKET_SIGNATURE_TYPE=2 para evitar esta detecção.`);
          }
        } catch { /* não é GnosisSafe */ }
      }
      provider.destroy();
    } catch { /* ignora erro de detecção */ }
  }

  const sigTypeName = sigType === SignatureTypeV2.POLY_PROXY ? "POLY_PROXY"
    : sigType === SignatureTypeV2.POLY_GNOSIS_SAFE ? "GNOSIS_SAFE" : "EOA";
  logTrading(`EOA=${_wallet.address} funder=${funderAddr ?? "(none)"} sigType=${sigTypeName}(${sigType})`);

  const clientL1 = new ClobClient({
    host: config.clobBaseUrl,
    chain: 137,
    signer,
    signatureType: sigType,
    funderAddress: funderAddr,
  });

  const creds = await clientL1.createOrDeriveApiKey();
  logTrading(`API key derived: ${creds.key ? "OK" : "MISSING"}`);

  const client = new ClobClient({
    host: config.clobBaseUrl,
    chain: 137,
    signer,
    creds,
    signatureType: sigType,
    funderAddress: funderAddr,
  });

  // balanceAddress: onde está o pUSD — o funder (proxy) ou o EOA
  const balanceAddress = funderAddr ?? _wallet.address;
  // Spread all trading config so downstream consumers (executor, evaluators) can
  // read entryMinMarketPrice, highConvictionMultiplier, timeDecay*, etc. directly
  // from the trading object instead of re-reading CONFIG.trading.
  _cached = { ...config.trading, client, tradingEnabled: true, tradeAmount, balanceAddress, wallet: _wallet };
  return _cached;
}

/** Force re-derive client on next init (useful after config change). */
export function resetTradingClient() {
  _cached = null;
}
