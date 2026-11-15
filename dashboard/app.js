// app.js — Token Launch Radar dashboard, v2. No network: every number comes
// from window.RADAR (data.js, written by main.ts from the snapshot). State lives
// in the URL hash, so each view has a shareable link and screenshots can target
// a view directly: #detail=<slug> opens a protocol, #verdict=FARM filters.
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
  const pct = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
  const age = (d) => (d === null || d === undefined ? '—' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd');
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length / 2;
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[Math.floor(m)];
  };

  // ------------------------------------------------------------ state + hash
  const state = { tab: 'board', q: '', cat: '', chain: '', verdict: '', sort: 'implied', detail: null };
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    state.tab = h.get('tab') === 'live' ? 'live' : 'board';
    state.q = h.get('q') || '';
    state.cat = h.get('cat') || '';
    state.chain = h.get('chain') || '';
    state.verdict = ['FARM', 'THIN', 'SKIP'].includes(h.get('verdict')) ? h.get('verdict') : '';
    state.sort = h.get('sort') || 'implied';
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
    if (state.detail) h.set('detail', state.detail);
    const s = h.toString();
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }

  // ------------------------------------------------------------------- stats
  const bySlug = new Map(R.board.map((r) => [r.slug, r]));
  // Board medians for the drawer's timing note (growth and age vs the board).
  const MED_GROWTH = med(R.board.map((r) => r.change_7d).filter((v) => v !== null));
  const MED_AGE = med(R.board.map((r) => r.age_days).filter((v) => v !== null));
  const MED_BE = med(R.board.map((r) => r.break_even_pct));
  function fillStats() {
    const v = { FARM: 0, THIN: 0, SKIP: 0 };
    R.board.forEach((r) => v[r.verdict]++);
    $('stats').innerHTML = [
      ['Board', R.board.length + ' rows'],
      ['Watchlist', R.counts.watchlist + '/' + R.counts.watchlist],
      ['FARM', v.FARM + ' plans'],
      ['Live tokens', R.live.length],
      ['Curve', 'mcap = ' + R.curve.a.toFixed(0) + '·TVL^' + R.curve.b.toFixed(3)],
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
    $('m-flat').textContent = R.flat_loo_median.toFixed(2);
    $('m-nboot').textContent = R.validation.n_boot;
    $('m-slope-ci').textContent = R.validation.slope_lo.toFixed(3) + '–' + R.validation.slope_hi.toFixed(3);
    $('m-split').textContent = v.FARM + ' FARM / ' + v.THIN + ' THIN / ' + v.SKIP + ' SKIP';
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
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.category.toLowerCase().includes(q))) return false;
      return true;
    });
    const s = state.sort;
    rows = rows.slice().sort((a, b) =>
      s === 'low' ? b.implied_low_usd - a.implied_low_usd
      : s === 'tvl' ? b.tvl_usd - a.tvl_usd
      : s === 'change' ? (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9)
      : s === 'age' ? (a.age_days ?? 1e9) - (b.age_days ?? 1e9)
      : s === 'name' ? a.name.localeCompare(b.name)
      : b.implied_value_usd - a.implied_value_usd);
    return rows;
  }

  function renderBoard() {
    const rows = filteredBoard();
    $('board-count').textContent = rows.length + ' of ' + R.board.length + ' protocols — click a row for its farm plan.';
    $('board-body').innerHTML = rows.length ? rows.map((r) => {
      const chg = r.change_7d === null ? '<span class="flat">—</span>'
        : '<span class="' + (r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : 'flat') + '">' + pct(r.change_7d) + '</span>';
      return '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td>'
        + '<td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>'
        + '<td class="cat">' + esc(r.category) + '</td>'
        + '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>'
        + '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + chg + '</td>'
        + '<td class="num">' + age(r.age_days) + '</td>'
        + '<td class="num implied">' + money(r.implied_value_usd) + '<div class="low">low ' + money(r.implied_low_usd) + '</div></td>'
        + '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    }).join('') : '<tr><td class="empty" colspan="9">No protocol matches these filters.</td></tr>';
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
    $('drawer-body').innerHTML =
      '<h2>' + esc(r.name) + '</h2>'
      + '<p><span class="pill ' + r.verdict + '">' + r.verdict + '</span> &nbsp;<span class="slug">' + esc(r.slug) + '</span></p>'
      + '<dl class="meta">'
      + '<dt>Rank</dt><dd>#' + r.rank + ' of ' + R.board.length + '</dd>'
      + '<dt>Category</dt><dd>' + esc(r.category) + '</dd>'
      + '<dt>Chains</dt><dd>' + esc(r.chains.join(', ')) + '</dd>'
      + '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>'
      + '<dt>7d change</dt><dd>' + chg + '</dd>'
      + '<dt>Listed</dt><dd>' + esc(r.listed_at || '—') + ' (' + age(r.age_days) + ')</dd>'
      + '<dt>Implied value</dt><dd>' + moneyFull(r.implied_value_usd) + '</dd>'
      + '<dt>Value band</dt><dd>' + moneyFull(r.implied_low_usd) + ' – ' + moneyFull(r.implied_high_usd) + '</dd>'
      + '<dt>All-in cost</dt><dd>' + moneyFull(r.all_in_cost_usd) + ' (gas ' + moneyFull(r.gas_usd) + ')</dd>'
      + '<dt>Cover (low / central)</dt><dd>' + Math.round(r.cover_low).toLocaleString('en-US') + '× / ' + Math.round(r.cover_ratio).toLocaleString('en-US') + '×</dd>'
      + '<dt>Break-even</dt><dd>' + r.break_even_pct.toFixed(4) + '% of supply</dd>'
      + '</dl>'
      + '<h3>Why this value</h3>'
      + '<p>Curve mcap = ' + r.model.curve_a.toFixed(0) + ' · TVL^' + r.model.curve_b.toFixed(3)
      + ', fitted on ' + R.curve.n + ' priced protocols (leave-one-out median |log error| '
      + r.model.loo_median.toFixed(2) + '; blind time-split 70/30 median '
      + R.validation.time_split_70.median.toFixed(2) + '). ' + moneyFull(r.tvl_usd) + ' of TVL maps to '
      + moneyFull(r.implied_value_usd) + ' of implied launch value, with a bootstrap band of '
      + moneyFull(r.implied_low_usd) + ' to ' + moneyFull(r.implied_high_usd) + ' (' + R.validation.n_boot + ' refits).</p>'
      + '<h3>Timing</h3>'
      + '<p>' + esc(timingCap) + '</p>'
      + '<h3>Farm plan</h3>'
      + '<ol class="steps">' + r.farm_steps.map((s, i) =>
          '<li' + (i === r.farm_steps.length - 1 ? ' class="verdict"' : '') + '>' + esc(s) + '</li>').join('') + '</ol>';
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
  render();
})();
