/** Pure GEX math (A311 gex-tracker convention). */

export interface GexContract {
  strike: number;
  side: "call" | "put";
  gamma: number;
  openInterest: number;
}

export interface GexSummary {
  spot: number;
  netGex: number;
  callGex: number;
  putGex: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  nContracts: number;
}

export function contractGexDollars(gamma: number, openInterest: number, spot: number, isCall: boolean): number {
  const magnitude = gamma * openInterest * 100 * spot * spot * 0.01;
  return isCall ? magnitude : -magnitude;
}

export function computeGexSummary(contracts: GexContract[], spot: number): GexSummary {
  let callGex = 0;
  let putGex = 0;
  const byStrike = new Map<number, { call: number; put: number }>();

  for (const c of contracts) {
    const g = contractGexDollars(c.gamma, c.openInterest, spot, c.side === "call");
    if (c.side === "call") callGex += g;
    else putGex += g;
    const row = byStrike.get(c.strike) ?? { call: 0, put: 0 };
    if (c.side === "call") row.call += g;
    else row.put += g;
    byStrike.set(c.strike, row);
  }

  let callWall: number | null = null;
  let putWall: number | null = null;
  let bestCall = -Infinity;
  let bestPut = Infinity;
  for (const [strike, row] of byStrike) {
    if (row.call > bestCall) {
      bestCall = row.call;
      callWall = strike;
    }
    if (row.put < bestPut) {
      bestPut = row.put;
      putWall = strike;
    }
  }

  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  let gammaFlip: number | null = null;
  let cum = 0;
  for (let i = 0; i < strikes.length; i++) {
    const k = strikes[i]!;
    const netAt = byStrike.get(k)!.call + byStrike.get(k)!.put;
    const prev = cum;
    cum += netAt;
    if (i > 0 && prev !== 0 && cum !== 0 && Math.sign(prev) !== Math.sign(cum)) {
      const prevK = strikes[i - 1]!;
      const t = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum));
      gammaFlip = prevK + t * (k - prevK);
      break;
    }
  }

  return {
    spot,
    netGex: callGex + putGex,
    callGex,
    putGex,
    gammaFlip,
    callWall,
    putWall,
    nContracts: contracts.length,
  };
}
