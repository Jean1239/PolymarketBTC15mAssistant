// Order Flow Imbalance scoring for 5m mode.
// Converts raw OFI data (from binanceWsOfi) into directional signals.

export function scoreOrderFlow({ ofi30s, ofi1m, ofi2m }) {
  let up = 0;
  let down = 0;

  // 30s window — most reactive, captures immediate momentum
  if (ofi30s && ofi30s.total > 0) {
    if (ofi30s.ofi > 0.15) up += 2;
    else if (ofi30s.ofi > 0.05) up += 1;
    if (ofi30s.ofi < -0.15) down += 2;
    else if (ofi30s.ofi < -0.05) down += 1;
  }

  // 1m window — confirms direction
  if (ofi1m && ofi1m.total > 0) {
    if (ofi1m.ofi > 0.10) up += 2;
    else if (ofi1m.ofi > 0.03) up += 1;
    if (ofi1m.ofi < -0.10) down += 2;
    else if (ofi1m.ofi < -0.03) down += 1;
  }

  // 2m window — structural pressure
  if (ofi2m && ofi2m.total > 0) {
    if (ofi2m.ofi > 0.08) up += 1;
    if (ofi2m.ofi < -0.08) down += 1;
  }

  // Alignment bonus: all three windows agree
  if (ofi30s?.ofi > 0.05 && ofi1m?.ofi > 0.03 && ofi2m?.ofi > 0.03) up += 1;
  if (ofi30s?.ofi < -0.05 && ofi1m?.ofi < -0.03 && ofi2m?.ofi < -0.03) down += 1;

  return { up, down };
}
