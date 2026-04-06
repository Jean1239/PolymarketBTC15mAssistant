import { ClobClient, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
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

  const { privateKey, funder, signatureType, tradeAmount } = config.trading;

  if (!privateKey) {
    _cached = { client: null, tradingEnabled: false, tradeAmount: 0 };
    return _cached;
  }

  const _wallet = new Wallet(privateKey);
  // clob-client v5 detects ethers v5 signers via _signTypedData (renamed to
  // signTypedData in ethers v6). Expose both so the library uses the right path.
  const signer = Object.assign(_wallet, {
    _signTypedData: (domain, types, value) => _wallet.signTypedData(domain, types, value),
    getAddress: () => Promise.resolve(_wallet.address),
  });
  const sigType = signatureType === 1
    ? SignatureType.POLY_PROXY
    : signatureType === 2
      ? SignatureType.POLY_GNOSIS_SAFE
      : SignatureType.EOA;
  // For EOA, funder should be undefined (not the signer address) so the library
  // uses signer address as maker directly.
  const funderAddr = sigType === SignatureType.EOA
    ? undefined
    : (funder || undefined);

  const sigTypeName = sigType === SignatureType.POLY_PROXY ? "POLY_PROXY"
    : sigType === SignatureType.POLY_GNOSIS_SAFE ? "GNOSIS_SAFE" : "EOA";
  logTrading(`EOA=${_wallet.address} funder=${funderAddr ?? "(none)"} sigType=${sigTypeName}(${sigType})`);

  const clientL1 = new ClobClient(
    config.clobBaseUrl,
    137,
    signer,
    undefined,
    sigType,
    funderAddr
  );

  const creds = await clientL1.createOrDeriveApiKey();
  logTrading(`API key derived: ${creds.key ? "OK" : "MISSING"}`);

  const client = new ClobClient(
    config.clobBaseUrl,
    137,
    signer,
    creds,
    sigType,
    funderAddr
  );

  _cached = { client, tradingEnabled: true, tradeAmount };
  return _cached;
}

/** Force re-derive client on next init (useful after config change). */
export function resetTradingClient() {
  _cached = null;
}
