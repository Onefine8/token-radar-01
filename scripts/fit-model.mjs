// fit-model.mjs — dev tooling for the token-radar-01 entry (NOT part of the runtime).
//
// Reproduces the offline model selection in Node so anyone can re-derive it from
// the kit snapshot: log-log comps curve (mcap = a * TVL^b) fit on the 128 tokenised
// protocols, leave-one-out (LOO) validated against the flat 0.25x multiple the
// starter uses, plus the farm-plan cover distribution that sets the verdict
// thresholds. No network, no randomness: same snapshot in, same numbers out.
//
//   node scripts/fit-model.mjs [path/to/snapshot.json]
//
// Read-outs (snapshot as_of 2026-11-14, 758 protocols, floor $50k... actually
// the snapshot's own floor; 128 with mcap>0):
//   curve a ~= 1058.46, b ~= 0.5223, LOO median |log err| 1.22 (mean 1.60)
//   flat 0.25x:                         LOO median |log err| 1.59 (mean 1.77)
//   -> the curve wins; every fitted variant with extra terms (growth, age,
//      per-category multipliers, trimming, blending) scored WORSE on LOO, so
//      the runtime model is the plain global curve, refit live in lib/model.ts.
import { readFileSync } from 'node:fs';

const SNAPSHOT = process.argv[2] ?? new URL('../kit/input/snapshot.json', import.meta.url).pathname;
const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const prots = snap.protocols;

const isPre = (p) => p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
const priced = prots.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
console.log(`snapshot as_of=${snap.as_of} protocols=${prots.length} priced(mcap>0)=${priced.length} pre-token=${prots.filter(isPre).length}`);

// --- log-log OLS: log(mcap) = log(a) + b*log(tvl) ---------------------------
function fit(rows) {
  const xs = rows.map((p) => Math.log(p.tvl_usd));
  const ys = rows.map((p) => Math.log(p.mcap_usd));
  const n = rows.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxy / sxx;
  const logA = my - b * mx;
  return { a: Math.exp(logA), b, logA };
}
const curve = fit(priced);
console.log(`curve: mcap = ${curve.a.toFixed(4)} * TVL^${curve.b.toFixed(4)}`);

// --- leave-one-out: refit without each row, predict it ----------------------
function looErr(rows, predict) {
  const errs = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(0, i).concat(rows.slice(i + 1));
    const pred = predict(rest, rows[i]);
    errs.push(Math.abs(Math.log(rows[i].mcap_usd) - Math.log(pred)));
  }
  errs.sort((x, y) => x - y);
  const mid = errs.length / 2;
  const med = errs.length % 2 === 0 ? (errs[mid - 1] + errs[mid]) / 2 : errs[Math.floor(mid)];
  const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
  return { median: med, mean };
}
const curveLoo = looErr(priced, (rest, p) => {
  const f = fit(rest);
  return Math.max(1, f.a * p.tvl_usd ** f.b);
});
const flatLoo = looErr(priced, (_rest, p) => Math.max(1, 0.25 * p.tvl_usd));
console.log(`LOO |log err| curve  median=${curveLoo.median.toFixed(3)} mean=${curveLoo.mean.toFixed(3)}`);
console.log(`LOO |log err| flat25 median=${flatLoo.median.toFixed(3)} mean=${flatLoo.mean.toFixed(3)}`);

// --- board audit: strict pre-token set + watchlist coverage ------------------
const CEX = new Set(['CEX', 'Centralized Exchange']);
const LST = new Set(['Liquid Staking', 'Liquid Staking Tokens', 'Staking', 'Staking Pool']);
const BRIDGE = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain', 'Cross-Chain', 'Cross Chain Bridge']);
const VERSIONED = /\s+v\d+(\.\d+)?$|-v\d+$/i;
const WRAPPED = /wrapped|wsteth|steth|reth|cbtc|wbtc/i;
const isCex = (p) => CEX.has(p.category);
const isLst = (p) => LST.has(p.category);
const isBridge = (p) => BRIDGE.has(p.category);
const isVersioned = (p) => VERSIONED.test(p.name ?? '');
const isWrapped = (p) => WRAPPED.test(`${p.name ?? ''} ${p.slug}`);
const strict = prots.filter(
  (p) => isPre(p) && !isCex(p) && !isLst(p) && !isBridge(p) && !isVersioned(p) && !isWrapped(p),
);
const watchlist = snap.watchlist ?? [];
const board = [...new Map([...watchlist.map((s) => prots.find((p) => p.slug === s)).filter(Boolean), ...strict].map((p) => [p.slug, p])).values()];
console.log(`audited pre-token=${prots.filter(isPre).length} strict=${strict.length} watchlist=${watchlist.length} board=${board.length} (watchlist in board=${watchlist.filter((s) => board.some((p) => p.slug === s)).length})`);

// --- farm-plan cover distribution -> verdict thresholds ----------------------
// all-in exposure = capital at risk (by TVL tier) + gas (setup + weekly + claim).
// cover = implied_value / all_in. Thresholds are the round numbers nearest the
// tertiles of this distribution, so the split is ~30% FARM / ~45% THIN / ~25% SKIP.
function capital(p) {
  return p.tvl_usd >= 5e9 ? 250 : p.tvl_usd >= 1e9 ? 150 : p.tvl_usd >= 1e8 ? 100 : 50;
}
function holdDays(p) {
  if (!p.listed_at) return 30;
  const age = Math.max(0, Math.floor((Date.parse(snap.as_of) - Date.parse(p.listed_at)) / 86400000));
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}
const covers = board
  .map((p) => {
    const implied = Math.max(1, Math.round(curve.a * p.tvl_usd ** curve.b));
    const cap = capital(p);
    const h = holdDays(p);
    const gas = (cap >= 150 ? 8 : 4) + 2 * Math.ceil(h / 7) + 3;
    return { slug: p.slug, cover: implied / (cap + gas), implied, allIn: cap + gas };
  })
  .sort((x, y) => x.cover - y.cover);
const q = (f) => covers[Math.floor(covers.length * f)].cover;
console.log(`cover min=${Math.round(covers[0].cover)} p25=${Math.round(q(0.25))} median=${Math.round(q(0.5))} p75=${Math.round(q(0.75))} max=${Math.round(covers[covers.length - 1].cover)}`);
console.log('verdict thresholds: FARM cover>=150000, THIN 75000..150000, SKIP <75000');
const split = { FARM: 0, THIN: 0, SKIP: 0 };
for (const c of covers) split[c.cover >= 150000 ? 'FARM' : c.cover >= 75000 ? 'THIN' : 'SKIP']++;
console.log(`verdict split: FARM=${split.FARM} THIN=${split.THIN} SKIP=${split.SKIP}`);
