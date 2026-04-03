import { ClobClient, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";

let _cached = null;

export async function initTradingClient(config) {
  if (_cached) return _cached;

  const { privateKey, funder, signatureType, tradeAmount } = config.trading;

  if (!privateKey) {
    _cached = { client: null, tradingEnabled: false, tradeAmount: 0 };
    return _cached;
  }

  const signer = new Wallet(privateKey);
  const sigType = signatureType === 1
    ? SignatureType.POLY_PROXY
    : signatureType === 2
      ? SignatureType.POLY_GNOSIS_SAFE
      : SignatureType.EOA;
  const funderAddr = funder || signer.address;

  const clientL1 = new ClobClient(
    config.clobBaseUrl,
    137,
    signer,
    undefined,
    sigType,
    funderAddr
  );

  const creds = await clientL1.createOrDeriveApiKey();

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
