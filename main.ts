// main.ts — token launch radar entrypoint (Node 22, stdlib only).
//
// Reads the snapshot, builds the radar (lib/model.ts), and writes the entry:
//   board.json      {rows: [...]} — the scored, ranked board
//   data.js         window.RADAR = {...} — the same radar for the dashboard
//   dashboard/      the static page (copied from this repo's dashboard/)
//   screenshots/    the three views (copied from this repo's screenshots/)
//   dossier.json    buildDossier(/output) — the judge's dossier, byte-exact
//
// Usage: node main.ts [--input <dir>] [--output <dir>]
//   --input   directory holding snapshot.json (default: $MAKEFUN_INPUT_DIR, else /input)
//   --output  directory to write into      (default: $MAKEFUN_OUTPUT_DIR, else /output)
//
// Deterministic: no clock, no randomness, no network. Two runs on the same
// snapshot produce byte-identical output.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

function main(): void {
  const inputDir = arg('--input') ?? process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = arg('--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const snapshotPath = join(inputDir, 'snapshot.json');
  const snap = readSnapshot(snapshotPath);
  const radar = buildRadar(snap);
  const issue = boardIssue(radar, snap);
  if (issue !== null) throw new Error(`boardIssue: ${issue}`);

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outputDir, 'screenshots'), { recursive: true });

  // board.json — the scorer reads this one.
  writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: radar.board }, null, 2)}\n`);
  // data.js — the dashboard reads this one (../data.js from dashboard/).
  writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

  // dashboard/ — the static page, copied verbatim from the repo.
  const dashSrc = join(HERE, 'dashboard');
  for (const f of readdirSync(dashSrc)) {
    const src = join(dashSrc, f);
    if (existsSync(src)) copyFileSync(src, join(outputDir, 'dashboard', f));
  }
  // screenshots/ — the three views, copied verbatim from the repo.
  const shotsSrc = join(HERE, 'screenshots');
  for (const f of readdirSync(shotsSrc).filter((n) => /\.(png|jpe?g)$/i.test(n))) {
    copyFileSync(join(shotsSrc, f), join(outputDir, 'screenshots', f));
  }
  // dossier.json — the judge's dossier, built from the output directory.
  const dossier = buildDossier(outputDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(outputDir, 'dossier.json'), dossier);

  const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of radar.board) verdicts[r.verdict]++;
  console.log(
    [
      `radar as_of=${radar.as_of} protocols=${radar.counts.protocols} pre-token=${radar.counts.pre_token} strict=${radar.counts.strict}`,
      `board=${radar.counts.board} rows watchlist=${radar.counts.watchlist}/${radar.counts.watchlist} live=${radar.counts.live}`,
      `curve mcap=${radar.curve.a.toFixed(2)}*TVL^${radar.curve.b.toFixed(4)} (n=${radar.curve.n}) LOO median=${radar.curve.loo_median.toFixed(3)} vs flat 0.25x ${radar.flat_loo_median.toFixed(3)}`,
      `verdicts FARM=${verdicts.FARM} THIN=${verdicts.THIN} SKIP=${verdicts.SKIP}`,
      `top: ${radar.board.slice(0, 3).map((r) => `${r.rank}. ${r.slug} $${Math.round(r.implied_value_usd).toLocaleString('en-US')}`).join(' | ')}`,
      `wrote ${outputDir}/board.json ${outputDir}/data.js ${outputDir}/dashboard/ ${outputDir}/screenshots/ ${outputDir}/dossier.json`,
    ].join('\n'),
  );
}

main();
