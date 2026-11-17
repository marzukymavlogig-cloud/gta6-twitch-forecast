// GTA VI Twitch CCU forecaster — make.fun gta6-twitch-ccu-forecast-01.
//
// Method (see README.md for the evidence): the launch-day curve of a big game
// is predicted from its first hour's print by the curves of past launches.
// For each hour h = 2..24, the log-ratio ln(viewers_h / viewers_1) is modelled
// as a smooth function of ln(viewers_1) — big first hours (midnight-rolling
// unlocks already live in many regions) stay flat, small first hours (the
// unlock still ahead) surge later — fitted by kernel-weighted local linear
// regression over the case's comparables (Gaussian kernel, bandwidth 1.5 in
// log units), with the five quantiles taken from the kernel-weighted
// residuals, widened 15% for honest coverage. Leave-one-out pinball loss on
// the kit's 37 comparable launches: 0.385 (persistence baseline: 0.930);
// on launches with a first hour in the 20k..300k range, 0.295 vs 0.349.
//
// Pure function of the case file: no network, no clock, no randomness, so
// two runs on the same case write byte-identical output. Node 22 stdlib only.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The quantile levels the contest scores, in the order each row lists them.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// The standard normal's quantiles at those levels (baseline fallback only).
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
// Kernel bandwidth on ln(viewers_1), and the residual spread widening.
const BANDWIDTH = 1.5;
const SPREAD = 1.15;
// How many usable reference launches an hour needs before we trust the fit.
const MIN_REFS = 5;

type Comparable = {
  name: string;
  logH1: number;
  // log(viewers_h / viewers_1) for h = 1..24 (index h-1); null where unobserved.
  logRatio: (number | null)[];
};

/** x rounded to 2 decimals, half up, as the house baseline rounds it. */
function round2(x: number): number {
  const scaled = x * 100;
  let whole = Math.floor(scaled);
  if (scaled - whole >= 0.5) whole += 1;
  const value = whole / 100;
  return value;
}

/** Linear-interpolation quantile of a sorted array. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The release-day hourly viewers of one comparable, indexed 0..23. */
function releaseDay(comp: any): (number | null)[] {
  const t0 = Date.parse(comp.day_start);
  const day: (number | null)[] = new Array(24).fill(null);
  if (!Array.isArray(comp.hourly) || Number.isNaN(t0)) return day;
  for (const p of comp.hourly) {
    if (!p || typeof p.viewers !== 'number' || p.viewers <= 0) continue;
    const h = Math.floor((Date.parse(p.from) - t0) / 3600000);
    if (h >= 0 && h < 24 && day[h] === null) day[h] = p.viewers;
  }
  return day;
}

/** The reference launches usable for the fit. */
function references(compArray: any[]): Comparable[] {
  const out: Comparable[] = [];
  if (!Array.isArray(compArray)) return out;
  for (const comp of compArray) {
    if (!comp || typeof comp.name !== 'string') continue;
    const day = releaseDay(comp);
    const h1 = day[0];
    if (h1 === null || h1 <= 0) continue;
    const logH1 = Math.log(h1);
    const logRatio: (number | null)[] = day.map((v) =>
      v === null ? null : Math.log(v / h1),
    );
    out.push({ name: comp.name, logH1, logRatio });
  }
  // Fixed order, so two runs fit the same numbers in the same order.
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Kernel-weighted local-linear fit of log-ratio on log(h1) at x0, hour h. */
function fitHour(refs: Comparable[], h: number, x0: number): {
  mu: number;
  residuals: { v: number; w: number }[];
} | null {
  const pts: { x: number; y: number; w: number }[] = [];
  for (const r of refs) {
    const y = r.logRatio[h - 1];
    if (y === null) continue;
    const w = Math.exp(-0.5 * ((r.logH1 - x0) / BANDWIDTH) ** 2);
    pts.push({ x: r.logH1, y, w });
  }
  if (pts.length < MIN_REFS) return null;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sw += p.w;
    sx += p.w * p.x;
    sy += p.w * p.y;
  }
  const mx = sx / sw;
  const my = sy / sw;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += p.w * (p.x - mx) * (p.y - my);
    sxx += p.w * (p.x - mx) * (p.x - mx);
  }
  const b = sxx > 1e-9 ? sxy / sxx : 0;
  const a = my - b * mx;
  const residuals = pts
    .map((p) => ({ v: p.y - (a + b * p.x), w: p.w }))
    .sort((u, v) => u.v - v.v);
  const ys = pts.map((p) => p.y);
  return {
    // The local-linear centre, clamped to the log-ratios actually observed
    // that hour: a first hour far outside the reference range must not
    // extrapolate the curve past anything any launch ever did.
    mu: Math.min(Math.max(a + b * x0, Math.min(...ys)), Math.max(...ys)),
    residuals,
  };
}

/** Weighted quantile of residuals at level tau. */
function weightedQuantile(residuals: { v: number; w: number }[], tau: number): number {
  const total = residuals.reduce((s, r) => s + r.w, 0);
  let acc = 0;
  for (const r of residuals) {
    acc += r.w;
    if (acc >= tau * total) return r.v;
  }
  return residuals[residuals.length - 1].v;
}

/** The five quantiles of hour h as viewer counts. */
function hourQuantiles(refs: Comparable[], p1: number, h: number): number[] {
  const fit = fitHour(refs, h, Math.log(p1));
  if (fit === null) {
    // Too little reference: fall back to the house persistence shape.
    return Z.map((z) => round2(Math.max(1, p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1)))));
  }
  const qs = LEVELS.map((tau) =>
    round2(Math.max(1, p1 * Math.exp(fit.mu + SPREAD * weightedQuantile(fit.residuals, tau)))),
  );
  // Quantiles must be non-decreasing; the residual quantiles already are,
  // but rounding can tie them, never invert them — enforce it anyway.
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
}

/** Hour 1's print: the known row, else the last pre-checkpoint hour, else 1. */
function hourOnePrint(kase: any): number {
  if (Array.isArray(kase.known)) {
    for (const k of kase.known) {
      if (k && k.hour === 1 && typeof k.viewers === 'number' && k.viewers > 0) {
        return k.viewers;
      }
    }
  }
  if (Array.isArray(kase.history_hourly) && kase.history_hourly.length > 0) {
    const last = kase.history_hourly[kase.history_hourly.length - 1];
    if (last && typeof last.viewers === 'number' && last.viewers > 0) return last.viewers;
  }
  return 1;
}

function forecastCase(kase: any, name: string): { hours: { hour: number; q: number[] }[] } {
  if (!Array.isArray(kase.levels) || kase.levels.join(',') !== LEVELS.join(',')) {
    throw new Error(`${name} asks for levels ${JSON.stringify(kase.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const p1 = Math.max(1, hourOnePrint(kase));
  const refs = references(kase.comparables);
  const rows = Array.isArray(kase.forecast) ? kase.forecast : [];
  const hours = rows.map((row: any) => {
    const h = row.hour;
    if (typeof h !== 'number' || h < 2 || h > 24) {
      throw new Error(`${name} asks to forecast hour ${JSON.stringify(h)}`);
    }
    return { hour: h, q: hourQuantiles(refs, p1, h) };
  });
  hours.sort((a, b) => a.hour - b.hour);
  return { hours };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const names = readdirSync(INPUT_DIR)
    .filter((n) => n.endsWith('.in'))
    .sort();
  for (const name of names) {
    const kase = JSON.parse(readFileSync(join(INPUT_DIR, name), 'utf8'));
    const forecast = forecastCase(kase, name);
    const out = JSON.stringify(forecast) + '\n';
    writeFileSync(join(OUTPUT_DIR, name.replace(/\.in$/, '.out')), out, 'utf8');
  }
}

main();
