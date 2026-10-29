/** Pure GEX math (A311 gex-tracker convention). */

import { bsGreeks } from "./options-greeks.js";

const RISK_FREE = 0.045;
const FLIP_GRID_PCT = 0.15;
const FLIP_GRID_STEP_PCT = 0.0025;

export interface GexContract {
  strike: number;
  side: "call" | "put";
  gamma: number;
  openInterest: number;
  iv: number;
  dte: number;
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

  const gammaFlip = computeGammaFlip(contracts, spot);

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

function netGexAtHypotheticalSpot(contracts: GexContract[], S: number): number {
  let total = 0;
  for (const c of contracts) {
    const T = Math.max(c.dte, 1) / 365;
    const sigma = c.iv > 0 ? c.iv : 0.2;
    const gamma = bsGreeks(S, c.strike, T, RISK_FREE, sigma, c.side === "call").gamma;
    total += contractGexDollars(gamma, c.openInterest, S, c.side === "call");
  }
  return total;
}

/** Zero crossing of total GEX on spot ±15 % grid (0.25 % steps), nearest actual spot. */
export function computeGammaFlip(contracts: GexContract[], spot: number): number | null {
  if (!(spot > 0) || !contracts.length) return null;
  const low = spot * (1 - FLIP_GRID_PCT);
  const high = spot * (1 + FLIP_GRID_PCT);
  const step = spot * FLIP_GRID_STEP_PCT;
  const points: number[] = [];
  for (let s = low; s <= high + step * 0.5; s += step) points.push(s);

  const values = points.map((p) => netGexAtHypotheticalSpot(contracts, p));
  const crossings: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const v0 = values[i]!;
    const v1 = values[i + 1]!;
    if (v0 === 0) crossings.push(points[i]!);
    else if (v1 === 0) crossings.push(points[i + 1]!);
    else if (Math.sign(v0) !== Math.sign(v1)) {
      const t = Math.abs(v0) / (Math.abs(v0) + Math.abs(v1));
      crossings.push(points[i]! + t * (points[i + 1]! - points[i]!));
    }
  }
  if (!crossings.length) return null;
  return crossings.reduce((best, c) => (Math.abs(c - spot) < Math.abs(best - spot) ? c : best));
}
