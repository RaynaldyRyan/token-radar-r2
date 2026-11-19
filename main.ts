// The token radar's entry (Node 22, standard library only).
//
// main.ts reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the two-stage model in lib/model.ts, writes the ranked board to
// /output/board.json, writes the dashboard's data as /output/dashboard/data.js, copies this
// repository's dashboard/ and screenshots/ to /output, and writes /output/dossier.json with the
// vendored make.fun library.
//
// data.js lives INSIDE dashboard/ on purpose: the dossier's text is the dashboard's source, so the
// judge reads the board's values as data, not as a claim. That means the dashboard's whole source
// (page, style, script and data) must fit the dossier's 65,536-byte text cap: this program refuses
// to finish when the dossier cuts anything.
//
// The page is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read dashboard/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, verifyBuild, FARM, RIDGE_LAMBDA } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (RULES.txt): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar, model, validation } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
const failures = verifyBuild(board, radar, snapshot);
if (failures.length > 0) {
  process.stderr.write(`token radar: the build-time verification failed:\n${failures.map((f) => `  - ${f}\n`).join('')}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
writeFileSync(join(out, 'dashboard', 'data.js'), dataScript(radar));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
  const bytes = readFileSync(join(out, 'screenshots', name));
  if (bytes.length > SCREENSHOT_CAPS.max_bytes) {
    process.stderr.write(`token radar: screenshots/${name} is ${bytes.length} bytes, over the ${SCREENSHOT_CAPS.max_bytes} cap\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

// The dossier must show the whole source: a cut source means the judge reads a partial page.
const dossier = JSON.parse(readFileSync(join(out, 'dossier.json'), 'utf8')) as { text: string };
const textBytes = Buffer.byteLength(dossier.text, 'utf8');
if (dossier.text.includes('[Cut at') || textBytes > TEXT_MAX_BYTES) {
  process.stderr.write(`token radar: the dossier's text is ${textBytes} bytes and cuts the source: shrink dashboard/ (data.js included) under the ${TEXT_MAX_BYTES}-byte text cap\n`);
  process.exit(1);
}

const dashBytes = readdirSync(join(out, 'dashboard')).reduce((n, f) => n + statSync(join(out, 'dashboard', f)).size, 0);
const farmCounts = { FARM: 0, THIN: 0, SKIP: 0 };
for (const r of board) farmCounts[r.farm.verdict]++;
const top5 = board
  .slice(0, 5)
  .map((r) => `  #${r.rank} ${r.name}: $${(r.implied_value_usd / 1e6).toFixed(2)}M (FDV $${(r.model.fdv_usd / 1e6).toFixed(1)}M x ${r.model.odds} share)`)
  .join('\n');
const oddsLine = radar.o.map(([n, s], i) => `${['<6mo', '6-12mo', '1-2y', '2-3y', '3y+'][i]} ${s} (n=${n})`).join(', ');
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored\n` +
    `${top5}\n` +
    `token radar: fit on ${model.nComps} traded comps: log10(FDV) = ${model.beta.map((b) => b.toFixed(3)).join(' ')} [${model.names.join(', ')}], lambda=${RIDGE_LAMBDA}\n` +
    `token radar: token share by age: ${oddsLine}; unknown age ${radar.ov}\n` +
    `token radar: validation: LOO miss x${validation.loo.toFixed(2)} (within 3x ${(validation.looWithin3x * 100).toFixed(0)}%) vs flat x${validation.looFlat.toFixed(2)}, power law x${validation.looPower.toFixed(2)}; date-ordered holdout x${validation.holdout.toFixed(2)} vs flat x${validation.holdoutFlat.toFixed(2)} (n=${validation.holdoutN})\n` +
    `token radar: bands: P25-P75 covers ${(validation.cover2575 * 100).toFixed(0)}%, P10-P90 covers ${(validation.cover1090 * 100).toFixed(0)}% of LOO residuals\n` +
    `token radar: farms at $${FARM.ticket} / ${Math.round(FARM.share * 100)}%: ${farmCounts.FARM} FARM, ${farmCounts.THIN} THIN, ${farmCounts.SKIP} SKIP\n` +
    `token radar: dashboard source ${dashBytes} bytes, dossier text ${textBytes} bytes (cap ${TEXT_MAX_BYTES}), dossier file ${statSync(join(out, 'dossier.json')).size} bytes\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'dashboard')} (${readdirSync(join(out, 'dashboard')).length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
