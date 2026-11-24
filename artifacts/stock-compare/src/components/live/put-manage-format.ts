/** Pure helpers for Live › put_manage_daily alerts (A280 / S103). */

export type PutManageResell = {
  ticker: string;
  strike: number;
  expiry: string;
  income_wk_pct?: number | null;
};

/** A392 roll / defend fields (put_manage.py). Per-share dollars unless `_usd`. */
export type PutManageRoll = {
  kind: "out" | "down" | "band";
  strike: number;
  expiry: string;
  dte: number;
  extra_days: number;
  sell: number;
  net: number;
  net_usd: number;
  breakeven: number;
  delta?: number | null;
  ann_pct?: number | null;
  p_itm?: number | null;
  p_touch?: number | null;
};

export type PutManageOptions = {
  spot?: number | null;
  rolls?: PutManageRoll[];
  rolls_note?: string;
  prior_roll_credit_usd?: number;
  roll_hops?: number;
  roll_note?: string;
  hold?: { pnl_usd: number; breakeven: number; p_itm?: number | null; p_touch?: number | null };
  close?: { pnl_usd: number; buy_back: number };
  assign?: { basis: number; spot: number; vs_spot_pct: number; loss_usd: number };
};

export type PutManageRow = PutManageOptions & {
  as_of?: string;
  ticker: string;
  strike: number;
  expiry: string;
  captured_pct: number;
  pace: number;
  days_held?: number;
  days_total?: number;
  action: string;
  why?: string;
  notes?: string[];
  resell?: PutManageResell[];
};

export const PUT_MANAGE_METHOD =
  "S103: weekly take at ≥ 4× plan pace was the only early exit that beat holding on real LSEG quotes (+0.02 % of strike/trade, t≈1); trend-flip stops lost.";

export function isTakeAction(action: string): boolean {
  return action === "take + re-sell";
}

export function partitionPutManage(rows: PutManageRow[]): {
  takes: PutManageRow[];
  holds: PutManageRow[];
} {
  const takes: PutManageRow[] = [];
  const holds: PutManageRow[] = [];
  for (const r of rows) {
    if (isTakeAction(r.action)) takes.push(r);
    else holds.push(r);
  }
  return { takes, holds };
}

/** Expiry → m-d (UI dates). */
export function fmtExpiryMd(expiry: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (!m) return expiry;
  return `${Number(m[2])}-${Number(m[3])}`;
}

function fmtStrike(strike: number): string {
  return `${Number(strike)}p`;
}

function fmtResell(r: PutManageResell): string {
  const wk =
    r.income_wk_pct != null && Number.isFinite(r.income_wk_pct)
      ? ` (${Number(r.income_wk_pct).toFixed(2)} %/wk)`
      : "";
  return `${r.ticker} ${fmtStrike(r.strike)}${wk}`;
}

/**
 * Alert line for a take + re-sell row.
 * e.g. "RGTI 10.5p 10-30: captured 62 % in 2 of 7 days (4.3× plan pace) → take profit, re-sell MRVL 205p (0.68 %/wk)"
 */
export function formatTakeAlert(row: PutManageRow): string | null {
  if (!isTakeAction(row.action)) return null;
  const held = row.days_held ?? "?";
  const total = row.days_total ?? "?";
  const pace = Number.isFinite(row.pace) ? row.pace.toFixed(1) : String(row.pace);
  const cap = Number.isFinite(row.captured_pct)
    ? Math.round(row.captured_pct)
    : row.captured_pct;
  const head = `${row.ticker} ${fmtStrike(row.strike)} ${fmtExpiryMd(row.expiry)}: captured ${cap} % in ${held} of ${total} days (${pace}× plan pace) → take profit`;
  const first = row.resell?.[0];
  if (!first) return head;
  return `${head}, re-sell ${fmtResell(first)}`;
}

export type OptionsLine = {
  label: string;
  net: string;
  newPut: string;
  breakeven: string;
  pItm: string;
  pTouch: string;
  ann: string;
};

const num = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);
const usd = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${v < 0 ? "-" : "+"}$${Math.abs(Math.round(v))}`;
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(0)} %`);

const ROLL_LABEL: Record<PutManageRoll["kind"], string> = {
  out: "Roll out",
  down: "Roll down & out",
  band: "Roll to band",
};

/** Hold · Close · Roll out · Roll down & out · Assign lines for the expandable Options row. */
export function optionsLines(row: PutManageRow): OptionsLine[] {
  const empty = { newPut: "—", pItm: "—", pTouch: "—", ann: "—" };
  const lines: OptionsLine[] = [];
  if (row.hold)
    lines.push({
      label: "Hold",
      net: usd(row.hold.pnl_usd),
      newPut: `${Number(row.strike)}p ${fmtExpiryMd(row.expiry)}`,
      breakeven: num(row.hold.breakeven),
      pItm: pct(row.hold.p_itm),
      pTouch: pct(row.hold.p_touch),
      ann: "—",
    });
  if (row.close) lines.push({ label: "Close", net: usd(row.close.pnl_usd), breakeven: "—", ...empty });
  for (const c of row.rolls ?? [])
    lines.push({
      label: ROLL_LABEL[c.kind] ?? c.kind,
      net: usd(c.net_usd),
      newPut: `${Number(c.strike)}p ${fmtExpiryMd(c.expiry)}`,
      breakeven: num(c.breakeven),
      pItm: pct(c.p_itm),
      pTouch: pct(c.p_touch),
      ann: pct(c.ann_pct),
    });
  if (row.assign) {
    const rollUsd = row.prior_roll_credit_usd;
    const hops = row.roll_hops ?? 0;
    let assignPut = `basis ${num(row.assign.basis)}`;
    if (rollUsd != null && rollUsd > 0) {
      const n = hops === 1 ? "1 roll" : `${hops} rolls`;
      assignPut += ` · prior roll credits $${Math.round(rollUsd)} (${n})`;
    }
    if (row.roll_note) assignPut += ` · ${row.roll_note}`;
    lines.push({
      label: "Assign",
      net: usd(row.assign.loss_usd),
      newPut: assignPut,
      breakeven: num(row.assign.basis),
      pItm: "—",
      pTouch: "—",
      ann: `${row.assign.vs_spot_pct >= 0 ? "+" : ""}${row.assign.vs_spot_pct.toFixed(0)} % vs spot`,
    });
  }
  return lines;
}
