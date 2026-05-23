import { ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet, ethers } from "ethers";
import fs from "node:fs";
import * as paths from "../paths.js";

let _cached = null;

function logTrading(msg) {
  try {
    fs.appendFileSync(paths.tradeOrdersLog,
      `${new Date().toISOString()} [CLIENT] ${msg}\n`);
  } catch { /* ignore */ }
}

export async function initTradingClient(config) {
  if (_cached) return _cached;

  const { privateKey, funder, signatureType, tradeAmount } = config.trading;

  // Single gate: real orders require a private key. EXECUTION_MODE=real (in
  // index.js / index5m.js startup) decides whether to call this initializer
  // at all; this client just refuses to enable when the key is missing.
  if (!privateKey) {
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
      : signatureType === 3
        ? SignatureTypeV2.POLY_1271
        : SignatureTypeV2.EOA;

  // For EOA, funder should be undefined (not the signer address) so the library
  // uses signer address as maker directly.
  const funderAddr = sigType === SignatureTypeV2.EOA
    ? undefined
    : (funder || undefined);

  // Auto-detect when the user left POLYMARKET_SIGNATURE_TYPE on the default
  // POLY_PROXY. We probe the funder contract in this order:
  //   1. Standard Gnosis Safe       — has `isOwner(address)` and returns true for our EOA → switch to POLY_GNOSIS_SAFE.
  //   2. Polymarket smart wallet    — has `isValidSignature(bytes32, bytes)` (EIP-1271)
  //                                   AND single `owner()` matching our EOA → switch to POLY_1271.
  //   3. Otherwise                  — leave as POLY_PROXY (email/magic-auth proxy).
  if (sigType === SignatureTypeV2.POLY_PROXY && funderAddr) {
    try {
      const provider = new ethers.JsonRpcProvider(
        "https://polygon-bor-rpc.publicnode.com",
        ethers.Network.from(137),
        { staticNetwork: ethers.Network.from(137) }
      );
      const code = await provider.getCode(funderAddr);
      if (code && code !== "0x" && code.length > 10) {
        const probe = new ethers.Contract(funderAddr,
          [
            "function isOwner(address) view returns (bool)",
            "function owner() view returns (address)",
          ],
          provider
        );
        try {
          const isSafeOwner = await probe.isOwner(_wallet.address);
          if (isSafeOwner) {
            sigType = SignatureTypeV2.POLY_GNOSIS_SAFE;
            logTrading(`Auto-detectado: funder é GnosisSafe, usando POLY_GNOSIS_SAFE. Defina POLYMARKET_SIGNATURE_TYPE=2 para evitar esta detecção.`);
          }
        } catch {
          // Not a Gnosis Safe — try the Polymarket-proxy / EIP-1271 shape.
          try {
            const ownerAddr = await probe.owner();
            if (ownerAddr && ownerAddr.toLowerCase() === _wallet.address.toLowerCase()) {
              sigType = SignatureTypeV2.POLY_1271;
              logTrading(`Auto-detectado: funder é smart-wallet EIP-1271 (owner=EOA), usando POLY_1271. Defina POLYMARKET_SIGNATURE_TYPE=3 para evitar esta detecção.`);
            }
          } catch { /* nem owner() nem isOwner() — mantém POLY_PROXY */ }
        }
      }
      provider.destroy();
    } catch { /* ignora erro de detecção */ }
  }

  const sigTypeName = sigType === SignatureTypeV2.POLY_PROXY ? "POLY_PROXY"
    : sigType === SignatureTypeV2.POLY_GNOSIS_SAFE ? "GNOSIS_SAFE"
    : sigType === SignatureTypeV2.POLY_1271 ? "POLY_1271"
    : "EOA";
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
