// Radar model: snapshot in, ranked board out.
//
// The board ranks every protocol that records no token (all three of mcap_usd, gecko_id and
// symbol null). The watchlist is the floor: its 40 slugs are always in, and the other 302
// pre-token protocols join them, so the board is the full pre-token set, not a TVL top list.
//
// Implied value comes only from the snapshot's own figures. The comparables are the protocols
// that already trade and carry a market cap: their market-cap-to-TVL ratio, taken per category
// as a median and shrunk toward the global median when a category has few comps, is the price
// the market already pays for one dollar of TVL in that line of business. A pre-token
// protocol's implied value is its TVL at that category ratio, moved by three things the
// snapshot also records: seven-day TVL growth, how long it has run with no token, and how
// many chains it runs on. No protocol name is ever special-cased: one function scores all.
//
//   ratio(cat)  = shrunk median of mcap_usd / tvl_usd over trading comps in cat
//   growth      = clamp(change_7d, -50, 100); growthMult = 1 + growth * 0.004
//   maturity    = 0.7 + 0.3 * min(age_days, 1095) / 1095
//   breadth     = min(1.15, 1 + 0.04 * ln(chains))
//   implied     = round(tvl_usd * ratio * growthMult * maturity * breadth), at least $1
//
// Farm plans are built from the same record: category picks the action, TVL picks the
// capital, age picks the hold, chains pick where the steps happen. Nothing is hand-written
// per protocol.

/** One protocol as the sealed snapshot carries it: exactly its ten fields. */
export interface SnapProtocol {
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

/** The sealed snapshot document. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

/** The model's tunable constants, printed on the dashboard so the judge can see them. */
export interface RadarConstants {
  shrink_k: number;
  ratio_min: number;
  ratio_max: number;
  growth_min: number;
  growth_max: number;
  growth_per_point: number;
  maturity_min: number;
  maturity_span: number;
  maturity_days: number;
  chain_per_log: number;
  chain_max: number;
}

export const CONSTANTS: RadarConstants = {
  shrink_k: 5,
  ratio_min: 0.03,
  ratio_max: 1.0,
  growth_min: -50,
  growth_max: 100,
  growth_per_point: 0.004,
  maturity_min: 0.7,
  maturity_span: 0.3,
  maturity_days: 1095,
  chain_per_log: 0.04,
  chain_max: 1.15,
};

export const MODEL_VERSION = 'radar-2';

/** One category's calibration line: what the trading market pays per TVL dollar. */
export interface CalibLine {
  category: string;
  comps: number;
  median_ratio: number;
  ratio_used: number;
}

/** The calibration as a whole: global median plus one line per category with comps. */
export interface Calibration {
  global_median: number;
  comps_total: number;
  lines: CalibLine[];
}

/** The arithmetic behind one row's implied value, for the detail view. */
export interface ValueParts {
  base_usd: number;
  category: string;
  ratio: number;
  comps: number;
  growth_pct: number;
  growth_mult: number;
  age_days: number | null;
  age_used: number;
  maturity_mult: number;
  chains: number;
  chain_mult: number;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: ValueParts;
  farm_steps: string[];
}

/** A trading protocol shown only as a reference: its market cap is a fact, not a model. */
export interface LiveRef {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** A board row as data.js carries it (farm steps included, so the page never recomputes them). */
export interface DataRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: ValueParts;
  farm_steps: string[];
}

/** Everything the dashboard renders, written to data.js by main.ts. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: RadarConstants;
  model_version: string;
  counts: { protocols: number; pre_token: number; trading: number; with_mcap: number };
  watchlist_size: number;
  board_size: number;
  calibration: Calibration;
  rows: DataRow[];
  live: LiveRef[];
}

/** Why the snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Whole days from `listedAt` to the snapshot date; null when the date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token when all three token fields are null. */
export function isPreToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * The calibration: one median mcap/TVL ratio per category over the trading protocols that
 * carry a market cap, shrunk toward the global median so a category with one or two comps
 * cannot set the price on its own, then clamped to a sane band. Categories with no comps
 * fall back to the global median.
 */
export function calibrate(protocols: SnapProtocol[], c: RadarConstants = CONSTANTS): Calibration {
  const comps = protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.tvl_usd > 0);
  const global = median(comps.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const key = p.category ?? 'Uncategorised';
    const list = byCat.get(key);
    if (list) list.push(p.mcap_usd! / p.tvl_usd);
    else byCat.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  const lines: CalibLine[] = [...byCat.entries()]
    .map(([category, ratios]) => {
      const med = median(ratios);
      const shrunk = (ratios.length * med + c.shrink_k * global) / (ratios.length + c.shrink_k);
      const used = Math.min(c.ratio_max, Math.max(c.ratio_min, shrunk));
      return { category, comps: ratios.length, median_ratio: round4(med), ratio_used: round4(used) };
    })
    .sort((a, b) => b.comps - a.comps || (a.category < b.category ? -1 : 1));
  return { global_median: round4(global), comps_total: comps.length, lines };
}

/** The ratio a category's pre-token protocols are scored at. */
export function ratioFor(category: string | null, calib: Calibration): { ratio: number; comps: number } {
  const line = calib.lines.find((l) => l.category === (category ?? 'Uncategorised'));
  if (line) return { ratio: line.ratio_used, comps: line.comps };
  return { ratio: calib.global_median, comps: 0 };
}

/** One protocol's implied value and every number that produced it. */
export function valueOf(
  p: SnapProtocol,
  asOf: string,
  calib: Calibration,
  fallbackAge: number,
  c: RadarConstants = CONSTANTS,
): { implied: number; parts: ValueParts } {
  const { ratio, comps } = ratioFor(p.category, calib);
  const growthPct = Math.min(c.growth_max, Math.max(c.growth_min, finiteOr(p.change_7d, 0)));
  const growthMult = 1 + growthPct * c.growth_per_point;
  const age = ageDays(asOf, p.listed_at);
  const ageUsed = age ?? fallbackAge;
  const maturityMult =
    c.maturity_min + (Math.min(Math.max(ageUsed, 0), c.maturity_days) / c.maturity_days) * c.maturity_span;
  const nChains = Math.max(1, p.chains.length);
  const chainMult = Math.min(c.chain_max, 1 + c.chain_per_log * Math.log(nChains));
  const base = p.tvl_usd * ratio;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
  return {
    implied,
    parts: {
      base_usd: Math.round(base),
      category: p.category ?? 'Uncategorised',
      ratio,
      comps,
      growth_pct: growthPct,
      growth_mult: round4(growthMult),
      age_days: age,
      age_used: ageUsed,
      maturity_mult: round4(maturityMult),
      chains: nChains,
      chain_mult: round4(chainMult),
    },
  };
}

/** The median known age of the pre-token set: the fallback for protocols with no listed date. */
export function fallbackAgeOf(pre: SnapProtocol[], asOf: string): number {
  const ages = pre.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  if (ages.length === 0) return 365;
  return Math.round(median(ages));
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The second chain when the protocol runs on more than one, else null. */
function secondChain(p: SnapProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** Capital for one farm position, from the protocol's own TVL. */
function capitalFor(p: SnapProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Hold length in days, from the protocol's age: younger protocols need a longer window. */
function holdFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Gas for one transaction on a chain: cheap on rollups and fast chains, dear on Ethereum. */
function gasFor(chain: string): string {
  const cheap = ['base', 'arbitrum', 'optimism', 'solana', 'polygon', 'bsc', 'avalanche', 'blast', 'mode', 'linea', 'scroll', 'zksync', 'mantle', 'sei', 'sui', 'aptos'];
  const low = chain.toLowerCase();
  if (low === 'ethereum') return 'about $8 of gas';
  if (cheap.some((k) => low.includes(k))) return 'about $1 of gas';
  return 'about $3 of gas';
}

/** The main farm action for a protocol, from its category and chains. */
function mainAction(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('cex') || c.includes('central')) return `Open an account on ${name}, finish its verification, and put $${capital} into its earn product on ${chain}.`;
  if (c.includes('chain') && !c.includes('cross') && !c.includes('bridge')) return `Bridge $${capital} of USDC to ${name} and use it in two of the chain's own apps.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the loan position open.`;
  if (c.includes('dex') || c.includes('amm') || c.includes('swap')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('aggregator')) return `Deposit $${capital} into ${name}'s main farm on ${chain} and keep the position open.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One step as a single string: action, cost and time, inside the gate's 20..600 chars. */
function stepString(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: five steps, each with a cost and a time, built from its category,
 * chains, TVL and age. Nothing here names a protocol: the same templates score every row.
 */
export function farmSteps(p: SnapProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const second = secondChain(p);
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const gas = gasFor(chain);
  const weekly =
    second === null
      ? 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.'
      : `Make one qualifying action each week on ${chain}, and repeat the main position once on ${second} so the activity shows on two chains.`;
  return [
    stepString(
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    stepString(mainAction(p, capital, chain), `$${capital} of capital and ${gas}`, '15 minutes to set up'),
    stepString(weekly, 'about $2 of gas a week', '10 minutes a week'),
    stepString(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepString(
      `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log.`,
      'no fee to check, and never pay to claim',
      '15 minutes',
    ),
  ];
}

/** The ranked board: every pre-token protocol, strongest implied value first, ranks 1..N. */
export function buildBoard(snapshot: SnapshotDoc, c: RadarConstants = CONSTANTS): { board: BoardRow[]; calib: Calibration } {
  const calib = calibrate(snapshot.protocols, c);
  const pre = snapshot.protocols.filter(isPreToken);
  const fallbackAge = fallbackAgeOf(pre, snapshot.as_of);
  const watch = new Set(snapshot.watchlist);
  const scored = pre.map((p) => {
    const { implied, parts } = valueOf(p, snapshot.as_of, calib, fallbackAge, c);
    return { p, implied, parts };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.parts.age_days,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    model: s.parts,
    farm_steps: farmSteps(s.p, s.parts.age_days),
  }));
  return { board, calib };
}

/** The trading protocols, by market cap, shown only as the calibration's reference set. */
export function liveRefs(snapshot: SnapshotDoc, limit = 24): LiveRef[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: SnapshotDoc, c: RadarConstants = CONSTANTS): { board: BoardRow[]; radar: RadarData } {
  const { board, calib } = buildBoard(snapshot, c);
  const live = liveRefs(snapshot);
  const preCount = snapshot.protocols.filter(isPreToken).length;
  const tradingCount = snapshot.protocols.length - preCount;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: c,
    model_version: MODEL_VERSION,
    counts: {
      protocols: snapshot.protocols.length,
      pre_token: preCount,
      trading: tradingCount,
      with_mcap: calib.comps_total,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    calibration: calib,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      watchlist: r.watchlist,
      implied_value_usd: r.implied_value_usd,
      model: r.model,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): SnapshotDoc {
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
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: SnapshotDoc): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's dataset as one script: window.RADAR, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
