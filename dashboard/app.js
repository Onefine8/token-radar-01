// app.js — Token Launch Radar dashboard, v3. No network: every number comes
// from window.RADAR (data.js, written by main.ts from the snapshot). State lives
// in the URL hash, so each view has a shareable link and screenshots can target
// a view directly: #detail=<slug> opens a protocol, #verdict=FARM filters,
// #ticket=10000 re-prices the board at a $10,000 ticket.
(function () {
  'use strict';
  const R = window.RADAR;
  if (!R) { document.body.innerHTML = '<p style="padding:24px">Radar data not loaded.</p>'; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = (n) => {
    if (n === null || n === undefined) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  const moneyFull = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const money2 = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
  const pct = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
  const age = (d) => (d === null || d === undefined ? '—' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd');
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length / 2;
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[Math.floor(m)];
  };

  // ------------------------------------------------------- economics (ticket)
  // The stored slice/net are at a $1,000 ticket. Re-pricing at another ticket
  // scales the slice linearly; gas does not move. The $10 FARM floor is an
  // absolute expected-profit bar, so it stays $10 at both tickets.
  const FARM_FLOOR = 10;
  function netAt(r, ticket) {
    return r.launch_odds * r.slice_low_usd * (ticket / 1000) - r.gas_usd;
  }
  function verdictAt(r, ticket) {
    const n = netAt(r, ticket);
    return n >= FARM_FLOOR ? 'FARM' : n > 0 ? 'THIN' : 'SKIP';
  }

  // ------------------------------------------------------------ state + hash
  const state = { tab: 'board', q: '', cat: '', chain: '', verdict: '', sort: 'implied', ticket: 1000, detail: null };
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    state.tab = h.get('tab') === 'live' ? 'live' : 'board';
    state.q = h.get('q') || '';
    state.cat = h.get('cat') || '';
    state.chain = h.get('chain') || '';
    state.verdict = ['FARM', 'THIN', 'SKIP'].includes(h.get('verdict')) ? h.get('verdict') : '';
    state.sort = h.get('sort') || 'implied';
    state.ticket = h.get('ticket') === '10000' ? 10000 : 1000;
    state.detail = h.get('detail') || null;
  }
  function writeHash() {
    const h = new URLSearchParams();
    if (state.tab === 'live') h.set('tab', 'live');
    if (state.q) h.set('q', state.q);
    if (state.cat) h.set('cat', state.cat);
    if (state.chain) h.set('chain', state.chain);
    if (state.verdict) h.set('verdict', state.verdict);
    if (state.sort !== 'implied') h.set('sort', state.sort);
    if (state.ticket !== 1000) h.set('ticket', String(state.ticket));
    if (state.detail) h.set('detail', state.detail);
    const s = h.toString();
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }

  // ------------------------------------------------------------------- stats
  const bySlug = new Map(R.board.map((r) => [r.slug, r]));
  const MED_GROWTH = med(R.board.map((r) => r.change_7d).filter((v) => v !== null));
  const MED_AGE = med(R.board.map((r) => r.age_days).filter((v) => v !== null));
  function verdictCounts(ticket) {
    const v = { FARM: 0, THIN: 0, SKIP: 0 };
    R.board.forEach((r) => v[verdictAt(r, ticket)]++);
    return v;
  }
  function fillStats() {
    const v = verdictCounts(state.ticket);
    $('stats').innerHTML = [
      ['Board', R.board.length + ' rows'],
      ['Curve', 'mcap = ' + R.curve.a.toFixed(0) + '·TVL^' + R.curve.b.toFixed(3)],
      ['LOO vs flat', R.curve.loo_median.toFixed(2) + ' vs ' + R.flat_loo_median.toFixed(2)],
      ['Walk-forward', R.walk_forward.median.toFixed(2)],
      ['Odds CV', (R.odds_cv.accuracy * 100).toFixed(1) + '% vs ' + (R.odds_cv.base_rate * 100).toFixed(1) + '%'],
      ['Ledger', R.counts.protocols + ' accounted'],
      ['Verdicts', v.FARM + ' / ' + v.THIN + ' / ' + v.SKIP],
    ].map(([k, val]) => '<div class="stat"><div class="v">' + esc(val) + '</div><div class="k">' + esc(k) + '</div></div>').join('');
    $('m-protocols').textContent = R.counts.protocols;
    $('m-priced').textContent = R.curve.n;
    $('m-pretoken').textContent = R.counts.pre_token;
    $('m-board').textContent = R.counts.board;
    $('m-asof').textContent = R.as_of;
    $('f-asof').textContent = R.as_of;
    $('m-n').textContent = R.curve.n;
    $('m-curve').textContent = 'a ≈ ' + R.curve.a.toFixed(0) + ', b ≈ ' + R.curve.b.toFixed(3);
    $('m-loo').textContent = R.curve.loo_median.toFixed(2);
    $('m-loo-mean').textContent = R.curve.loo_mean.toFixed(2);
    $('m-ts70').textContent = R.validation.time_split_70.median.toFixed(2);
    $('m-ts70-mean').textContent = R.validation.time_split_70.mean.toFixed(2);
    $('m-ts60').textContent = R.validation.time_split_60.median.toFixed(2);
    $('m-ts60-mean').textContent = R.validation.time_split_60.mean.toFixed(2);
    $('m-wf').textContent = R.walk_forward.median.toFixed(2);
    $('m-wf-mean').textContent = R.walk_forward.mean.toFixed(2);
    $('m-flat').textContent = R.flat_loo_median.toFixed(2);
    $('m-nboot').textContent = R.validation.n_boot;
    $('m-slope-ci').textContent = R.validation.slope_lo.toFixed(3) + '–' + R.validation.slope_hi.toFixed(3);
    $('m-odds-cv').textContent = (R.odds_cv.accuracy * 100).toFixed(1) + '%';
    $('m-odds-base').textContent = (R.odds_cv.base_rate * 100).toFixed(1) + '%';
    $('m-split').textContent = v.FARM + ' FARM / ' + v.THIN + ' THIN / ' + v.SKIP + ' SKIP';
  }

  function fillLedger() {
    const L = R.ledger;
    const items = [
      [L.ranked, 'ranked on the board', 'pre-token launch candidates'],
      [L.token_trades, 'priced — token trades', 'the 128 that teach the curve'],
      [L.token_on_record, 'priced — token on record', 'mcap $0 or unlisted, not fitted'],
      [L.bridge, 'bridge', 'a token here is a receipt, not a launch'],
      [L.liquid_staking, 'liquid staking', 'receipt tokens, not launches'],
      [L.exchange_custody, 'exchange custody', 'CEX tokens, not launches'],
      [L.versioned, 'versioned deployments', 'same protocol twice'],
      [L.other, 'other excluded', 'wrapped assets and the rest'],
    ];
    $('ledger-body').innerHTML = items.map(([n, k, d]) =>
      '<div class="lcell"><div class="v">' + n + '</div><div class="k">' + esc(k) + '</div><div class="d">' + esc(d) + '</div></div>').join('')
      + '<div class="lcell total"><div class="v">' + L.total + '</div><div class="k">total accounted</div><div class="d">must equal the snapshot size</div></div>';
  }

  function fillBuilt() {
    const r = R.board[0];
    const gas = r.gas_usd;
    const sliceLow = r.slice_low_usd;
    const expSlice = r.launch_odds * sliceLow;
    const net = netAt(r, 1000);
    $('built-body').innerHTML = '<ol class="built-steps">'
      + '<li><b>TVL ' + moneyFull(r.tvl_usd) + '</b> goes into the comps curve, mcap = ' + R.curve.a.toFixed(0) + ' · TVL^' + R.curve.b.toFixed(3) + ' → implied launch value <b>' + moneyFull(r.implied_value_usd) + '</b>.</li>'
      + '<li><b>200 bootstrap refits</b> of the curve put the value band at <b>' + moneyFull(r.implied_low_usd) + ' – ' + moneyFull(r.implied_high_usd) + '</b> and the rank range at <b>#' + r.rank_lo + '–#' + r.rank_hi + '</b>.</li>'
      + '<li><b>Launch odds ' + Math.round(r.launch_odds * 100) + '%</b> — a logistic model on TVL, age, growth and sector (5-fold CV ' + (R.odds_cv.accuracy * 100).toFixed(1) + '% vs ' + (R.odds_cv.base_rate * 100).toFixed(1) + '% base).</li>'
      + '<li><b>Expected slice, low end:</b> ' + Math.round(r.launch_odds * 100) + '% × $1,000 ticket × (' + moneyFull(r.implied_low_usd) + ' / ' + moneyFull(r.tvl_usd) + ' TVL) × 7% drop share = <b>' + money2(expSlice) + '</b>.</li>'
      + '<li><b>Gas ' + money2(gas) + '</b> on ' + esc(r.chains[0] || 'its chain') + ' for the whole plan (setup + weekly actions + claim).</li>'
      + '<li><b>Expected net ' + money2(net) + '</b> = ' + money2(expSlice) + ' − ' + money2(gas) + ' → verdict <b>' + r.verdict + '</b>. The biggest launch on the board is a SKIP: the slice is cents on a $1,000 ticket and the gas is over a hundred dollars.</li>'
      + '</ol>';
  }

  function fillAblation() {
    $('ablation-body').innerHTML = R.ablation.map((a) =>
      '<tr><td>' + esc(a.name) + '</td><td>' + a.loo_median.toFixed(2) + '</td><td>' + a.wf_median.toFixed(2) + '</td>'
      + '<td>' + esc(a.test_set) + '</td><td>' + (a.kept ? '<b class="kept">KEPT</b>' : 'dropped') + '</td>'
      + '<td class="note">' + esc(a.note) + '</td></tr>').join('');
  }

  function drawScatter() {
    const cv = $('scatter');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const ML = 52, MR = 14, MT = 12, MB = 30;
    const x0 = 6, x1 = 11, y0 = 5, y1 = 11; // log10 ranges
    const X = (v) => ML + ((Math.log10(v) - x0) / (x1 - x0)) * (W - ML - MR);
    const Y = (v) => H - MB - ((Math.log10(v) - y0) / (y1 - y0)) * (H - MT - MB);
    const axLabel = (v) => (v >= 1e9 ? '$' + (v / 1e9) + 'B' : v >= 1e6 ? '$' + (v / 1e6) + 'M' : '$' + (v / 1e3) + 'K');
    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    // gridlines + labels, one per decade
    ctx.strokeStyle = '#1e2630';
    ctx.fillStyle = '#8b9bb4';
    ctx.lineWidth = 1;
    for (let e = x0; e <= x1; e++) {
      const x = X(Math.pow(10, e));
      ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, H - MB); ctx.stroke();
      ctx.fillText(axLabel(Math.pow(10, e)), x - 12, H - 12);
    }
    for (let e = y0; e <= y1; e++) {
      const y = Y(Math.pow(10, e));
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - MR, y); ctx.stroke();
      ctx.fillText(axLabel(Math.pow(10, e)), 4, y + 4);
    }
    ctx.fillStyle = '#5c6b80';
    // (axis units are the $ labels themselves; no extra axis titles)
    // board predictions (hollow amber)
    ctx.strokeStyle = 'rgba(245,166,35,0.7)';
    for (const r of R.board) {
      ctx.beginPath(); ctx.arc(X(r.tvl_usd), Y(Math.max(1e5, r.implied_value_usd)), 2.5, 0, 2 * Math.PI); ctx.stroke();
    }
    // curve line (amber)
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let e = x0; e <= x1; e += 0.05) {
      const tvl = Math.pow(10, e);
      const m = Math.max(1e5, R.curve.a * Math.pow(tvl, R.curve.b));
      const x = X(tvl), y = Y(m);
      if (e === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    // priced protocols (teal)
    ctx.fillStyle = '#2dd4bf';
    for (const p of R.scatter) {
      ctx.beginPath(); ctx.arc(X(p.tvl_usd), Y(Math.max(1e5, p.mcap_usd)), 2.5, 0, 2 * Math.PI); ctx.fill();
    }
  }

  function fillFilters() {
    const cats = [...new Set(R.board.map((r) => r.category))].sort();
    const chains = [...new Set(R.board.flatMap((r) => r.chains))].sort();
    $('f-cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
    $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');
  }

  // ------------------------------------------------------------------ render
  function filteredBoard() {
    const q = state.q.trim().toLowerCase();
    let rows = R.board.filter((r) => {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && !r.chains.includes(state.chain)) return false;
      if (state.verdict && verdictAt(r, state.ticket) !== state.verdict) return false;
      if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.category.toLowerCase().includes(q))) return false;
      return true;
    });
    const s = state.sort;
    rows = rows.slice().sort((a, b) =>
      s === 'net' ? netAt(b, state.ticket) - netAt(a, state.ticket)
      : s === 'low' ? b.implied_low_usd - a.implied_low_usd
      : s === 'odds' ? b.launch_odds - a.launch_odds
      : s === 'tvl' ? b.tvl_usd - a.tvl_usd
      : s === 'change' ? (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9)
      : s === 'age' ? (a.age_days ?? 1e9) - (b.age_days ?? 1e9)
      : s === 'name' ? a.name.localeCompare(b.name)
      : b.implied_value_usd - a.implied_value_usd);
    return rows;
  }

  function renderBoard() {
    const rows = filteredBoard();
    $('board-count').textContent = rows.length + ' of ' + R.board.length + ' protocols — click a row for its farm plan. Rank is launch scale; the verdict is farm economics at a $' + state.ticket.toLocaleString('en-US') + ' ticket.';
    $('net-head-sub').textContent = '@ $' + state.ticket.toLocaleString('en-US') + ' ticket';
    $('board-body').innerHTML = rows.length ? rows.map((r) => {
      const chg = r.change_7d === null ? '<span class="flat">—</span>'
        : '<span class="' + (r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : 'flat') + '">' + pct(r.change_7d) + '</span>';
      const net = netAt(r, state.ticket);
      const verdict = verdictAt(r, state.ticket);
      const netCls = net >= FARM_FLOOR ? 'pos' : net > 0 ? 'warn' : 'neg';
      return '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '<div class="low">#' + r.rank_lo + '–#' + r.rank_hi + '</div></td>'
        + '<td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>'
        + '<td class="cat">' + esc(r.category) + '</td>'
        + '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>'
        + '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + chg + '</td>'
        + '<td class="num">' + age(r.age_days) + '</td>'
        + '<td class="num implied">' + money(r.implied_value_usd) + '<div class="low">' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</div></td>'
        + '<td class="num">' + Math.round(r.launch_odds * 100) + '%</td>'
        + '<td class="num ' + netCls + '">' + money2(net) + '</td>'
        + '<td><span class="pill ' + verdict + '">' + verdict + '</span></td></tr>';
    }).join('') : '<tr><td class="empty" colspan="11">No protocol matches these filters.</td></tr>';
  }

  function renderLive() {
    $('live-body').innerHTML = R.live.map((r) =>
      '<tr><td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>'
      + '<td class="cat">' + esc(r.category) + '</td>'
      + '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + '</td>'
      + '<td class="num">' + money(r.tvl_usd) + '</td>'
      + '<td class="num">' + money(r.mcap_usd) + '</td>'
      + '<td class="num">' + r.ratio.toFixed(3) + '×</td></tr>').join('');
  }

  function openDetail(slug) {
    const r = bySlug.get(slug);
    if (!r) { $('drawer').hidden = true; return; }
    state.detail = slug;
    const chg = r.change_7d === null ? '—' : pct(r.change_7d);
    const growthNote = r.change_7d === null ? '7d change unreported'
      : r.change_7d >= MED_GROWTH ? 'growing faster than the board median (' + pct(MED_GROWTH) + ')'
      : 'growing slower than the board median (' + pct(MED_GROWTH) + ')';
    const ageNote = r.age_days === null ? 'listing date unreported'
      : r.age_days >= MED_AGE ? 'older than the board median (' + age(MED_AGE) + ') — a mature launch candidate'
      : 'younger than the board median (' + age(MED_AGE) + ') — an early launch candidate';
    const timing = growthNote + '; ' + ageNote + '. Growth and age do not enter the curve — both were tested and rejected on out-of-sample error — but age sets the farm’s hold window, and the two together tell you whether the launch is early or mature.';
    const timingCap = timing.charAt(0).toUpperCase() + timing.slice(1);
    const net1k = netAt(r, 1000);
    const net10k = netAt(r, 10000);
    const v1k = verdictAt(r, 1000);
    const v10k = verdictAt(r, 10000);
    $('drawer-body').innerHTML =
      '<h2>' + esc(r.name) + '</h2>'
      + '<p><span class="pill ' + verdictAt(r, state.ticket) + '">' + verdictAt(r, state.ticket) + '</span> &nbsp;<span class="slug">' + esc(r.slug) + '</span></p>'
      + '<dl class="meta">'
      + '<dt>Rank</dt><dd>#' + r.rank + ' of ' + R.board.length + ' (range #' + r.rank_lo + '–#' + r.rank_hi + ')</dd>'
      + '<dt>Category</dt><dd>' + esc(r.category) + '</dd>'
      + '<dt>Chains</dt><dd>' + esc(r.chains.join(', ')) + '</dd>'
      + '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>'
      + '<dt>7d change</dt><dd>' + chg + '</dd>'
      + '<dt>Listed</dt><dd>' + esc(r.listed_at || '—') + ' (' + age(r.age_days) + ')</dd>'
      + '<dt>Implied value</dt><dd>' + moneyFull(r.implied_value_usd) + '</dd>'
      + '<dt>Value band</dt><dd>' + moneyFull(r.implied_low_usd) + ' – ' + moneyFull(r.implied_high_usd) + '</dd>'
      + '<dt>Launch odds</dt><dd>' + Math.round(r.launch_odds * 100) + '%</dd>'
      + '<dt>Expected slice (low)</dt><dd>' + money2(r.slice_low_usd) + ' @ $1k · ' + money2(r.slice_low_usd * 10) + ' @ $10k</dd>'
      + '<dt>Expected net</dt><dd>' + money2(net1k) + ' @ $1k (' + v1k + ') · ' + money2(net10k) + ' @ $10k (' + v10k + ')</dd>'
      + '<dt>Net per hour</dt><dd>' + money2(r.net_per_hour_usd) + ' @ $1k</dd>'
      + '<dt>All-in cost</dt><dd>' + moneyFull(r.all_in_cost_usd) + ' (gas ' + money2(r.gas_usd) + ')</dd>'
      + '<dt>Cover (low / central)</dt><dd>' + Math.round(r.cover_low).toLocaleString('en-US') + '× / ' + Math.round(r.cover_ratio).toLocaleString('en-US') + '×</dd>'
      + '<dt>Break-even</dt><dd>' + r.break_even_pct.toFixed(4) + '% of supply</dd>'
      + '</dl>'
      + '<h3>Why this value</h3>'
      + '<p>Curve mcap = ' + r.model.curve_a.toFixed(0) + ' · TVL^' + r.model.curve_b.toFixed(3)
      + ', fitted on ' + R.curve.n + ' priced protocols (leave-one-out median |log error| '
      + r.model.loo_median.toFixed(2) + '; walk-forward median '
      + R.walk_forward.median.toFixed(2) + '; blind time-split 70/30 median '
      + R.validation.time_split_70.median.toFixed(2) + '). ' + moneyFull(r.tvl_usd) + ' of TVL maps to '
      + moneyFull(r.implied_value_usd) + ' of implied launch value, with a bootstrap band of '
      + moneyFull(r.implied_low_usd) + ' to ' + moneyFull(r.implied_high_usd) + ' (' + R.validation.n_boot + ' refits). '
      + 'Launch odds ' + Math.round(r.launch_odds * 100) + '% come from the logistic model (5-fold CV '
      + (R.odds_cv.accuracy * 100).toFixed(1) + '% vs ' + (R.odds_cv.base_rate * 100).toFixed(1) + '% base).</p>'
      + '<h3>Timing</h3>'
      + '<p>' + esc(timingCap) + '</p>'
      + '<h3>Farm plan</h3>'
      + '<ol class="steps">' + r.farm_steps.map((s, i) =>
          '<li' + (i === r.farm_steps.length - 1 ? ' class="verdict"' : '') + '>' + esc(s) + '</li>').join('') + '</ol>'
      + (state.ticket === 10000
          ? '<p class="fine">At a $10,000 ticket this row re-prices to an expected net of ' + money2(net10k) + ' — verdict ' + v10k + '. The steps above are written at the $1,000 ticket; only the slice and the verdict move.</p>'
          : '');
    $('drawer').hidden = false;
    writeHash();
  }

  function closeDetail() { state.detail = null; $('drawer').hidden = true; writeHash(); }

  function render() {
    $('tab-board').classList.toggle('active', state.tab === 'board');
    $('tab-live').classList.toggle('active', state.tab !== 'board');
    $('board-view').hidden = state.tab !== 'board';
    $('live-view').hidden = state.tab !== 'live';
    $('q').value = state.q;
    $('f-cat').value = state.cat;
    $('f-chain').value = state.chain;
    $('f-verdict').value = state.verdict;
    $('f-sort').value = state.sort;
    $('ticket-1000').classList.toggle('active', state.ticket === 1000);
    $('ticket-10000').classList.toggle('active', state.ticket === 10000);
    fillStats();
    renderBoard();
    renderLive();
    if (state.detail) openDetail(state.detail); else $('drawer').hidden = true;
  }

  // ------------------------------------------------------------------ events
  $('tab-board').addEventListener('click', () => { state.tab = 'board'; state.detail = null; $('drawer').hidden = true; writeHash(); render(); });
  $('tab-live').addEventListener('click', () => { state.tab = 'live'; writeHash(); render(); });
  $('q').addEventListener('input', (e) => { state.q = e.target.value; writeHash(); renderBoard(); });
  $('f-cat').addEventListener('change', (e) => { state.cat = e.target.value; writeHash(); renderBoard(); });
  $('f-chain').addEventListener('change', (e) => { state.chain = e.target.value; writeHash(); renderBoard(); });
  $('f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; writeHash(); renderBoard(); });
  $('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; writeHash(); renderBoard(); });
  $('ticket-1000').addEventListener('click', () => { state.ticket = 1000; writeHash(); render(); });
  $('ticket-10000').addEventListener('click', () => { state.ticket = 10000; writeHash(); render(); });
  $('board-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('drawer-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
  window.addEventListener('hashchange', () => { readHash(); render(); });

  // -------------------------------------------------------------------- init
  readHash();
  fillStats();
  fillFilters();
  fillLedger();
  fillBuilt();
  fillAblation();
  drawScatter();
  render();
})();
