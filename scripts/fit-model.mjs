// fit-model.mjs — dev tooling for the token-radar-01 entry v2 (NOT runtime).
//
// Reproduces the offline model selection in Node so anyone can re-derive it
// from the kit snapshot: the log-log comps curve (mcap = a * TVL^b) fit on
// the 128 tokenised protocols, validated three ways — leave-one-out, two
// blind time splits (train oldest, test newest) and a seeded bootstrap —
// against the flat 0.25x multiple the starter uses, plus the low-end cover
// distribution that sets the verdict thresholds. No network, no randomness
// (bootstrap uses a seeded LCG): same snapshot in, same numbers out.
//
//   node scripts/fit-model.mjs [path/to/snapshot.json]
//
// Read-outs (snapshot as_of 2026-11-14, 758 protocols, 128 with mcap>0):
//   curve a ~= 1058.46, b ~= 0.5223
//   LOO |log err| curve  median=1.223 mean=1.596; flat 0.25x median=1.591
//   time-split 70/30 median=1.207 (n=29); 60/40 median=1.177 (n=38)
//   bootstrap slope 90% CI [0.378, 0.672] (200 refits, seeded)
//   -> the curve wins; 21 fitted variants with extra terms (growth, age,
//      per-category offsets, robust/Huber, winsorised, clean-train, shrunk
//      tilts, k-NN, broken-stick, quadratic, L1) all scored WORSE on LOO or
//      on both time splits, so the runtime model is the plain global curve,
//      refit live in lib/model.ts. See v2/scripts/experiment*.mjs for the
//      full variant tables.
import { readFileSync } from 'node:fs';

const SNAPSHOT = process.argv[2] ?? new URL('../../../kit/token-radar-01-kit/input/snapshot.json', import.meta.url).pathname;
const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const prots = snap.protocols;
const ASOF = Date.parse(snap.as_of);

const isPre = (p) => p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
const priced = prots.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
console.log(`snapshot as_of=${snap.as_of} protocols=${prots.length} priced(mcap>0)=${priced.length} pre-token=${prots.filter(isPre).length}`);

function ageDays(p) {
  if (!p.listed_at) return null;
  const d = Math.floor((ASOF - Date.parse(p.listed_at)) / 86400000);
  return Number.isFinite(d) && d >= 0 ? d : null;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[Math.floor(m)];
}

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

// --- leave-one-out -----------------------------------------------------------
function looErr(rows, predict) {
  const errs = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(0, i).concat(rows.slice(i + 1));
    const pred = predict(rest, rows[i]);
    errs.push(Math.abs(Math.log(rows[i].mcap_usd) - Math.log(pred)));
  }
  return { median: median(errs), mean: errs.reduce((s, e) => s + e, 0) / errs.length };
}
const curveLoo = looErr(priced, (rest, p) => {
  const f = fit(rest);
  return Math.max(1, f.a * p.tvl_usd ** f.b);
});
const flatLoo = looErr(priced, (_rest, p) => Math.max(1, 0.25 * p.tvl_usd));
console.log(`LOO |log err| curve  median=${curveLoo.median.toFixed(3)} mean=${curveLoo.mean.toFixed(3)}`);
console.log(`LOO |log err| flat25 median=${flatLoo.median.toFixed(3)} mean=${flatLoo.mean.toFixed(3)}`);

// --- blind time splits: train oldest, test newest ---------------------------
for (const frac of [0.7, 0.6]) {
  const withAge = priced.filter((p) => ageDays(p) !== null).sort((a, b) => ageDays(a) - ageDays(b));
  const noAge = priced.filter((p) => ageDays(p) === null);
  const cut = Math.floor(withAge.length * frac);
  const train = [...noAge, ...withAge.slice(0, cut)];
  const test = withAge.slice(cut);
  const f = fit(train);
  const errs = test.map((p) => Math.abs(Math.log(p.mcap_usd) - Math.log(Math.max(1, f.a * p.tvl_usd ** f.b))));
  console.log(
    `time-split ${Math.round(frac * 100)}/${Math.round((1 - frac) * 100)} (train=${train.length} test=${test.length}) median=${median(errs).toFixed(3)} mean=${(errs.reduce((s, e) => s + e, 0) / errs.length).toFixed(3)}`,
  );
}

// --- seeded bootstrap: slope stability --------------------------------------
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
{
  const rnd = lcg(20261115);
  const slopes = [];
  for (let b = 0; b < 200; b++) {
    const sample = Array.from({ length: priced.length }, () => priced[Math.floor(rnd() * priced.length)]);
    slopes.push(fit(sample).b);
  }
  slopes.sort((a, b) => a - b);
  console.log(`bootstrap slope 90% CI [${slopes[Math.floor(slopes.length * 0.05)].toFixed(3)}, ${slopes[Math.floor(slopes.length * 0.95)].toFixed(3)}] (200 refits)`);
}

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

// --- low-end cover distribution -> verdict thresholds ------------------------
// all-in = capital at risk (by TVL tier) + gas priced per tx on the plan's
// own chain (2 setup + 1 weekly + 2 claim tx). cover_low = implied_low /
// all-in, where implied_low is the 5th percentile of 200 bootstrap refits.
// Thresholds are the round numbers nearest the tertiles of this distribution.
const GAS = {
  Ethereum: 12, Bitcoin: 2, Binance: 0.15, Arbitrum: 0.3, Optimism: 0.3, Base: 0.1, Polygon: 0.05,
  Avalanche: 0.3, Solana: 0.01, Sui: 0.01, Stellar: 0.01, 'Hyperliquid L1': 0.01, Monad: 0.05,
  Sonic: 0.05, Berachain: 0.05, Linea: 0.1, Ink: 0.1, Tron: 0.3, Gnosis: 0.05, Flare: 0.05,
  Arc: 0.1, Tempo: 0.1, Plasma: 0.1, Sei: 0.05, Aptos: 0.01, Cardano: 0.2, Ripple: 0.01,
  'Robinhood Chain': 0.1, Zksync: 0.1, Scroll: 0.1, Mode: 0.05, Blast: 0.1, Fraxtal: 0.05,
  Mantle: 0.05, Celo: 0.05,
};
function capital(p) {
  return p.tvl_usd >= 5e9 ? 250 : p.tvl_usd >= 1e9 ? 150 : p.tvl_usd >= 1e8 ? 100 : 50;
}
function holdDays(p) {
  const age = ageDays(p);
  if (age === null) return 30;
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}
// bootstrap band (same seed as the runtime)
const rnd = lcg(20261115);
const bootPred = board.map(() => []);
for (let b = 0; b < 200; b++) {
  const sample = Array.from({ length: priced.length }, () => priced[Math.floor(rnd() * priced.length)]);
  const f = fit(sample);
  board.forEach((p, i) => bootPred[i].push(Math.max(1, f.a * p.tvl_usd ** f.b)));
}
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const covers = board
  .map((p, i) => {
    const impliedLow = Math.max(1, Math.round(pct(bootPred[i], 0.05)));
    const cap = capital(p);
    const h = holdDays(p);
    const chain = p.chains[0] ?? 'other';
    const perTx = GAS[chain] ?? 1;
    const gas = Math.round((2 + Math.ceil(h / 7) + 2) * perTx * 100) / 100;
    return { slug: p.slug, coverLow: impliedLow / (cap + gas), impliedLow, allIn: cap + gas };
  })
  .sort((x, y) => x.coverLow - y.coverLow);
const q = (f) => covers[Math.floor(covers.length * f)].coverLow;
console.log(`low-end cover min=${Math.round(covers[0].coverLow)} p25=${Math.round(q(0.25))} median=${Math.round(q(0.5))} p75=${Math.round(q(0.75))} max=${Math.round(covers[covers.length - 1].coverLow)}`);
console.log('verdict thresholds: FARM cover_low>=100000, THIN 50000..100000, SKIP <50000');
const split = { FARM: 0, THIN: 0, SKIP: 0 };
for (const c of covers) split[c.coverLow >= 100000 ? 'FARM' : c.coverLow >= 50000 ? 'THIN' : 'SKIP']++;
console.log(`verdict split: FARM=${split.FARM} THIN=${split.THIN} SKIP=${split.SKIP}`);
