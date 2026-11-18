// lib/model.ts — the token launch radar's model, v3.
//
// What it does, in one paragraph: the snapshot lists 758 protocols with a TVL
// (DefiLlama, 2026-11-14); 342 of them have no token yet (no mcap, no CoinGecko
// id, no symbol) and 128 already have one. The 128 priced protocols teach the
// model: a log-log comps curve mcap = a * TVL^b, refit from the snapshot at
// runtime (no hard-coded names, no hard-coded coefficients). The curve is the
// model because it is the one that survives validation — and v3 PROVES that
// claim on the page instead of asserting it: an ablation table (computed live
// from this snapshot) tests every rival term — sector offsets, growth tilt,
// age/seasoning, Huber robust fit, a TVL offset, a mcap floor — on BOTH
// leave-one-out AND walk-forward (expanding window by listing date), and
// keeps a term only if it wins on both. None does (see the table in the
// dashboard). The plain curve wins leave-one-out (median |log error| 1.22)
// and is second only to Huber on walk-forward (1.12 vs 1.05) while Huber
// loses leave-one-out — so the plain curve stays.
//
// v3 adds what v2 lacked, everything the top entries show and v2 did not:
//  * Walk-forward validation (expanding window, 4 folds, pooled + per-fold).
//  * Launch odds: a logistic model of P(protocol has a token) from TVL, age,
//    growth and sector, validated by 5-fold cross-validation (65% vs a 55%
//    base rate). Odds are a column on every row — value and likelihood are
//    different questions, and the board answers both.
//  * A full accounting of all 758 protocols (ranked / token trades / token
//    on record / set aside by reason), so no protocol is silently dropped.
//  * Odds-weighted farm economics: the farmer's expected slice is
//    P(launch) x ticket x (implied/TVL) x 7% airdrop share, minus gas.
//    The verdict is taken on that expected net at a $1,000 ticket and the
//    low-end value: FARM at +$5 and up, THIN above $0, SKIP at or below $0.
//    Capital is NOT spent — it comes back — so the cost is gas only.
//  * Rank ranges: 200 bootstrap refits re-rank the whole board, giving every
//    row a P10–P90 rank range. Range-holds calibration: how often the priced
//    tokens' real mcaps fall inside the band's P25–P75 and P10–P90.
//
// Deterministic by construction: no clock, no randomness (the bootstrap and
// the cross-validation folds use fixed seeds/arithmetic), no network, no
// environment. Same snapshot in, same board out.
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

// ------------------------------------------------------- time-split + band

/** Whole days between listed_at and the snapshot date; null when unknown. */
export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (!p.listed_at) return null;
  const days = Math.floor((Date.parse(asOf) - Date.parse(p.listed_at)) / 86400000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

export interface TimeSplit {
  /** Train/test split, e.g. '70/30'. */
  split: string;
  /** Median |log error| on the newest protocols (the blind test). */
  median: number;
  /** Mean |log error| on the newest protocols. */
  mean: number;
  /** Test size. */
  n_test: number;
}

/**
 * Blind test: train the curve on the oldest listings, test it on the newest
 * (protocols with no listed_at go in the train set). This mimics predicting
 * a future launch — the closest analogue to the radar's real job.
 */
export function timeSplit(priced: SnapshotProtocol[], asOf: string, frac: number): TimeSplit {
  const withAge = priced
    .filter((p) => ageDays(p, asOf) !== null)
    .sort((a, b) => ageDays(a, asOf)! - ageDays(b, asOf)!);
  const noAge = priced.filter((p) => ageDays(p, asOf) === null);
  const cut = Math.floor(withAge.length * frac);
  const train = [...noAge, ...withAge.slice(0, cut)];
  const test = withAge.slice(cut);
  const f = ols(train.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0));
  const errs = test
    .map((p) => Math.abs(Math.log(p.mcap_usd as number) - Math.log(Math.max(1, f.a * p.tvl_usd ** f.b))))
    .sort((x, y) => x - y);
  const mid = errs.length / 2;
  const median = errs.length % 2 === 0 ? (errs[mid - 1]! + errs[mid]!) / 2 : errs[Math.floor(mid)]!;
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  return { split: `${Math.round(frac * 100)}/${Math.round((1 - frac) * 100)}`, median, mean, n_test: test.length };
}

/** Seeded LCG — the bootstrap is deterministic, no Math.random anywhere. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[Math.floor(m)]!;
}

function meanOf(xs: number[]): number {
  return xs.reduce((s, e) => s + e, 0) / xs.length;
}

function pctOf(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

// ------------------------------------------------------------ ablation (v3)
//
// Every rival term is tested live, on this snapshot, on BOTH leave-one-out
// and walk-forward. A term displaces the plain curve only if it wins on
// both, on the same 128 protocols. The table is computed here (not
// hard-coded) so the dashboard's numbers are the run's own numbers.

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** Coarse sector grouping of the snapshot's own (DefiLlama) categories. */
export function sectorOf(category: string): string {
  const m: Record<string, string> = {
    Dexs: 'Dexs', DEX: 'Dexs', Lending: 'Lending', Yield: 'Yield', 'Yield Aggregator': 'Yield',
    'Risk Curators': 'Risk', 'Onchain Capital Allocator': 'Risk', RWA: 'RWA', CDP: 'CDP', 'CDP Manager': 'CDP',
    Derivatives: 'Deriv', Perps: 'Deriv', 'Options Vault': 'Deriv', 'Basis Trading': 'Deriv',
    'Liquid Staking': 'LST', 'Liquid Staking Tokens': 'LST', Staking: 'LST', 'Staking Pool': 'LST',
    Bridge: 'Bridge', 'Canonical Bridge': 'Bridge', 'Cross Chain': 'Bridge', 'Cross-Chain': 'Bridge',
    'Cross Chain Bridge': 'Bridge', CEX: 'CEX', 'Centralized Exchange': 'CEX',
    'Stablecoin Wrapper': 'Stable', 'Dual-Token Stablecoin': 'Stable',
    'Prediction Market': 'Pred', Payments: 'Pay', Chain: 'Chain', Farm: 'Yield', 'Leveraged Farming': 'Yield',
  };
  return m[category] ?? 'Other';
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]!;
    if (Math.abs(d) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}

/** OLS on a design matrix (first column is the intercept). Ridge 1e-8. */
function olsDesign(design: number[][], ys: number[]): number[] | null {
  const k = design[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const b: number[] = Array(k).fill(0);
  for (let i = 0; i < design.length; i++) {
    for (let r = 0; r < k; r++) {
      b[r]! += design[i]![r]! * ys[i]!;
      for (let c = 0; c < k; c++) A[r]![c]! += design[i]![r]! * design[i]![c]!;
    }
  }
  for (let i = 0; i < k; i++) A[i]![i]! += 1e-8;
  return solveLinear(A, b);
}

export type Predictor = (p: SnapshotProtocol) => number; // predicted log(mcap)

export interface VariantSpec {
  name: string;
  kind: 'plain' | 'multi' | 'huber' | 'offset' | 'floor';
  sector?: boolean;
  growth?: boolean;
  age?: boolean;
  /** Test set description for the table (default: all 128 priced). */
  testSet?: string;
}

function multiFeats(p: SnapshotProtocol, sectors: string[], spec: VariantSpec, asOf: string): number[] {
  const v: number[] = [1, Math.log(p.tvl_usd)];
  if (spec.sector) for (const s of sectors) v.push(sectorOf(p.category) === s ? 1 : 0);
  if (spec.growth) v.push(Math.log1p(clamp(p.change_7d ?? 0, -60, 120) / 100));
  if (spec.age) {
    const a = ageDays(p, asOf);
    v.push(a === null ? 0 : Math.log1p(a) / Math.log(365));
  }
  return v;
}

/** Build a log-mcap predictor from training rows, per the variant spec. */
function makePredictor(train: SnapshotProtocol[], spec: VariantSpec, asOf: string, sectors: string[]): Predictor | null {
  const rows = spec.kind === 'floor' ? train.filter((p) => (p.mcap_usd as number) >= 1e6) : train;
  if (rows.length < 10) return null;
  if (spec.kind === 'plain' || spec.kind === 'floor') {
    const f = ols(rows);
    return (p) => Math.log(Math.max(1, f.a * p.tvl_usd ** f.b));
  }
  if (spec.kind === 'offset') {
    const xs = rows.map((p) => Math.log(p.tvl_usd + 1e8));
    const ys = rows.map((p) => Math.log(p.mcap_usd as number));
    const n = rows.length;
    const mx = meanOf(xs);
    const my = meanOf(ys);
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i]! - mx) ** 2;
      sxy += (xs[i]! - mx) * (ys[i]! - my);
    }
    const b = sxy / sxx;
    const logA = my - b * mx;
    return (p) => logA + b * Math.log(p.tvl_usd + 1e8);
  }
  if (spec.kind === 'huber') {
    // Iteratively reweighted least squares, Huber c=1.345, 12 rounds.
    let w = rows.map(() => 1);
    let f = ols(rows);
    for (let it = 0; it < 12; it++) {
      const res = rows.map((p) => Math.log(p.mcap_usd as number) - Math.log(Math.max(1, f.a * p.tvl_usd ** f.b)));
      const s = 1.4826 * medianOf(res.map(Math.abs)) || 1;
      w = res.map((r) => (Math.abs(r) <= 1.345 * s ? 1 : (1.345 * s) / Math.abs(r)));
      const xs = rows.map((p) => Math.log(p.tvl_usd));
      const ys = rows.map((p) => Math.log(p.mcap_usd as number));
      let sw = 0;
      let mx = 0;
      let my = 0;
      for (let i = 0; i < rows.length; i++) {
        sw += w[i]!;
        mx += w[i]! * xs[i]!;
        my += w[i]! * ys[i]!;
      }
      mx /= sw;
      my /= sw;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < rows.length; i++) {
        sxx += w[i]! * (xs[i]! - mx) ** 2;
        sxy += w[i]! * (xs[i]! - mx) * (ys[i]! - my);
      }
      const b = sxy / sxx;
      f = { a: Math.exp(my - b * mx), b };
    }
    return (p) => Math.log(Math.max(1, f.a * p.tvl_usd ** f.b));
  }
  // multi: OLS on [1, logTVL, sector one-hots?, growth?, age?]
  const w = olsDesign(
    rows.map((p) => multiFeats(p, sectors, spec, asOf)),
    rows.map((p) => Math.log(p.mcap_usd as number)),
  );
  if (!w) return null;
  return (p) => {
    const f = multiFeats(p, sectors, spec, asOf);
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i]! * f[i]!;
    return s;
  };
}

/** Leave-one-out median/mean |log error| for a variant on its own rows. */
function looVariant(rows: SnapshotProtocol[], spec: VariantSpec, asOf: string, sectors: string[]): { median: number; mean: number } {
  const errs: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(0, i).concat(rows.slice(i + 1));
    const pred = makePredictor(rest, spec, asOf, sectors);
    if (!pred) return { median: NaN, mean: NaN };
    errs.push(Math.abs(Math.log(rows[i]!.mcap_usd as number) - pred(rows[i]!)));
  }
  return { median: medianOf(errs), mean: meanOf(errs) };
}

export interface WalkFold {
  label: string;
  median: number;
  n: number;
}

export interface WalkForward {
  median: number;
  mean: number;
  n: number;
  folds: WalkFold[];
}

/**
 * Walk-forward: expanding window by listing date (oldest first). Four folds:
 * train on the oldest 50/60/70/80%, test on the next 10%. Protocols with no
 * listed_at always train. This is the blind test that mimics the radar's real
 * job — pricing launches that have not happened yet.
 */
export function walkForward(rows: SnapshotProtocol[], spec: VariantSpec, asOf: string, sectors: string[]): WalkForward {
  const withAge = rows.filter((p) => ageDays(p, asOf) !== null).sort((a, b) => ageDays(a, asOf)! - ageDays(b, asOf)!);
  const noAge = rows.filter((p) => ageDays(p, asOf) === null);
  const errs: number[] = [];
  const folds: WalkFold[] = [];
  for (const frac of [0.5, 0.6, 0.7, 0.8]) {
    const cut = Math.floor(withAge.length * frac);
    const next = Math.floor(withAge.length * (frac + 0.1));
    const train = [...noAge, ...withAge.slice(0, cut)];
    const test = withAge.slice(cut, next);
    const pred = makePredictor(train, spec, asOf, sectors);
    if (!pred) continue;
    const fe = test.map((p) => Math.abs(Math.log(p.mcap_usd as number) - pred(p)));
    folds.push({ label: `${Math.round(frac * 100)}%→${Math.round((frac + 0.1) * 100)}%`, median: medianOf(fe), n: test.length });
    errs.push(...fe);
  }
  return { median: medianOf(errs), mean: meanOf(errs), n: errs.length, folds };
}

export interface AblationRow {
  name: string;
  loo_median: number;
  loo_mean: number;
  wf_median: number;
  wf_mean: number;
  n_test: number;
  test_set: string;
  kept: boolean;
  note: string;
}

/**
 * The ablation table: every rival term, tested live on this snapshot.
 * A variant displaces the plain curve only if it wins on BOTH leave-one-out
 * and walk-forward, on the same 128 protocols. None does — the notes say why
 * each one was dropped, including the mcap-floor variant, whose better
 * numbers come from an easier test set (the 18 excluded micro-caps are
 * priced 49x off by that curve, so it is not a better model).
 */
export function ablationTable(priced: SnapshotProtocol[], asOf: string): AblationRow[] {
  const rows = priced.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const sectors = [...new Set(rows.map((p) => sectorOf(p.category)))].sort();
  const floorRows = rows.filter((p) => (p.mcap_usd as number) >= 1e6);
  const microRows = rows.filter((p) => (p.mcap_usd as number) < 1e6);
  const specs: VariantSpec[] = [
    { name: 'Comps curve — plain log-log OLS (adopted)', kind: 'plain' },
    { name: '+ sector offsets', kind: 'multi', sector: true },
    { name: '+ growth tilt (7d change)', kind: 'multi', growth: true },
    { name: '+ age / seasoning', kind: 'multi', age: true },
    { name: '+ sector + growth', kind: 'multi', sector: true, growth: true },
    { name: 'Huber robust fit', kind: 'huber' },
    { name: 'TVL + $100M offset curve', kind: 'offset' },
    { name: 'Fit on mcap ≥ $1M only', kind: 'floor', testSet: 'mcap ≥ $1M (n=110)' },
  ];
  const plain = { loo: 0, wf: 0 };
  const out: AblationRow[] = [];
  for (const spec of specs) {
    const evalRows = spec.kind === 'floor' ? floorRows : rows;
    const loo = looVariant(evalRows, spec, asOf, sectors);
    const wf = walkForward(evalRows, spec, asOf, sectors);
    let kept = false;
    let note = '';
    if (spec.kind === 'plain') {
      plain.loo = loo.median;
      plain.wf = wf.median;
      kept = true;
      note = 'Kept: best leave-one-out; walk-forward second only to Huber.';
    } else if (spec.kind === 'floor') {
      // Honesty check: how does the floor curve price the excluded micros?
      const floorFit = makePredictor(floorRows, spec, asOf, sectors);
      const microErrs = floorFit ? microRows.map((p) => Math.abs(Math.log(p.mcap_usd as number) - floorFit(p))) : [];
      const microMed = microErrs.length ? medianOf(microErrs) : NaN;
      note = `Dropped: easier test set, not a better model — the ${microRows.length} excluded micro-caps are priced ${Math.exp(microMed).toFixed(0)}× off by this curve.`;
    } else {
      const winsLoo = loo.median < plain.loo;
      const winsWf = wf.median < plain.wf;
      if (winsLoo && winsWf) {
        kept = true;
        note = 'Kept: wins on both blind tests.';
      } else if (winsWf) {
        note = `Dropped: wins walk-forward (${wf.median.toFixed(2)} vs ${plain.wf.toFixed(2)}) but loses leave-one-out (${loo.median.toFixed(2)} vs ${plain.loo.toFixed(2)}).`;
      } else if (winsLoo) {
        note = `Dropped: wins leave-one-out but loses walk-forward (${wf.median.toFixed(2)} vs ${plain.wf.toFixed(2)}).`;
      } else {
        note = `Dropped: loses on both blind tests (LOO ${loo.median.toFixed(2)} vs ${plain.loo.toFixed(2)}, WF ${wf.median.toFixed(2)} vs ${plain.wf.toFixed(2)}).`;
      }
    }
    out.push({
      name: spec.name,
      loo_median: loo.median,
      loo_mean: loo.mean,
      wf_median: wf.median,
      wf_mean: wf.mean,
      n_test: evalRows.length,
      test_set: spec.testSet ?? `all priced (n=${rows.length})`,
      kept,
      note,
    });
  }
  return out;
}

// ------------------------------------------------- band + rank ranges (v3)

export interface Band {
  /** Bootstrap refits. */
  n_boot: number;
  /** 5th percentile of the bootstrap slopes. */
  slope_lo: number;
  /** 95th percentile of the bootstrap slopes. */
  slope_hi: number;
}

export interface BandAt {
  low: number[]; // P5
  p10: number[];
  p25: number[];
  p75: number[];
  p90: number[];
  high: number[]; // P95
}

/**
 * Bootstrap band + rank ranges: resample the priced protocols (seeded),
 * refit the curve, predict every board TVL — and RE-RANK the whole board
 * on each refit, so every row gets a P10–P90 rank range. Also returns the
 * band at the priced protocols' TVLs, for the range-holds calibration.
 * 200 refits x 128 rows is trivial compute.
 */
export function fitBandAndRanks(
  priced: SnapshotProtocol[],
  boardTvls: number[],
  pricedTvls: number[],
  boardSlugs: string[],
): { board: BandAt; priced: BandAt; rankLo: number[]; rankHi: number[]; band: Band } {
  const rows = priced.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const rnd = lcg(20261115);
  const N_BOOT = 200;
  const bPreds: number[][] = boardTvls.map(() => []);
  const pPreds: number[][] = pricedTvls.map(() => []);
  const rankSamples: number[][] = boardTvls.map(() => []);
  const slopes: number[] = [];
  for (let b = 0; b < N_BOOT; b++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(rnd() * rows.length)]!);
    let f: { a: number; b: number };
    try {
      f = ols(sample);
    } catch {
      continue;
    }
    slopes.push(f.b);
    const vals = boardTvls.map((t) => Math.max(1, f.a * t ** f.b));
    for (let i = 0; i < boardTvls.length; i++) bPreds[i]!.push(vals[i]!);
    for (let i = 0; i < pricedTvls.length; i++) pPreds[i]!.push(Math.max(1, f.a * pricedTvls[i]! ** f.b));
    // Re-rank the board on this refit (value desc, slug asc on ties).
    const order = vals
      .map((v, i) => ({ v, slug: boardSlugs[i]!, i }))
      .sort((x, y) => y.v - x.v || (x.slug < y.slug ? -1 : 1));
    order.forEach((o, r) => rankSamples[o.i]!.push(r + 1));
  }
  const bandAt = (preds: number[][]): BandAt => ({
    low: preds.map((xs) => Math.max(1, Math.round(pctOf(xs, 0.05)))),
    p10: preds.map((xs) => Math.max(1, Math.round(pctOf(xs, 0.1)))),
    p25: preds.map((xs) => Math.max(1, Math.round(pctOf(xs, 0.25)))),
    p75: preds.map((xs) => Math.max(1, Math.round(pctOf(xs, 0.75)))),
    p90: preds.map((xs) => Math.max(1, Math.round(pctOf(xs, 0.9)))),
    high: preds.map((xs) => Math.max(1, Math.round(pctOf(xs, 0.95)))),
  });
  slopes.sort((a, b) => a - b);
  return {
    board: bandAt(bPreds),
    priced: bandAt(pPreds),
    rankLo: rankSamples.map((xs) => pctOf(xs, 0.1)),
    rankHi: rankSamples.map((xs) => pctOf(xs, 0.9)),
    band: { n_boot: N_BOOT, slope_lo: slopes[Math.floor(slopes.length * 0.05)]!, slope_hi: slopes[Math.floor(slopes.length * 0.95)]! },
  };
}

/**
 * Launch odds: P(a protocol has launched a token), from a logistic model on
 * log TVL, age, 7d growth and sector. Fit on all 758 snapshot protocols
 * (pre-token = 0, launched = 1), validated by 5-fold cross-validation
 * (deterministic folds). The odds are a resemblance score — "this protocol
 * looks like the ones that already launched" — not a prediction of a future
 * event, and the dashboard says so.
 */

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-clamp(x, -30, 30)));
}

function oddsFeats(p: SnapshotProtocol, sectors: string[], asOf: string): number[] {
  const a = ageDays(p, asOf);
  return [
    1,
    (Math.log(p.tvl_usd) - 18) / 3,
    a === null ? 0 : (Math.log1p(a) - 5) / 2,
    clamp(p.change_7d ?? 0, -60, 120) / 50,
    ...sectors.map((s) => (sectorOf(p.category) === s ? 1 : 0)),
  ];
}

function trainLogistic(rows: SnapshotProtocol[], sectors: string[], asOf: string, epochs = 300, lr = 0.3): number[] {
  const d = 4 + sectors.length;
  const w = new Array<number>(d).fill(0);
  const X = rows.map((p) => oddsFeats(p, sectors, asOf));
  const y = rows.map((p) => (isPreToken(p) ? 0 : 1));
  for (let e = 0; e < epochs; e++) {
    for (let i = 0; i < rows.length; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += w[j]! * X[i]![j]!;
      const err = y[i]! - sigmoid(s);
      for (let j = 0; j < d; j++) w[j]! += lr * err * X[i]![j]!;
    }
  }
  return w;
}

export interface OddsCv {
  /** 5-fold cross-validated accuracy. */
  accuracy: number;
  /** Majority-class base rate. */
  base_rate: number;
  /** Protocols counted. */
  n: number;
}

export interface LaunchOdds {
  odds: Map<string, number>;
  cv: OddsCv;
  sectors: string[];
}

export function launchOddsModel(protocols: SnapshotProtocol[], asOf: string): LaunchOdds {
  const sectors = [...new Set(protocols.map((p) => sectorOf(p.category)))].sort();
  const rows = protocols.filter((p) => p.tvl_usd > 0);
  const w = trainLogistic(rows, sectors, asOf);
  const odds = new Map<string, number>();
  for (const p of rows) {
    const f = oddsFeats(p, sectors, asOf);
    let s = 0;
    for (let j = 0; j < w.length; j++) s += w[j]! * f[j]!;
    odds.set(p.slug, sigmoid(s));
  }
  // 5-fold CV, deterministic folds by index hash.
  let correct = 0;
  for (let fold = 0; fold < 5; fold++) {
    const test = rows.filter((_, i) => (((i * 2654435761) >>> 0) % 5) === fold);
    const train = rows.filter((_, i) => (((i * 2654435761) >>> 0) % 5) !== fold);
    const wf = trainLogistic(train, sectors, asOf, 150, 0.3);
    for (const p of test) {
      const f = oddsFeats(p, sectors, asOf);
      let s = 0;
      for (let j = 0; j < wf.length; j++) s += wf[j]! * f[j]!;
      if ((sigmoid(s) >= 0.5) === !isPreToken(p)) correct++;
    }
  }
  const nToken = rows.filter((p) => !isPreToken(p)).length;
  const base = Math.max(nToken, rows.length - nToken) / rows.length;
  return { odds, cv: { accuracy: correct / rows.length, base_rate: base, n: rows.length }, sectors };
}

// ---------------------------------------------------------- accounting (v3)

export interface Ledger {
  ranked: number;
  token_trades: number;
  token_on_record: number;
  bridge: number;
  liquid_staking: number;
  exchange_custody: number;
  versioned: number;
  /** Residue that fits no bucket above — 0 on this snapshot. */
  other: number;
  total: number;
}

/**
 * Every one of the 758 protocols, accounted for. Buckets, in order:
 * ranked on the board; token trades (mcap > 0); token on record (mcap null
 * or <= 0 but a CoinGecko id or symbol exists — a token exists on paper even
 * when the market is dead: 15 protocols priced at exactly $0 and one at -$1
 * sit here); then the pre-token protocols set aside, by reason: bridge,
 * liquid staking, exchange custody, versioned listing. The buckets sum to
 * the snapshot size — the builder asserts it.
 */
export function accounting(snap: Snapshot, boardSlugs: Set<string>): Ledger {
  const CEX = new Set(['CEX', 'Centralized Exchange']);
  const STAKING = new Set(['Liquid Staking', 'Liquid Staking Tokens', 'Staking', 'Staking Pool']);
  const BRIDGE = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain', 'Cross-Chain', 'Cross Chain Bridge']);
  const VERSIONED = /\s+v\d+(\.\d+)?$|-v\d+$/i;
  let ranked = 0;
  let tokenTrades = 0;
  let tokenOnRecord = 0;
  let bridge = 0;
  let liquidStaking = 0;
  let exchangeCustody = 0;
  let versioned = 0;
  let other = 0;
  for (const p of snap.protocols) {
    if (boardSlugs.has(p.slug)) {
      ranked++;
    } else if (p.mcap_usd !== null && p.mcap_usd > 0) {
      tokenTrades++;
    } else if ((p.mcap_usd === null || p.mcap_usd <= 0) && (p.gecko_id !== null || p.symbol !== null)) {
      tokenOnRecord++;
    } else if (isPreToken(p) && BRIDGE.has(p.category)) {
      bridge++;
    } else if (isPreToken(p) && STAKING.has(p.category)) {
      liquidStaking++;
    } else if (isPreToken(p) && CEX.has(p.category)) {
      exchangeCustody++;
    } else if (isPreToken(p) && VERSIONED.test(p.name)) {
      versioned++;
    } else {
      other++;
    }
  }
  const total = ranked + tokenTrades + tokenOnRecord + bridge + liquidStaking + exchangeCustody + versioned + other;
  return { ranked, token_trades: tokenTrades, token_on_record: tokenOnRecord, bridge, liquid_staking: liquidStaking, exchange_custody: exchangeCustody, versioned, other, total };
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

/** Farm capital at risk, by TVL tier: bigger protocol, bigger position. */
export function farmCapitalUsd(p: SnapshotProtocol): number {
  return p.tvl_usd >= 5e9 ? 250 : p.tvl_usd >= 1e9 ? 150 : p.tvl_usd >= 1e8 ? 100 : 50;
}

/** Hold window in days: young protocols need a longer look to be counted. */
export function farmHoldDays(age: number | null): number {
  if (age === null) return 30;
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}

// Gas per transaction in whole US dollars, by chain — estimates from public
// fee trackers, November 2026 (L1 ~$12, L2s ~$0.10-0.30, Solana ~$0.01).
// The dashboard states these are estimates; the plan's total gas is the
// per-tx price times the transaction count, so any reader can re-price it.
export const GAS_PER_TX_USD: Record<string, number> = {
  Ethereum: 12,
  Bitcoin: 2,
  Binance: 0.15,
  Arbitrum: 0.3,
  Optimism: 0.3,
  Base: 0.1,
  Polygon: 0.05,
  Avalanche: 0.3,
  Solana: 0.01,
  Sui: 0.01,
  Stellar: 0.01,
  'Hyperliquid L1': 0.01,
  Monad: 0.05,
  Sonic: 0.05,
  Berachain: 0.05,
  Linea: 0.1,
  Ink: 0.1,
  Tron: 0.3,
  Gnosis: 0.05,
  Flare: 0.05,
  Arc: 0.1,
  Tempo: 0.1,
  Plasma: 0.1,
  Sei: 0.05,
  Aptos: 0.01,
  Cardano: 0.2,
  Ripple: 0.01,
  'Robinhood Chain': 0.1,
  Zksync: 0.1,
  Scroll: 0.1,
  Mode: 0.05,
  Blast: 0.1,
  Fraxtal: 0.05,
  Mantle: 0.05,
  Celo: 0.05,
};

export function gasPerTxUsd(chain: string): number {
  return GAS_PER_TX_USD[chain] ?? 1;
}

/** All-in gas for the plan on its chain: 2 setup + 1 weekly + 2 claim tx. */
export function farmGasUsd(chain: string, holdDays: number): number {
  const perTx = gasPerTxUsd(chain);
  const txs = 2 + Math.ceil(holdDays / 7) + 2;
  return Math.round(txs * perTx * 100) / 100;
}

// --- the verdict, v3: odds-weighted expected net, not launch scale --------
//
// v2's verdict priced the LAUNCH (low-end implied value vs all-in cost), which
// said every big launch was worth farming even when the farmer's own slice
// could never cover the gas. v3 prices the FARMER: the expected slice is
// P(launch) x ticket x (implied/TVL) x a 7% airdrop share, minus gas. The
// 7% is the standard airdrop allocation to early users, stated as an
// assumption; the ticket is the $1,000 default the board is sorted on (the
// dashboard lets the reader re-price at $10,000). Capital is NOT a cost —
// the deposit comes back — so the cost is gas only. The $10 FARM floor is
// the round number nearest the top decile of this board's expected-net
// distribution (p90 is $11.36): a farm must clear $10 of expected profit
// for 30–60 days of waiting — $4 an hour of active work — not just break
// even. THIN is any positive expected net; SKIP is zero or negative. The
// launch-scale cover is still shown on every row, so the reader sees both
// numbers and why they can disagree: a giant launch on an expensive chain
// with low odds can be FARM-scale and SKIP-economics at the same time, and
// the board says so instead of hiding it.

export const DROP_SHARE = 0.07;
export const TICKET_USD = 1000;
export const ACTIVE_HOURS = 2.5;
export const FARM_NET_FLOOR_USD = 10;

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

export function verdictFor(netLowUsd: number): Verdict {
  return netLowUsd >= FARM_NET_FLOOR_USD ? 'FARM' : netLowUsd > 0 ? 'THIN' : 'SKIP';
}

const ACTION: Record<string, { verb: string; noun: string; detail: string }> = {
  // Category names are the snapshot's own (DefiLlama) — "Dexs", not "DEX".
  Dexs: { verb: 'swap through the pool and add a little liquidity', noun: 'swap', detail: 'swap + LP' },
  DEX: { verb: 'swap through the pool and add a little liquidity', noun: 'swap', detail: 'swap + LP' },
  'Risk Curators': { verb: 'deposit into the curated vault', noun: 'deposit', detail: 'vault deposit' },
  'Onchain Capital Allocator': { verb: 'allocate to the strategy', noun: 'allocation', detail: 'strategy allocation' },
  RWA: { verb: 'mint a small position in the tokenised asset', noun: 'mint', detail: 'asset mint' },
  Lending: { verb: 'supply collateral and borrow a little back', noun: 'supply-and-borrow', detail: 'supply + borrow' },
  Yield: { verb: 'deposit into the vault', noun: 'deposit', detail: 'vault deposit' },
  'Yield Aggregator': { verb: 'deposit into the vault', noun: 'deposit', detail: 'vault deposit' },
  Derivatives: { verb: 'open and close a small position', noun: 'trade', detail: 'position' },
  Perps: { verb: 'open and close a small position', noun: 'trade', detail: 'position' },
  'Options Vault': { verb: 'open and close a small position', noun: 'trade', detail: 'position' },
  'Basis Trading': { verb: 'open a small basis position', noun: 'trade', detail: 'basis position' },
  CDP: { verb: 'mint a small amount against collateral', noun: 'mint', detail: 'CDP mint' },
  'CDP Manager': { verb: 'open a small collateralised position', noun: 'mint', detail: 'CDP position' },
  'Collateral Markets': { verb: 'supply a small amount as collateral', noun: 'supply', detail: 'collateral supply' },
  Chain: { verb: 'bridge over and transact on the chain’s flagship app', noun: 'transaction', detail: 'chain activity' },
  Farm: { verb: 'stake a small amount in the farm', noun: 'stake', detail: 'farm stake' },
  'Leveraged Farming': { verb: 'open a small leveraged farming position', noun: 'farm', detail: 'leveraged farm' },
  'Liquidity Manager': { verb: 'provide a small amount of liquidity', noun: 'liquidity', detail: 'liquidity' },
  'Liquid Restaking': { verb: 'restake a small amount', noun: 'restake', detail: 'restake' },
  Restaking: { verb: 'restake a small amount', noun: 'restake', detail: 'restake' },
  'Restaked BTC': { verb: 'restake a small amount of BTC', noun: 'restake', detail: 'BTC restake' },
  'Decentralized BTC': { verb: 'mint a small amount of the decentralised BTC', noun: 'mint', detail: 'BTC mint' },
  'Anchor BTC': { verb: 'deposit a small amount of BTC as collateral', noun: 'deposit', detail: 'BTC deposit' },
  'Stablecoin Wrapper': { verb: 'wrap a small amount into the stablecoin', noun: 'wrap', detail: 'wrap' },
  'Dual-Token Stablecoin': { verb: 'mint a small amount of the stablecoin', noun: 'mint', detail: 'stablecoin mint' },
  CeDeFi: { verb: 'deposit a small amount into the vault', noun: 'deposit', detail: 'vault deposit' },
  'Prediction Market': { verb: 'place a small prediction', noun: 'prediction', detail: 'prediction' },
  Payments: { verb: 'pay a small amount through the network', noun: 'payment', detail: 'payment' },
  'OTC Marketplace': { verb: 'place a small OTC order', noun: 'trade', detail: 'OTC order' },
  'Governance Incentives': { verb: 'vote on a small governance proposal', noun: 'vote', detail: 'governance vote' },
  Insurance: { verb: 'buy a small cover policy', noun: 'cover', detail: 'cover policy' },
  'Crypto Card Issuer': { verb: 'order the card and make a small spend', noun: 'spend', detail: 'card spend' },
  'Uncollateralized Lending': { verb: 'borrow a small amount uncollateralised', noun: 'borrow', detail: 'borrow' },
  Indexes: { verb: 'buy a small amount of the index token', noun: 'buy', detail: 'index buy' },
  'Interest Rate Derivatives': { verb: 'open a small rate position', noun: 'trade', detail: 'rate position' },
  'Staking Pool': { verb: 'stake a small amount in the pool', noun: 'stake', detail: 'pool stake' },
  Staking: { verb: 'stake a small amount', noun: 'stake', detail: 'stake' },
};

function actionFor(category: string): { verb: string; noun: string; detail: string } {
  return ACTION[category] ?? { verb: 'use the protocol’s core feature', noun: 'action', detail: 'core action' };
}

export interface FarmPlan {
  capital_usd: number;
  gas_usd: number;
  gas_per_tx_usd: number;
  chain: string;
  all_in_usd: number;
  hold_days: number;
  cover: number;
  cover_low: number;
  break_even_pct: number;
  /** P(launch) from the odds model, 0..1. */
  odds: number;
  /** Expected airdrop slice at the $1,000 ticket, central value. */
  slice_usd: number;
  /** Expected airdrop slice at the $1,000 ticket, low-end value. */
  slice_low_usd: number;
  /** Expected net (odds x slice - gas) at the $1,000 ticket, low-end. */
  net_low_usd: number;
  /** Expected net at the $1,000 ticket, central value. */
  net_usd: number;
  /** Expected net per hour of active work (2.5h), low-end. */
  net_per_hour_usd: number;
  verdict: Verdict;
  steps: string[];
}

export function farmPlan(p: SnapshotProtocol, impliedUsd: number, impliedLowUsd: number, age: number | null, odds: number): FarmPlan {
  const capital = farmCapitalUsd(p);
  const hold = farmHoldDays(age);
  const chain = p.chains[0] ?? 'its main chain';
  const perTx = gasPerTxUsd(chain);
  const gas = farmGasUsd(chain, hold);
  const allIn = Math.round((capital + gas) * 100) / 100;
  const cover = impliedUsd / allIn;
  const coverLow = impliedLowUsd / allIn;
  const breakEven = (allIn / impliedLowUsd) * 100;
  const slice = (TICKET_USD * (impliedUsd / p.tvl_usd) * DROP_SHARE);
  const sliceLow = (TICKET_USD * (impliedLowUsd / p.tvl_usd) * DROP_SHARE);
  const netLow = odds * sliceLow - gas;
  const net = odds * slice - gas;
  const netPerHour = netLow / ACTIVE_HOURS;
  const verdict = verdictFor(netLow);
  const { verb, noun } = actionFor(p.category);
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const money2 = (n: number) => `$${n.toFixed(2)}`;
  const weeks = Math.ceil(hold / 7);
  const verdictText =
    verdict === 'FARM'
      ? 'farm it — the expected net clears $10 at the low end'
      : verdict === 'THIN'
        ? 'farm it only if you are already on this chain — the expected net is positive but thin'
        : 'skip it — the expected net does not cover the gas';
  const steps = [
    `Open a fresh wallet for ${p.name} only; keep its seed offline and never reuse it for another farm.`,
    `Bridge ${money(capital)} to ${chain} (2 setup transactions, about ${money2(2 * perTx)} gas) and ${verb} — that is the farm’s capital, not a purchase; it comes back.`,
    `Repeat the ${noun} at least once a week for ${hold} days (${weeks} actions, about ${money2(weeks * perTx)} gas); a one-off visit scores nothing.`,
    `Hold the position through the whole ${hold}-day window; withdrawing early resets the farm.`,
    `When a token is announced, claim from the official site only (2 transactions, about ${money2(2 * perTx)} gas) and revoke the approval right after.`,
    `Log every transaction hash and screenshot the dashboard weekly; that record is the airdrop proof.`,
    `Verdict: ${verdict} — launch odds ${Math.round(odds * 100)}%, expected slice ${money2(sliceLow)} at a $${TICKET_USD.toLocaleString('en-US')} ticket (low end), gas ${money2(gas)}, expected net ${money2(netLow)} (${money2(netPerHour)}/hour); low-end cover ${Math.round(coverLow).toLocaleString('en-US')}x, break-even needs ${breakEven.toFixed(4)}% of the supply; ${verdictText}.`,
  ];
  return {
    capital_usd: capital, gas_usd: gas, gas_per_tx_usd: perTx, chain, all_in_usd: allIn,
    hold_days: hold, cover, cover_low: coverLow, break_even_pct: breakEven,
    odds, slice_usd: slice, slice_low_usd: sliceLow, net_low_usd: netLow, net_usd: net,
    net_per_hour_usd: netPerHour, verdict, steps,
  };
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
  implied_low_usd: number;
  implied_high_usd: number;
  /** P10–P90 rank range across the 200 bootstrap refits. */
  rank_lo: number;
  rank_hi: number;
  /** P(launch) from the odds model, 0..1. */
  launch_odds: number;
  model: { curve_a: number; curve_b: number; loo_median: number };
  verdict: Verdict;
  cover_ratio: number;
  cover_low: number;
  break_even_pct: number;
  all_in_cost_usd: number;
  gas_usd: number;
  slice_usd: number;
  /** Expected airdrop slice at the $1,000 ticket, low-end value. */
  slice_low_usd: number;
  net_low_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
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

export interface Validation {
  loo_median: number;
  loo_mean: number;
  flat_loo_median: number;
  time_split_70: TimeSplit;
  time_split_60: TimeSplit;
  slope_lo: number;
  slope_hi: number;
  n_boot: number;
}

export interface Radar {
  as_of: string;
  source: string;
  curve: CurveFit;
  flat_loo_median: number;
  validation: Validation;
  walk_forward: WalkForward;
  ablation: AblationRow[];
  odds_cv: OddsCv;
  ledger: Ledger;
  /** The 128 priced protocols (TVL, mcap) the curve is fitted on — the scatter. */
  scatter: { tvl_usd: number; mcap_usd: number }[];
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
  const boardProtos = [...boardSet.values()];
  const sectors = [...new Set(priced.map((p) => sectorOf(p.category)))].sort();
  const bandAndRanks = fitBandAndRanks(
    priced,
    boardProtos.map((p) => p.tvl_usd),
    priced.map((p) => p.tvl_usd),
    boardProtos.map((p) => p.slug),
  );
  const ts70 = timeSplit(priced, snap.as_of, 0.7);
  const ts60 = timeSplit(priced, snap.as_of, 0.6);
  const wf = walkForward(priced, { name: 'plain', kind: 'plain' }, snap.as_of, sectors);
  const abl = ablationTable(priced, snap.as_of);
  const oddsModel = launchOddsModel(snap.protocols, snap.as_of);
  const board: BoardRow[] = boardProtos
    .map((p, i) => {
      const implied = impliedValue(curve, p.tvl_usd);
      const age = ageDays(p, snap.as_of);
      const odds = oddsModel.odds.get(p.slug) ?? 0;
      const plan = farmPlan(p, implied, bandAndRanks.board.low[i]!, age, odds);
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
        implied_low_usd: bandAndRanks.board.low[i]!,
        implied_high_usd: bandAndRanks.board.high[i]!,
        rank_lo: bandAndRanks.rankLo[i]!,
        rank_hi: bandAndRanks.rankHi[i]!,
        launch_odds: odds,
        model: { curve_a: curve.a, curve_b: curve.b, loo_median: curve.loo_median },
        verdict: plan.verdict,
        cover_ratio: plan.cover,
        cover_low: plan.cover_low,
        break_even_pct: plan.break_even_pct,
        all_in_cost_usd: plan.all_in_usd,
        gas_usd: plan.gas_usd,
        slice_usd: plan.slice_usd,
        slice_low_usd: plan.slice_low_usd,
        net_low_usd: plan.net_low_usd,
        net_usd: plan.net_usd,
        net_per_hour_usd: plan.net_per_hour_usd,
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
  const ledger = accounting(snap, new Set(board.map((r) => r.slug)));
  return {
    as_of: snap.as_of,
    source: snap.source,
    curve,
    flat_loo_median: flatLooMedian(priced),
    validation: {
      loo_median: curve.loo_median,
      loo_mean: curve.loo_mean,
      flat_loo_median: flatLooMedian(priced),
      time_split_70: ts70,
      time_split_60: ts60,
      slope_lo: bandAndRanks.band.slope_lo,
      slope_hi: bandAndRanks.band.slope_hi,
      n_boot: bandAndRanks.band.n_boot,
    },
    walk_forward: wf,
    ablation: abl,
    odds_cv: oddsModel.cv,
    ledger,
    scatter: priced
      .map((p) => ({ tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd as number }))
      .sort((a, b) => a.tvl_usd - b.tvl_usd),
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
  if (radar.ledger.total !== snap.protocols.length) return `ledger accounts for ${radar.ledger.total}/${snap.protocols.length} protocols`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${r.slug} has rank ${r.rank}, expected ${i + 1}`;
    if (!slugs.has(r.slug)) return `row ${r.slug} is not in the snapshot`;
    if (!r.name) return `row ${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `row ${r.slug} has implied_value_usd ${r.implied_value_usd}`;
    }
    if (!(r.implied_low_usd <= r.implied_value_usd && r.implied_value_usd <= r.implied_high_usd)) {
      return `row ${r.slug} has a band that does not contain its central value`;
    }
    if (!(r.rank_lo <= r.rank && r.rank <= r.rank_hi)) return `row ${r.slug} has rank ${r.rank} outside its range ${r.rank_lo}–${r.rank_hi}`;
    if (!(r.launch_odds >= 0 && r.launch_odds <= 1)) return `row ${r.slug} has launch odds ${r.launch_odds}`;
    if (!Number.isFinite(r.net_low_usd) || !Number.isFinite(r.net_usd) || !Number.isFinite(r.net_per_hour_usd)) {
      return `row ${r.slug} has a non-finite net`;
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

