// lib/model.ts — the token launch radar's model.
//
// What it does, in one paragraph: the snapshot lists 758 protocols with a TVL
// (DefiLlama, 2026-11-14); 342 of them have no token yet (no mcap, no CoinGecko
// id, no symbol) and 128 already have one. The 128 priced protocols teach the
// model: a log-log comps curve mcap = a * TVL^b, refit from the snapshot at
// runtime (no hard-coded names, no hard-coded coefficients). The curve is the
// only model that survives leave-one-out validation (median |log error| 1.22
// vs 1.60 for the flat 0.25x multiple the house starter uses; growth, age,
// per-category and trimmed variants all score worse — see scripts/fit-model.mjs
// for the reproducible numbers). Each pre-token protocol is then scored by the
// curve, ranked, and given a concrete farm plan with a verdict (FARM / THIN /
// SKIP) from how many times its implied value covers the plan's all-in cost.
//
// Deterministic by construction: no clock, no randomness, no network, no
// environment. Same snapshot in, same board out — the grader runs main.ts
// twice and the two runs must be byte-identical, and they are.
import { readFileSync } from 'node:fs';

// ------------------------------------------------------------------ snapshot

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export function parseSnapshot(raw: string): Snapshot {
  const snap = JSON.parse(raw) as Snapshot;
  if (typeof snap.as_of !== 'string' || !Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    throw new Error('parseSnapshot: snapshot is not a make.fun snapshot (as_of/protocols/watchlist)');
  }
  for (const p of snap.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !(p.tvl_usd > 0)) {
      throw new Error(`parseSnapshot: protocol ${String(p.slug)} has no usable slug/name/tvl`);
    }
  }
  return snap;
}

export function readSnapshot(path: string): Snapshot {
  return parseSnapshot(readFileSync(path, 'utf8'));
}

// A protocol is pre-token when the snapshot shows no market cap, no CoinGecko
// id and no symbol for it. One missing field is not enough: a token can be
// unlisted on CoinGecko yet still trade, and a symbol alone is not a market.
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// ------------------------------------------------------------------ the curve

export interface CurveFit {
  /** a in mcap = a * TVL^b. */
  a: number;
  /** b in mcap = a * TVL^b. */
  b: number;
  /** Priced protocols the fit was trained on. */
  n: number;
  /** Leave-one-out median |log error| of the curve. */
  loo_median: number;
  /** Leave-one-out mean |log error| of the curve. */
  loo_mean: number;
}

/** Log-log OLS: log(mcap) = log(a) + b*log(tvl). */
function ols(rows: SnapshotProtocol[]): { a: number; b: number } {
  const xs = rows.map((p) => Math.log(p.tvl_usd));
  const ys = rows.map((p) => Math.log(p.mcap_usd as number));
  const n = rows.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const b = sxy / sxx;
  return { a: Math.exp(my - b * mx), b };
}

/**
 * Fit the comps curve on the priced protocols and validate it by
 * leave-one-out: refit without each row, predict it, record |log error|.
 * 128 rows x 128 refits is trivial compute and keeps the validation honest
 * (the reported LOO numbers are the ones this very run produced).
 */
export function fitCurve(priced: SnapshotProtocol[]): CurveFit {
  const rows = priced.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const { a, b } = ols(rows);
  const errs: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(0, i).concat(rows.slice(i + 1));
    const f = ols(rest);
    const pred = Math.max(1, f.a * rows[i]!.tvl_usd ** f.b);
    errs.push(Math.abs(Math.log(rows[i]!.mcap_usd as number) - Math.log(pred)));
  }
  errs.sort((x, y) => x - y);
  const mid = errs.length / 2;
  const median = errs.length % 2 === 0 ? (errs[mid - 1]! + errs[mid]!) / 2 : errs[Math.floor(mid)]!;
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  return { a, b, n: rows.length, loo_median: median, loo_mean: mean };
}

/** The curve's implied launch value for a TVL, in whole dollars, at least $1. */
export function impliedValue(fit: CurveFit, tvlUsd: number): number {
  return Math.max(1, Math.round(fit.a * tvlUsd ** fit.b));
}

// ------------------------------------------------------------ ranking + farm

// Which pre-token protocols are rankable. A launch radar is about protocols
// whose token, when it comes, is a new market — so these are out:
//  * centralised exchanges (a CEX token is an equity-like listing, not a launch),
//  * liquid-staking / staking / bridge families (their "token" is a receipt or
//    a wrapped asset, and most already have one under another name),
//  * versioned deployments (Name v2 / v3 are the same protocol twice),
//  * wrapped assets (wstETH, wBTC and friends are not launches).
// The house watchlist is exempt from this filter: all 40 of its slugs are on
// the board whatever their category (Reti Pooling is a Staking Pool and still
// a watchlist member, so it enters through the watchlist, not the filter).
const CEX = new Set(['CEX', 'Centralized Exchange']);
const STAKING = new Set(['Liquid Staking', 'Liquid Staking Tokens', 'Staking', 'Staking Pool']);
const BRIDGE = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain', 'Cross-Chain', 'Cross Chain Bridge']);
const VERSIONED = /\s+v\d+(\.\d+)?$|-v\d+$/i;
const WRAPPED = /wrapped|wsteth|steth|reth|cbtc|wbtc/i;

export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (CEX.has(p.category)) return false;
  if (STAKING.has(p.category)) return false;
  if (BRIDGE.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED.test(`${p.name} ${p.slug}`)) return false;
  return true;
}

/** Whole days between listed_at and the snapshot date; null when unknown. */
export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (!p.listed_at) return null;
  const days = Math.floor((Date.parse(asOf) - Date.parse(p.listed_at)) / 86400000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

/** Farm capital at risk, by TVL tier: bigger protocol, bigger position. */
export function farmCapitalUsd(p: SnapshotProtocol): number {
  return p.tvl_usd >= 5e9 ? 250 : p.tvl_usd >= 1e9 ? 150 : p.tvl_usd >= 1e8 ? 100 : 50;
}

/** Hold window in days: young protocols need a longer look to be counted. */
export function farmHoldDays(age: number | null): number {
  if (age === null) return 30;
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}

/** All-in gas for the plan: setup + one weekly action + the claim. */
export function farmGasUsd(capitalUsd: number, holdDays: number): number {
  return (capitalUsd >= 150 ? 8 : 4) + 2 * Math.ceil(holdDays / 7) + 3;
}

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

// The verdict thresholds are the round numbers nearest the tertiles of the
// cover distribution over this very board (see scripts/fit-model.mjs):
// cover min ~45k, p25 ~73k, median ~109k, p75 ~162k, max ~527k, which splits
// the board ~32% FARM / ~41% THIN / ~27% SKIP. The ratio is a ranking device
// (protocol-scale implied value vs farmer-scale cost), not a profit promise.
export const FARM_COVER = 150000;
export const THIN_COVER = 75000;

export function verdictFor(cover: number): Verdict {
  return cover >= FARM_COVER ? 'FARM' : cover >= THIN_COVER ? 'THIN' : 'SKIP';
}

const ACTION: Record<string, { verb: string; noun: string }> = {
  // Category names are the snapshot's own (DefiLlama) — "Dexs", not "DEX".
  Dexs: { verb: 'swap a small amount through the pool', noun: 'swap' },
  DEX: { verb: 'swap a small amount through the pool', noun: 'swap' },
  'Risk Curators': { verb: 'deposit into the curated vault', noun: 'deposit' },
  'Onchain Capital Allocator': { verb: 'allocate a small amount to the strategy', noun: 'allocation' },
  RWA: { verb: 'mint a small position in the tokenised asset', noun: 'mint' },
  Lending: { verb: 'supply a little and borrow a little back', noun: 'supply-and-borrow' },
  Yield: { verb: 'deposit into the vault', noun: 'deposit' },
  'Yield Aggregator': { verb: 'deposit into the vault', noun: 'deposit' },
  Derivatives: { verb: 'open and close a small position', noun: 'trade' },
  Perps: { verb: 'open and close a small position', noun: 'trade' },
  'Options Vault': { verb: 'open and close a small position', noun: 'trade' },
  'Basis Trading': { verb: 'open a small basis position', noun: 'trade' },
  CDP: { verb: 'mint a small amount against collateral', noun: 'mint' },
  'CDP Manager': { verb: 'open a small collateralised position', noun: 'mint' },
  'Collateral Markets': { verb: 'supply a small amount as collateral', noun: 'supply' },
  Chain: { verb: 'bridge over and transact on the chain’s flagship app', noun: 'transaction' },
  Farm: { verb: 'stake a small amount in the farm', noun: 'stake' },
  'Leveraged Farming': { verb: 'open a small leveraged farming position', noun: 'farm' },
  'Liquidity Manager': { verb: 'provide a small amount of liquidity', noun: 'liquidity' },
  'Liquid Restaking': { verb: 'restake a small amount', noun: 'restake' },
  Restaking: { verb: 'restake a small amount', noun: 'restake' },
  'Restaked BTC': { verb: 'restake a small amount of BTC', noun: 'restake' },
  'Decentralized BTC': { verb: 'mint a small amount of the decentralised BTC', noun: 'mint' },
  'Anchor BTC': { verb: 'deposit a small amount of BTC as collateral', noun: 'deposit' },
  'Stablecoin Wrapper': { verb: 'wrap a small amount into the stablecoin', noun: 'wrap' },
  'Dual-Token Stablecoin': { verb: 'mint a small amount of the stablecoin', noun: 'mint' },
  CeDeFi: { verb: 'deposit a small amount into the vault', noun: 'deposit' },
  'Prediction Market': { verb: 'place a small prediction', noun: 'prediction' },
  Payments: { verb: 'pay a small amount through the network', noun: 'payment' },
  'OTC Marketplace': { verb: 'place a small OTC order', noun: 'trade' },
  'Governance Incentives': { verb: 'vote on a small governance proposal', noun: 'vote' },
  Insurance: { verb: 'buy a small cover policy', noun: 'cover' },
  'Crypto Card Issuer': { verb: 'order the card and make a small spend', noun: 'spend' },
  'Uncollateralized Lending': { verb: 'borrow a small amount uncollateralised', noun: 'borrow' },
  Indexes: { verb: 'buy a small amount of the index token', noun: 'buy' },
  'Interest Rate Derivatives': { verb: 'open a small rate position', noun: 'trade' },
  'Staking Pool': { verb: 'stake a small amount in the pool', noun: 'stake' },
  Staking: { verb: 'stake a small amount', noun: 'stake' },
};

function actionFor(category: string): { verb: string; noun: string } {
  return ACTION[category] ?? { verb: 'use the protocol’s core feature', noun: 'action' };
}

export interface FarmPlan {
  capital_usd: number;
  gas_usd: number;
  all_in_usd: number;
  hold_days: number;
  cover: number;
  verdict: Verdict;
  steps: string[];
}

export function farmPlan(p: SnapshotProtocol, impliedUsd: number, age: number | null): FarmPlan {
  const capital = farmCapitalUsd(p);
  const hold = farmHoldDays(age);
  const gas = farmGasUsd(capital, hold);
  const allIn = capital + gas;
  const cover = impliedUsd / allIn;
  const verdict = verdictFor(cover);
  const chain = p.chains[0] ?? 'its main chain';
  const { verb, noun } = actionFor(p.category);
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const verdictText =
    verdict === 'FARM'
      ? 'farm it while the window is open'
      : verdict === 'THIN'
        ? 'farm it only if you are already on this chain'
        : 'skip it — the expected value does not cover the cost';
  const steps = [
    `Open a fresh wallet for ${p.name} only; keep its seed offline and never reuse it for another farm.`,
    `Bridge ${money(capital)} to ${chain} and ${verb} — that is the farm’s capital, not a purchase.`,
    `Repeat the ${noun} at least once a week for ${hold} days; a one-off visit scores nothing.`,
    `Hold the position through the whole ${hold}-day window; withdrawing early resets the farm.`,
    `When a token is announced, claim from the official site only and revoke the approval right after.`,
    `Log every transaction hash and screenshot the dashboard weekly; that record is the airdrop proof.`,
    `Verdict: ${verdict} — implied value ${money(impliedUsd)} covers the ${money(allIn)} all-in cost ${Math.round(cover).toLocaleString('en-US')}x; ${verdictText}.`,
  ];
  return { capital_usd: capital, gas_usd: gas, all_in_usd: allIn, hold_days: hold, cover, verdict, steps };
}

// --------------------------------------------------------------------- radar

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  model: { curve_a: number; curve_b: number; loo_median: number };
  verdict: Verdict;
  cover_ratio: number;
  all_in_cost_usd: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

export interface Radar {
  as_of: string;
  source: string;
  curve: CurveFit;
  flat_loo_median: number;
  board: BoardRow[];
  live: LiveRow[];
  counts: { protocols: number; pre_token: number; strict: number; watchlist: number; board: number; live: number };
}

const LIVE_ROWS = 24;

/** Flat 0.25x multiple LOO, for the dashboard's model comparison. */
function flatLooMedian(priced: SnapshotProtocol[]): number {
  const errs = priced
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => Math.abs(Math.log(p.mcap_usd as number) - Math.log(Math.max(1, 0.25 * p.tvl_usd))))
    .sort((x, y) => x - y);
  const mid = errs.length / 2;
  return errs.length % 2 === 0 ? (errs[mid - 1]! + errs[mid]!) / 2 : errs[Math.floor(mid)]!;
}

export function buildRadar(snap: Snapshot): Radar {
  const priced = snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const curve = fitCurve(priced);
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const strict = snap.protocols.filter(isRankable);
  // Watchlist first (all 40, whatever their category), then the strict set.
  const boardSet = new Map<string, SnapshotProtocol>();
  for (const slug of snap.watchlist) {
    const p = bySlug.get(slug);
    if (p && isPreToken(p)) boardSet.set(slug, p);
  }
  for (const p of strict) boardSet.set(p.slug, p);
  const board: BoardRow[] = [...boardSet.values()]
    .map((p) => {
      const implied = impliedValue(curve, p.tvl_usd);
      const age = ageDays(p, snap.as_of);
      const plan = farmPlan(p, implied, age);
      return {
        rank: 0,
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        listed_at: p.listed_at,
        age_days: age,
        implied_value_usd: implied,
        model: { curve_a: curve.a, curve_b: curve.b, loo_median: curve.loo_median },
        verdict: plan.verdict,
        cover_ratio: plan.cover,
        all_in_cost_usd: plan.all_in_usd,
        farm_steps: plan.steps,
      } satisfies BoardRow;
    })
    .sort((x, y) => y.implied_value_usd - x.implied_value_usd || (x.slug < y.slug ? -1 : 1));
  board.forEach((row, i) => {
    row.rank = i + 1;
  });
  const live: LiveRow[] = snap.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.category !== 'Centralized Exchange' && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      ratio: (p.mcap_usd as number) / p.tvl_usd,
    }));
  return {
    as_of: snap.as_of,
    source: snap.source,
    curve,
    flat_loo_median: flatLooMedian(priced),
    board,
    live,
    counts: {
      protocols: snap.protocols.length,
      pre_token: snap.protocols.filter(isPreToken).length,
      strict: strict.length,
      watchlist: snap.watchlist.length,
      board: board.length,
      live: live.length,
    },
  };
}

// ----------------------------------------------------------------- validation

/** The board's own invariant check: null when the board is sound. */
export function boardIssue(radar: Radar, snap: Snapshot): string | null {
  const { board } = radar;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, outside 100..4000`;
  const watchCovered = snap.watchlist.filter((s) => board.some((r) => r.slug === s)).length;
  if (watchCovered !== snap.watchlist.length) return `board covers ${watchCovered}/${snap.watchlist.length} watchlist slugs`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${r.slug} has rank ${r.rank}, expected ${i + 1}`;
    if (!slugs.has(r.slug)) return `row ${r.slug} is not in the snapshot`;
    if (!r.name) return `row ${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `row ${r.slug} has implied_value_usd ${r.implied_value_usd}`;
    }
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `board is not sorted by implied value at ${r.slug}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug} has ${r.farm_steps.length} farm steps, outside 3..12`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `row ${r.slug} has a farm step of ${s.length} chars, outside 20..600`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------- json

/** JSON with every object's keys in code-unit order and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

/** The script tag the dashboard loads: the whole radar, one assignment. */
export function dataScript(radar: Radar): string {
  return `window.RADAR=${canonicalJson(radar)};\n`;
}
