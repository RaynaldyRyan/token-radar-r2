// The token radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// Two stages, both fitted on the snapshot's own figures, never on a list of names:
//
//   Stage A (launch FDV): a ridge-shrunk log-log regression, log10(mcap) on log10(TVL) plus
//     relative 7d momentum, log10(age), log10(chain count) and sector dummies, fitted ONLY on
//     traded-token comps (gecko_id present, mcap_usd > 0, listed_at present, category not CEX).
//     The ridge penalty (lambda 10) falls on every coefficient except the intercept and the size
//     curve (log TVL); lambda was picked by leave-one-out over {0, 1, 3, 10, 30, 100}.
//   Stage B (token share by age): the empirical share of protocols that record a token, by age
//     bucket, computed from the snapshot's own cross-section. Implied value = token share x E[FDV].
//     The share is a descriptive base rate, not a forward launch probability: the snapshot carries
//     no token-launch dates, so no hazard rate can be fitted from it.
//
// Age is days from listed_at to the SNAPSHOT's as_of date (2026-11-14), never the clock: two runs
// write the same bytes. A protocol records no token when gecko_id, symbol and mcap_usd are all null;
// the board ranks every rankable no-token protocol and accounts for all 758 in a ledger.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** Ridge penalty, picked by leave-one-out over {0, 1, 3, 10, 30, 100}. */
export const RIDGE_LAMBDA = 10;
/** A category needs this many comps to earn its own dummy; sparser ones pool into the baseline. */
export const SECTOR_MIN_COMPS = 8;
/** Bootstrap refits for the rank ranges. */
export const BOOTSTRAP_REFITS = 200;
/** Seed for the bootstrap resampler (mulberry32): fixed, so two runs agree. */
export const BOOTSTRAP_SEED = 0x5eed;
/** Age buckets for the token-share table, in days. */
export const ODDS_BUCKETS: Array<[number, number, string]> = [
  [0, 180, '<6mo'],
  [180, 365, '6-12mo'],
  [365, 730, '1-2y'],
  [730, 1095, '2-3y'],
  [1095, 1_000_000, '3y+'],
];

/** Farm-economics assumptions (labelled as assumptions on the dashboard, never snapshot facts). */
export const FARM = {
  /** Share of a protocol's TVL assumed actively farmed (the farm pool). */
  pool_share: 0.2,
  /** Default farmer share of the launch FDV. */
  share: 0.1,
  /** Default ticket per protocol, dollars. */
  ticket: 1000,
  /** Active farming time valued at this $/h. */
  usd_per_hour: 75,
  /** Default hurdle: FARM needs net >= this share of the ticket. */
  hurdle: 0.05,
};

/** Assumed gas for a full farm (4 transactions), by first chain; anything else uses `default`. */
export const CHAIN_FEES: Record<string, number> = {
  Ethereum: 18,
  Bittensor: 12,
  Bitcoin: 10,
  Tron: 6,
  Solana: 1.4,
  Binance: 1.6,
  Arbitrum: 2.4,
  Base: 2.4,
  Optimism: 2.4,
  Polygon: 2,
  Avalanche: 3.2,
  default: 5,
};

/** A farm action: its id, its active hours, and the category words that select it. */
export const FARM_ACTIONS: Array<{ id: string; label: string; hours: number; match: string[] }> = [
  { id: 'lend', label: 'Lend / supply', hours: 2, match: ['lend', 'cdp', 'collateral'] },
  { id: 'lp', label: 'Provide liquidity', hours: 2.5, match: ['dex', 'yield', 'leveraged farm'] },
  { id: 'stake', label: 'Stake', hours: 1.5, match: ['staking', 'restak'] },
  { id: 'trade', label: 'Trade / margin', hours: 3, match: ['perpetual', 'derivative'] },
  { id: 'predict', label: 'Predict', hours: 2, match: ['prediction'] },
  { id: 'vault', label: 'Vault deposit', hours: 1.5, match: ['curator', 'allocator'] },
  { id: 'mint', label: 'Mint / hold', hours: 1.5, match: ['stable', 'rwa'] },
  { id: 'cover', label: 'Buy cover', hours: 1.5, match: ['insurance'] },
  { id: 'deposit', label: 'Deposit', hours: 2, match: [] },
];

/** A whole day count from `listedAt` to the snapshot's `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol's record carries a token (a CoinGecko id, a symbol, or a market cap). */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

/** Whether a protocol's token trades: a CoinGecko id and a positive market cap. */
export function tokenTrades(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking, any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Exchange names whose prefix marks custody, per the house's watchlist rule. */
const EXCHANGE_PREFIX = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/** A protocol's name stem: its first word, lowercased, version marker stripped. */
export function nameStem(name: string): string {
  const m = /^[a-z0-9]+/.exec(name.toLowerCase().replace(VERSIONED, '').trim());
  return m === null ? '' : m[0];
}

/** The ledger's mutually exclusive statuses, in priority order (first match wins). */
export type LedgerStatus =
  | 'ranked'
  | 'trades'
  | 'on-record'
  | 'bridge'
  | 'liquid-staking'
  | 'exchange-custody'
  | 'versioned'
  | 'wrapped-or-staked'
  | 'kin-of-token'
  | 'unclear';

/** The ledger's display rows: status, label, and the rule that puts a protocol there. */
export const LEDGER_RULES: Array<{ status: LedgerStatus; label: string; rule: string }> = [
  { status: 'ranked', label: 'Ranked', rule: 'records no token; no rule sets it aside' },
  { status: 'trades', label: 'Token trades', rule: 'a market cap: comparables, never ranked' },
  { status: 'on-record', label: 'Token on record', rule: 'a ticker or CoinGecko id, no market cap' },
  { status: 'bridge', label: 'Bridge', rule: 'category Bridge or Canonical Bridge' },
  { status: 'liquid-staking', label: 'Liquid staking', rule: 'category Liquid Staking, Liquid Restaking or Restaked BTC' },
  { status: 'exchange-custody', label: 'Exchange custody', rule: 'category CEX, or an exchange name first' },
  { status: 'versioned', label: 'Versioned listing', rule: 'name ends in a version marker' },
  { status: 'wrapped-or-staked', label: 'Wrapped or staked', rule: 'name carries wrapped, staked or staking' },
  { status: 'kin-of-token', label: 'Kin of a token', rule: 'its name stem carries a token on record' },
  { status: 'unclear', label: 'Unclear', rule: 'no stated rule classifies it (none here)' },
];

/**
 * One protocol's ledger status. The token stems come from the snapshot itself (every protocol that
 * records a token contributes its stem), so kinship is a deterministic snapshot rule, never a list.
 * Watchlist slugs are never set aside as kin: the watchlist is the floor.
 */
export function ledgerStatus(p: SnapshotProtocol, tokenStems: Set<string>, watchlist: Set<string>): LedgerStatus {
  if (tokenTrades(p)) return 'trades';
  if (hasToken(p)) return 'on-record';
  if (p.category === 'CEX') return 'exchange-custody';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'liquid-staking';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped-or-staked';
  if (EXCHANGE_PREFIX.some((e) => p.name.toLowerCase().startsWith(e))) return 'exchange-custody';
  const stem = nameStem(p.name);
  if (stem.length >= 3 && tokenStems.has(stem) && !watchlist.has(p.slug)) return 'kin-of-token';
  return 'ranked';
}

/** Whether a protocol is one the board may rank: no token, and no set-aside rule applies. */
export function isRankable(p: SnapshotProtocol, tokenStems: Set<string>, watchlist: Set<string>): boolean {
  return ledgerStatus(p, tokenStems, watchlist) === 'ranked';
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export { bySlug };

// ---------------------------------------------------------------- the fit

/** A fitted Stage A model: coefficients, the feature spec, and the winsorization it used. */
export interface FittedModel {
  beta: number[];
  sectors: string[];
  winsorLo: number;
  winsorHi: number;
  medianChange7d: number;
  medianAge: number;
  nComps: number;
  /** Feature names in beta order, for the dashboard's equation. */
  names: string[];
}

/** A quantile of sorted values, linear interpolation. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Solve a small dense linear system by Gauss-Jordan with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-12) throw new Error('singular system in OLS');
    const tmp = m[c]!;
    m[c] = m[piv]!;
    m[piv] = tmp;
    for (let r = 0; r < n; r++) {
      if (r === c || m[r]![c] === 0) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Ridge OLS: (X'X + lambda*diag(pen)) beta = X'y. `pen[i]` says whether beta[i] is shrunk. */
function ridgeOls(x: number[][], y: number[], lambda: number, pen: boolean[]): number[] {
  const p = x[0]!.length;
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty: number[] = new Array<number>(p).fill(0);
  for (let k = 0; k < x.length; k++) {
    for (let i = 0; i < p; i++) {
      xty[i]! += x[k]![i]! * y[k]!;
      for (let j = 0; j < p; j++) xtx[i]![j]! += x[k]![i]! * x[k]![j]!;
    }
  }
  for (let i = 0; i < p; i++) if (pen[i]) xtx[i]![i]! += lambda;
  return solveLinear(xtx, xty);
}

/** Which feature groups a fit keeps (ablation drops one at a time). */
export interface FeatureSpec {
  momentum: boolean;
  age: boolean;
  chains: boolean;
  sector: boolean;
}

const FULL_SPEC: FeatureSpec = { momentum: true, age: true, chains: true, sector: true };

/** One protocol's feature row under a fitted model's spec. */
function featureRow(p: SnapshotProtocol, asOf: string, spec: FeatureSpec, sectors: string[], winsorLo: number, winsorHi: number, medianChange7d: number, medianAge: number): number[] {
  const rawChange = p.change_7d === null ? medianChange7d : p.change_7d;
  const winsorized = Math.min(Math.max(rawChange, winsorLo), winsorHi);
  const relMomentum = (winsorized - medianChange7d) / 100;
  const age = ageDays(asOf, p.listed_at);
  const logAge = Math.log10(age === null || age <= 0 ? medianAge : age);
  const row: number[] = [1, Math.log10(Math.max(p.tvl_usd, 1))];
  if (spec.momentum) row.push(relMomentum);
  if (spec.age) row.push(logAge);
  if (spec.chains) row.push(Math.log10(Math.max(p.chains.length, 1)));
  if (spec.sector) for (const s of sectors) row.push(p.category === s ? 1 : 0);
  return row;
}

/** Feature names in row order, for the dashboard's equation. */
function featureNames(spec: FeatureSpec, sectors: string[]): string[] {
  const names = ['const', 'logTVL'];
  if (spec.momentum) names.push('mom7d');
  if (spec.age) names.push('logAge');
  if (spec.chains) names.push('logChains');
  if (spec.sector) for (const s of sectors) names.push(`sec:${s}`);
  return names;
}

/**
 * Fit Stage A on a comp list. The whole pipeline runs here: winsor bounds, median change, median age
 * and the sector set are all recomputed from the comps given, so a leave-one-out refit leaks nothing.
 */
export function fitModel(comps: SnapshotProtocol[], asOf: string, spec: FeatureSpec = FULL_SPEC, lambda: number = RIDGE_LAMBDA): FittedModel {
  const changes = comps.map((p) => p.change_7d).filter((g): g is number => g !== null).sort((a, b) => a - b);
  const winsorLo = quantile(changes, 0.05);
  const winsorHi = quantile(changes, 0.95);
  const medianChange7d = quantile(changes, 0.5);
  const ages = comps.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null).sort((a, b) => a - b);
  const medianAge = ages.length > 0 ? ages[Math.floor(ages.length / 2)]! : 365;
  const counts = new Map<string, number>();
  for (const p of comps) if (p.category !== null) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const sectors = spec.sector ? [...counts.entries()].filter(([, n]) => n >= SECTOR_MIN_COMPS).map(([c]) => c).sort() : [];
  const x = comps.map((p) => featureRow(p, asOf, spec, sectors, winsorLo, winsorHi, medianChange7d, medianAge));
  const y = comps.map((p) => Math.log10(Math.max(p.mcap_usd ?? 1, 1)));
  // The ridge shrinks every coefficient except the intercept and the size curve (log TVL).
  const pen = x[0]!.map((_, i) => i >= 2);
  const beta = ridgeOls(x, y, lambda, pen);
  return { beta, sectors, winsorLo, winsorHi, medianChange7d, medianAge, nComps: comps.length, names: featureNames(spec, sectors) };
}

/** A fitted model's launch-FDV prediction for one protocol. */
export function predictFdv(model: FittedModel, p: SnapshotProtocol, asOf: string, spec: FeatureSpec = FULL_SPEC): number {
  const row = featureRow(p, asOf, spec, model.sectors, model.winsorLo, model.winsorHi, model.medianChange7d, model.medianAge);
  let log = 0;
  for (let i = 0; i < row.length; i++) log += model.beta[i]! * row[i]!;
  return Math.pow(10, log);
}

/** The traded-token comps: gecko id, positive mcap, a listing date, not a CEX token. */
export function compSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.listed_at !== null && p.category !== 'CEX',
  );
}

// ---------------------------------------------------------------- token share

/** One share bucket: its label, its protocol count, and the share that record a token. */
export interface OddsBucket {
  label: string;
  n: number;
  share: number;
}

/** The token-share table, from the snapshot's own cross-section, plus the overall token share. */
export function oddsTable(snapshot: Snapshot): { buckets: OddsBucket[]; overall: number } {
  const buckets: OddsBucket[] = ODDS_BUCKETS.map(([lo, hi, label]) => {
    const group = snapshot.protocols.filter((p) => {
      const a = ageDays(snapshot.as_of, p.listed_at);
      return a !== null && a >= lo && a < hi;
    });
    const withToken = group.filter(hasToken).length;
    return { label, n: group.length, share: group.length > 0 ? withToken / group.length : 0.5 };
  });
  const overall = snapshot.protocols.filter(hasToken).length / snapshot.protocols.length;
  return { buckets, overall };
}

/** A protocol's token share: its age bucket's share, or the overall share when its age is unknown. */
export function oddsFor(p: SnapshotProtocol, asOf: string, table: { buckets: OddsBucket[]; overall: number }): { odds: number; bucket: number } {
  const a = ageDays(asOf, p.listed_at);
  if (a === null) return { odds: table.overall, bucket: -1 };
  for (let i = 0; i < ODDS_BUCKETS.length; i++) {
    if (a >= ODDS_BUCKETS[i]![0] && a < ODDS_BUCKETS[i]![1]) return { odds: table.buckets[i]!.share, bucket: i };
  }
  return { odds: table.buckets[table.buckets.length - 1]!.share, bucket: table.buckets.length - 1 };
}

// ---------------------------------------------------------------- validation

/** Validation metrics, all as multiplicative misses (10^median|log error|). */
export interface Validation {
  loo: number;
  looWithin2x: number;
  looWithin3x: number;
  looFlat: number;
  looFlatWithin3x: number;
  looPower: number;
  looPowerWithin3x: number;
  holdout: number;
  holdoutWithin3x: number;
  holdoutFlat: number;
  holdoutN: number;
  q10: number;
  q25: number;
  q75: number;
  q90: number;
  cover2575: number;
  cover1090: number;
  ablation: Array<{ drop: string; loo: number }>;
}

/** Median of numbers. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/** Leave-one-out errors (absolute log10 errors) for the model and both baselines. */
function looErrors(comps: SnapshotProtocol[], asOf: string, spec: FeatureSpec = FULL_SPEC): { model: number[]; flat: number[]; power: number[] } {
  const model: number[] = [];
  const flat: number[] = [];
  const power: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i]!;
    const rest = comps.filter((_, j) => j !== i);
    const actual = Math.log10(held.mcap_usd!);
    const m = fitModel(rest, asOf, spec);
    model.push(Math.abs(actual - Math.log10(predictFdv(m, held, asOf, spec))));
    const mult = median(rest.map((p) => p.mcap_usd! / p.tvl_usd));
    flat.push(Math.abs(actual - Math.log10(mult * held.tvl_usd)));
    const xs = rest.map((p) => [1, Math.log10(p.tvl_usd)]);
    const ys = rest.map((p) => Math.log10(p.mcap_usd!));
    const b = ridgeOls(xs, ys, 0, [false, false]);
    power.push(Math.abs(actual - (b[0]! + b[1]! * Math.log10(held.tvl_usd))));
  }
  return { model, flat, power };
}

/** Signed leave-one-out residuals (log10 actual minus log10 predicted), for the bands. */
function looResiduals(comps: SnapshotProtocol[], asOf: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i]!;
    const rest = comps.filter((_, j) => j !== i);
    const m = fitModel(rest, asOf);
    out.push(Math.log10(held.mcap_usd!) - Math.log10(predictFdv(m, held, asOf)));
  }
  return out;
}

/**
 * The full validation: leave-one-out (model + flat median multiple + TVL-only power law, each refit
 * rerunning the whole pipeline), a date-ordered holdout (fit on the older-listed half, test on the
 * newer), band coverage from the out-of-fold residuals, and an ablation table. The holdout is called
 * exactly that: a single sealed snapshot has no historical outcomes, so no walk-forward is claimed.
 */
export function validate(comps: SnapshotProtocol[], asOf: string): Validation {
  const errs = looErrors(comps, asOf);
  const within = (es: number[], k: number): number => es.filter((e) => Math.pow(10, e) <= k).length / es.length;
  const dated = [...comps].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const cut = Math.floor(dated.length / 2);
  const fitSet = dated.slice(0, cut);
  const testSet = dated.slice(cut);
  const hm = fitModel(fitSet, asOf);
  const holdoutErrs = testSet.map((p) => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(predictFdv(hm, p, asOf))));
  const flatMult = median(fitSet.map((p) => p.mcap_usd! / p.tvl_usd));
  const holdoutFlatErrs = testSet.map((p) => Math.abs(Math.log10(p.mcap_usd!) - Math.log10(flatMult * p.tvl_usd)));
  const residuals = looResiduals(comps, asOf);
  const sorted = [...residuals].sort((a, b) => a - b);
  const q10 = quantile(sorted, 0.1);
  const q25 = quantile(sorted, 0.25);
  const q75 = quantile(sorted, 0.75);
  const q90 = quantile(sorted, 0.9);
  const ablation: Array<{ drop: string; loo: number }> = [];
  const drops: Array<[string, FeatureSpec]> = [
    ['Sector', { momentum: true, age: true, chains: true, sector: false }],
    ['7d momentum', { momentum: false, age: true, chains: true, sector: true }],
    ['Age', { momentum: true, age: false, chains: true, sector: true }],
    ['Chain count', { momentum: true, age: true, chains: false, sector: true }],
  ];
  for (const [drop, spec] of drops) {
    const es = looErrors(comps, asOf, spec).model;
    ablation.push({ drop, loo: Math.pow(10, median(es)) });
  }
  return {
    loo: Math.pow(10, median(errs.model)),
    looWithin2x: within(errs.model, 2),
    looWithin3x: within(errs.model, 3),
    looFlat: Math.pow(10, median(errs.flat)),
    looFlatWithin3x: within(errs.flat, 3),
    looPower: Math.pow(10, median(errs.power)),
    looPowerWithin3x: within(errs.power, 3),
    holdout: Math.pow(10, median(holdoutErrs)),
    holdoutWithin3x: within(holdoutErrs, 3),
    holdoutFlat: Math.pow(10, median(holdoutFlatErrs)),
    holdoutN: testSet.length,
    q10,
    q25,
    q75,
    q90,
    cover2575: residuals.filter((r) => r >= q25 && r <= q75).length / residuals.length,
    cover1090: residuals.filter((r) => r >= q10 && r <= q90).length / residuals.length,
    ablation,
  };
}

// ---------------------------------------------------------------- bootstrap

/** A small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap rank ranges: refit the model on resampled comps and re-rank the board, 200 times. Returns
 * each ranked slug's P10-P90 rank range. The token-share table is a population statistic and stays fixed.
 */
export function bootstrapRanges(
  comps: SnapshotProtocol[],
  board: SnapshotProtocol[],
  asOf: string,
  table: { buckets: OddsBucket[]; overall: number },
  refits: number = BOOTSTRAP_REFITS,
): Map<string, { lo: number; hi: number }> {
  const rnd = mulberry32(BOOTSTRAP_SEED);
  const ranks = new Map<string, number[]>();
  for (const p of board) ranks.set(p.slug, []);
  for (let r = 0; r < refits; r++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rnd() * comps.length)]!);
    let m: FittedModel;
    try {
      m = fitModel(sample, asOf);
    } catch {
      continue;
    }
    const scored = board
      .map((p) => ({ slug: p.slug, value: predictFdv(m, p, asOf) * oddsFor(p, asOf, table).odds }))
      .sort((a, b) => b.value - a.value || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => ranks.get(s.slug)!.push(i + 1));
  }
  const out = new Map<string, { lo: number; hi: number }>();
  for (const [slug, rs] of ranks) {
    const sorted = rs.sort((a, b) => a - b);
    out.set(slug, { lo: Math.round(quantile(sorted, 0.1)), hi: Math.round(quantile(sorted, 0.9)) });
  }
  return out;
}

// ---------------------------------------------------------------- storing money for the page

/** How the dashboard shows a dollar amount: $M or $B to two decimals, the page's own toFixed. */
function shown(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * A dollar amount stored as $100 units: the nearest unit, nudged at most $100 so the page's shown
 * two decimals match board.json's exactly. The nudge only ever fires within $50 of a rounding
 * boundary (2 rows here); the stored value stays within $150 of the exact one. Deterministic.
 */
export function store100(exact: number): number {
  let s = Math.round(exact / 100);
  if (shown(s * 100) !== shown(exact)) s += s * 100 < exact ? 1 : -1;
  return s;
}

/** A dollar amount stored as $10K units, with the same shown-decimals rule as store100. */
export function store10K(exact: number): number {
  let s = Math.round(exact / 10000);
  if (shown(s * 10000) !== shown(exact)) s += s * 10000 < exact ? 1 : -1;
  return s;
}

// ---------------------------------------------------------------- farm economics

/** A protocol's farm action, from its category's words (first match wins; default is Deposit). */
export function farmAction(p: SnapshotProtocol): { id: string; label: string; hours: number } {
  const c = (p.category ?? '').toLowerCase();
  for (const a of FARM_ACTIONS) {
    if (a.match.length === 0) continue;
    if (a.match.some((w) => c.includes(w))) return { id: a.id, label: a.label, hours: a.hours };
  }
  const d = FARM_ACTIONS[FARM_ACTIONS.length - 1]!;
  return { id: d.id, label: d.label, hours: d.hours };
}

/** Assumed gas for a full farm, from the protocol's first chain. */
export function farmFees(p: SnapshotProtocol): number {
  const first = p.chains.length > 0 ? p.chains[0]! : '';
  return CHAIN_FEES[first] ?? CHAIN_FEES['default']!;
}

/** Hold days from the protocol's age: younger protocols get a longer qualifying window. */
export function farmDays(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
}

/** The expected airdrop slice: the farmer's share of the farm pool times the farmer share of value. */
export function farmSlice(impliedValueUsd: number, tvlUsd: number, ticket: number, share: number): number {
  if (tvlUsd <= 0) return 0;
  return (impliedValueUsd * share * ticket) / (FARM.pool_share * tvlUsd);
}

/** Net value of a farm: expected slice minus cash fees minus time at the assumed $/h. */
export function farmNet(sliceUsd: number, feesUsd: number, hours: number): number {
  return sliceUsd - feesUsd - hours * FARM.usd_per_hour;
}

/** A farm verdict: FARM when net clears the hurdle, THIN when net is positive, else SKIP. */
export function farmVerdict(netUsd: number, ticket: number, hurdle: number): 'FARM' | 'THIN' | 'SKIP' {
  if (netUsd >= hurdle * ticket) return 'FARM';
  if (netUsd > 0) return 'THIN';
  return 'SKIP';
}

/** A dollar amount with thousands separators, for the farm steps. */
function money(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** An age in words, for the farm steps. */
function ageText(age: number | null): string {
  if (age === null) return 'an unrecorded time';
  if (age < 365) return `${age} days`;
  return `${(age / 365).toFixed(1)} years`;
}

/** The action sentence of a farm plan, by action id. Shared with the dashboard's templates. */
function actionSentence(actionId: string, name: string, chain: string, capital: number): string {
  const cap = money(capital);
  switch (actionId) {
    case 'lend':
      return `Supply $${cap} of USDC to ${name} on ${chain} and keep the position open.`;
    case 'lp':
      return `Provide $${cap} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
    case 'stake':
      return `Stake $${cap} of the chain's staking asset through ${name} and keep the receipt.`;
    case 'trade':
      return `Deposit $${cap} of USDC as margin on ${name} and open one small hedge.`;
    case 'predict':
      return `Fund $${cap} and place one market position on ${name}.`;
    case 'vault':
      return `Deposit $${cap} into a ${name} vault on ${chain} and keep the shares.`;
    case 'mint':
      return `Mint or deposit $${cap} of the stable asset through ${name} on ${chain}.`;
    case 'cover':
      return `Buy $${cap} of cover from ${name} on ${chain} and keep the policy.`;
    default:
      return `Deposit $${cap} of USDC into ${name} on ${chain} and keep the position open.`;
  }
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. Derived from the
 * protocol's own record (category, chains, age) and the stated farm assumptions, never from a
 * hand-written list of names. The dashboard expands the SAME templates from the same inputs.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, capital: number): string[] {
  const action = farmAction(p);
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const fees = farmFees(p);
  const days = farmDays(age);
  return [
    stepText(
      `Use a fresh wallet holding only the $${money(capital)} you plan to farm with ${p.name}; keep its seed phrase offline.`,
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    stepText(actionSentence(action.id, p.name, chain, capital), `$${fees.toFixed(2)} of gas across the setup`, `${action.hours} hours to set up and check in`),
    stepText(
      'Make one qualifying action each week — a deposit, swap, vote or borrow — so the activity spans more than one snapshot.',
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Hold the position at least ${days} days; ${p.name} has run ${ageText(age)} with no token, so a longer window counts in more snapshots.`,
      `the $${money(capital)} stays in the position`,
      `${days} days`,
    ),
    stepText(
      `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes; never pay to claim.`,
      'no fee to check',
      '10 minutes',
    ),
    stepText('Log the wallet, dates and every transaction so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'),
  ];
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    fdv_usd: number;
    odds: number;
    odds_bucket: string;
    p25_usd: number;
    p75_usd: number;
    p10_usd: number;
    p90_usd: number;
    rank_lo: number;
    rank_hi: number;
    sector: string | null;
    sector_multiplier: number;
  };
  farm: {
    action: string;
    chain: string;
    fees_usd: number;
    hours: number;
    days: number;
    slice_usd: number;
    net_usd: number;
    net_per_hour: number;
    verdict: 'FARM' | 'THIN' | 'SKIP';
  };
  farm_steps: string[];
}

/** The dashboard's compact data, as one script. Row arrays are positional: see dataScript's note. */
export interface RadarData {
  a: string;
  /** Protocols in the snapshot and slugs on the watchlist: the parity denominators. */
  n: number;
  w: number;
  m: { b: number[]; s: string[]; glo: number; ghi: number; medg: number; meda: number; n: number; lam: number };
  o: Array<[number, number]>;
  ov: number;
  v: {
    loo: number;
    loo2: number;
    loo3: number;
    flat: number;
    flat3: number;
    pow: number;
    pow3: number;
    ho: number;
    ho3: number;
    hof: number;
    hon: number;
    q25: number;
    q75: number;
    q10: number;
    q90: number;
    c25: number;
    c90: number;
    ab: Array<[string, number]>;
    ntvl: number;
  };
  l: Array<[string, number]>;
  cats: string[];
  chs: string[];
  r: Array<[string, string | null, number, number[], number, number | null, number | null, number, number, number, number, number]>;
  s: Array<[number, number]>;
  ln: [[number, number], [number, number]];
  sa: Array<[string, number, number]>;
  rs: string[];
  lv: Array<[string, string | null, number, number, number, number | null]>;
  ck: number;
}

/** A protocol's name from its slug, title-cased word by word — the dashboard's fallback when the stored name is null. Must match app.js's slugName exactly. */
export function slugName(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w === '' ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; model: FittedModel; validation: Validation } {
  const watchlist = new Set(snapshot.watchlist);
  const tokenStems = new Set<string>();
  for (const p of snapshot.protocols) {
    if (hasToken(p)) {
      const stem = nameStem(p.name);
      if (stem.length >= 3) tokenStems.add(stem);
    }
  }
  // The ledger: every protocol, one status, counts that sum to the snapshot's size.
  const ledgerCounts = new Map<LedgerStatus, number>();
  for (const p of snapshot.protocols) {
    const st = ledgerStatus(p, tokenStems, watchlist);
    ledgerCounts.set(st, (ledgerCounts.get(st) ?? 0) + 1);
  }
  const comps = compSet(snapshot);
  const model = fitModel(comps, snapshot.as_of);
  const table = oddsTable(snapshot);
  const validation = validate(comps, snapshot.as_of);
  const boardProtocols = snapshot.protocols.filter((p) => isRankable(p, tokenStems, watchlist));
  const ranges = bootstrapRanges(comps, boardProtocols, snapshot.as_of, table);

  const scored = boardProtocols.map((p) => {
    const fdv = predictFdv(model, p, snapshot.as_of);
    const { odds, bucket } = oddsFor(p, snapshot.as_of, table);
    return { p, fdv, odds, bucket, implied: Math.max(1, Math.round(fdv * odds)) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.slug ? 1 : 0));
  // How many rows sit 5+ ranks off pure TVL order (the model is not a TVL sort).
  const byTvl = [...boardProtocols].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const tvlRank = new Map(byTvl.map((p, i) => [p.slug, i + 1]));
  let offTvl = 0;
  scored.forEach((s, i) => {
    if (Math.abs(i + 1 - (tvlRank.get(s.p.slug) ?? 0)) >= 5) offTvl++;
  });

  const board: BoardRow[] = scored.map((s, i) => {
    const p = s.p;
    const age = ageDays(snapshot.as_of, p.listed_at);
    const range = ranges.get(p.slug) ?? { lo: i + 1, hi: i + 1 };
    const sectorIdx = model.sectors.indexOf(p.category ?? '');
    const sectorMult = sectorIdx >= 0 ? Math.pow(10, model.beta[5 + sectorIdx]!) : 1;
    const action = farmAction(p);
    const fees = farmFees(p);
    const days = farmDays(age);
    const slice = farmSlice(s.implied, p.tvl_usd, FARM.ticket, FARM.share);
    const net = farmNet(slice, fees, action.hours);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      age_days: age,
      implied_value_usd: s.implied,
      model: {
        fdv_usd: Math.max(1, Math.round(s.fdv)),
        odds: round3(s.odds),
        odds_bucket: s.bucket >= 0 ? ODDS_BUCKETS[s.bucket]![2] : 'unknown age',
        p25_usd: Math.max(1, Math.round(s.implied * Math.pow(10, validation.q25))),
        p75_usd: Math.max(1, Math.round(s.implied * Math.pow(10, validation.q75))),
        p10_usd: Math.max(1, Math.round(s.implied * Math.pow(10, validation.q10))),
        p90_usd: Math.max(1, Math.round(s.implied * Math.pow(10, validation.q90))),
        rank_lo: range.lo,
        rank_hi: range.hi,
        sector: sectorIdx >= 0 ? model.sectors[sectorIdx]! : null,
        sector_multiplier: round3(sectorMult),
      },
      farm: {
        action: action.label,
        chain: p.chains.length > 0 ? p.chains[0]! : 'its main chain',
        fees_usd: fees,
        hours: action.hours,
        days,
        slice_usd: round2(slice),
        net_usd: round2(net),
        net_per_hour: round2(net / action.hours),
        verdict: farmVerdict(net, FARM.ticket, FARM.hurdle),
      },
      farm_steps: farmSteps(p, age, FARM.ticket),
    };
  });

  // Compact dictionaries for the dashboard.
  const cats: string[] = [];
  const catIdx = new Map<string, number>();
  const chs: string[] = [];
  const chIdx = new Map<string, number>();
  const catOf = (c: string | null): number => {
    const k = c ?? 'Uncategorized';
    let i = catIdx.get(k);
    if (i === undefined) {
      i = cats.length;
      cats.push(k);
      catIdx.set(k, i);
    }
    return i;
  };
  const chOf = (c: string): number => {
    let i = chIdx.get(c);
    if (i === undefined) {
      i = chs.length;
      chs.push(c);
      chIdx.set(c, i);
    }
    return i;
  };
  // Rows omit their rank: the array is in rank order, so rank is the index plus one. Money is stored
  // in $100 units (implied) and $10K units (TVL), each nudged so the page's shown two decimals match
  // board.json's exactly; a name is null when the slug title-cases to it — 120 of 192 names need no
  // storage at all.
  const rows: RadarData['r'] = board.map((r) => [
    r.slug,
    slugName(r.slug) === r.name ? null : r.name,
    catOf(r.category),
    r.chains.map(chOf),
    store10K(r.tvl_usd),
    r.change_7d === null ? null : round1(r.change_7d),
    r.age_days,
    store100(r.implied_value_usd),
    ODDS_BUCKETS.findIndex(([, , label]) => label === r.model.odds_bucket),
    r.model.rank_lo,
    r.model.rank_hi,
    watchlist.has(r.slug) ? 1 : 0,
  ]);
  // The scatter's traded comps, as rounded log10 pairs (one decimal is plenty at plot scale).
  const scatter: Array<[number, number]> = comps.map((p) => [round1(Math.log10(p.tvl_usd)), round1(Math.log10(p.mcap_usd!))]);
  // The fitted line's endpoints, at median features and the median board row's odds.
  const medianOdds = table.buckets[2]!.share;
  const lineAt = (logTvl: number): number => {
    const b = model.beta;
    return b[0]! + b[1]! * logTvl + b[3]! * Math.log10(model.medianAge) + b[4]! * Math.log10(2) + Math.log10(medianOdds);
  };
  const tvls = comps.map((p) => Math.log10(p.tvl_usd));
  const loT = Math.floor(Math.min(...tvls));
  const hiT = Math.ceil(Math.max(...tvls));
  // The set-aside tab: slug, category, and reason index (names derive from slugs in the page).
  const reasonLabels = ['Bridge', 'Liquid staking', 'Exchange custody', 'Versioned', 'Wrapped or staked', 'Kin of a token'];
  const reasonOf = (st: LedgerStatus): number => {
    switch (st) {
      case 'bridge':
        return 0;
      case 'liquid-staking':
        return 1;
      case 'exchange-custody':
        return 2;
      case 'versioned':
        return 3;
      case 'wrapped-or-staked':
        return 4;
      case 'kin-of-token':
        return 5;
      default:
        return -1;
    }
  };
  const setAside: RadarData['sa'] = snapshot.protocols
    .filter((p) => {
      const st = ledgerStatus(p, tokenStems, watchlist);
      return st !== 'ranked' && st !== 'trades' && st !== 'on-record';
    })
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => [p.slug, catOf(p.category), reasonOf(ledgerStatus(p, tokenStems, watchlist))]);
  // The traded-comps tab: the 8 largest by market cap.
  const live: RadarData['lv'] = snapshot.protocols
    .filter(tokenTrades)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 8)
    .map((p) => [
      p.slug,
      slugName(p.slug) === p.name ? null : p.name,
      catOf(p.category),
      store100(p.tvl_usd),
      store100(p.mcap_usd!),
      p.change_7d === null ? null : round1(p.change_7d),
    ] as [string, string | null, number, number, number, number | null]);

  const radar: RadarData = {
    a: snapshot.as_of,
    n: snapshot.protocols.length,
    w: snapshot.watchlist.length,
    m: {
      b: model.beta.map(round4),
      s: model.sectors,
      glo: round2(model.winsorLo),
      ghi: round2(model.winsorHi),
      medg: round2(model.medianChange7d),
      meda: model.medianAge,
      n: model.nComps,
      lam: RIDGE_LAMBDA,
    },
    o: table.buckets.map((b) => [b.n, round4(b.share)]),
    ov: round4(table.overall),
    v: {
      loo: round2(validation.loo),
      loo2: round2(validation.looWithin2x),
      loo3: round2(validation.looWithin3x),
      flat: round2(validation.looFlat),
      flat3: round2(validation.looFlatWithin3x),
      pow: round2(validation.looPower),
      pow3: round2(validation.looPowerWithin3x),
      ho: round2(validation.holdout),
      ho3: round2(validation.holdoutWithin3x),
      hof: round2(validation.holdoutFlat),
      hon: validation.holdoutN,
      q25: round6(validation.q25),
      q75: round6(validation.q75),
      q10: round6(validation.q10),
      q90: round6(validation.q90),
      c25: round2(validation.cover2575),
      c90: round2(validation.cover1090),
      ab: validation.ablation.map((a) => [a.drop, round2(a.loo)] as [string, number]),
      ntvl: offTvl,
    },
    l: LEDGER_RULES.map((row) => [row.label, ledgerCounts.get(row.status) ?? 0] as [string, number]),
    cats,
    chs,
    r: rows,
    s: scatter,
    ln: [
      [loT, round2(lineAt(loT))],
      [hiT, round2(lineAt(hiT))],
    ],
    sa: setAside,
    rs: reasonLabels,
    lv: live,
    ck: rows.reduce((n, r) => n + r[7], 0),
  };
  return { board, radar, model, validation };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `// Rows in rank order (rank = index + 1): [slug,name,cat,chains,tvl10K,chg,age,impl100,odds,rlo,rhi,wl]; name null when the slug title-cases to it; money in $10K (TVL) and $100 (implied) units.\nwindow.RADAR=${JSON.stringify(radar)};\n`;
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/**
 * The build-time verification: row counts, unique slugs, ranks 1..N, values non-increasing, step
 * lengths, watchlist coverage, the ledger summing to the snapshot, and the dashboard's rows matching
 * board.json (same slugs, same ranks, same implied values, same checksum). Returns every failure.
 */
export function verifyBuild(board: BoardRow[], radar: RadarData, snapshot: Snapshot): string[] {
  const failures: string[] = [];
  const issue = boardIssue(board, snapshot);
  if (issue !== null) failures.push(issue);
  const ledgerSum = radar.l.reduce((n, [, c]) => n + c, 0);
  if (ledgerSum !== snapshot.protocols.length) failures.push(`the ledger sums to ${ledgerSum}, not ${snapshot.protocols.length}`);
  if (radar.r.length !== board.length) failures.push(`data.js holds ${radar.r.length} rows, board.json ${board.length}`);
  const bySlugBoard = new Map(board.map((r) => [r.slug, r]));
  let checksum = 0;
  for (let i = 0; i < radar.r.length; i++) {
    const row = radar.r[i]!;
    const b = bySlugBoard.get(row[0]);
    if (b === undefined) {
      failures.push(`data.js row ${row[0]} is not in board.json`);
      continue;
    }
    // Money is stored in $100 (implied) and $10K (TVL) units, nudged so the shown decimals match:
    // check the stored values against board.json AND the shown strings against each other.
    const name = row[1] === null ? slugName(row[0]) : row[1];
    if (i + 1 !== b.rank || name !== b.name) {
      failures.push(`data.js row ${row[0]} disagrees with board.json on rank or name`);
    }
    if (Math.abs(row[7] * 100 - b.implied_value_usd) > 150 || shown(row[7] * 100) !== shown(b.implied_value_usd)) {
      failures.push(`data.js row ${row[0]} disagrees with board.json on implied value`);
    }
    if (Math.abs(row[4] * 10000 - b.tvl_usd) > 15000 || shown(row[4] * 10000) !== shown(b.tvl_usd)) {
      failures.push(`data.js row ${row[0]} disagrees with board.json on TVL`);
    }
    checksum += row[7];
  }
  if (checksum !== radar.ck) failures.push(`data.js checksum ${checksum} does not match its own total ${radar.ck}`);
  const boardSum = board.reduce((n, r) => n + store100(r.implied_value_usd), 0);
  if (boardSum !== radar.ck) failures.push(`board.json sums to ${boardSum} $100 units, data.js to ${radar.ck}`);
  return failures;
}
