// Pure attribution math: no `$`, so tests can drive it directly.
//
// Each session keeps a ledger of its cumulative API-priced cost and of the
// account meter readings its responses carried. The meter is account-wide, so
// a session's share of a window is estimated as
//   (session cost inside the window) x k,
// where k (meter points per USD) is calibrated from every tracked session:
// the meter's growth over the observed intervals divided by the cost all
// tracked sessions spent in those intervals.

import type { Confidence, SessionShare, View, WindowView } from '../types'

export const WINDOWS = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
} as const
export type WindowKind = keyof typeof WINDOWS

/**
 * The relative error a calibration may carry and still count as good. The
 * meter is rounded (whole percents in practice), so the error of k is about
 * one rounding step over the meter points the calibration rests on.
 */
const GOOD_ERROR = 0.25

const KEEP_MS = 8 * 24 * 3600_000
const COST_STEP_MS = 60_000
const METER_HEARTBEAT_MS = 5 * 60_000
const EPS_USD = 0.0005
const RESET_TOLERANCE_MS = 120_000

export type CostSample = [t: number, usd: number]
export type MeterSample = [t: number, kind: WindowKind, pct: number, resetAt: number]

export type Ledger = {
  v: 1
  sid: string
  label: string
  /** Cumulative cost, made monotonic across ledger resets of the host. */
  cost: CostSample[]
  meter: MeterSample[]
  /** The host's last raw total and the offset added after it dropped. */
  rawUsd: number
  offset: number
}

export type Prior = { k: number }
export type Priors = Partial<Record<WindowKind, Prior>> & {
  /** Weekly k over 5-hour k, and its relative error in percent. */
  ratio?: number
  ratioErrorPct?: number
}

export function newLedger(sid: string, label: string, startedAt: number): Ledger {
  return { v: 1, sid, label, cost: [[startedAt, 0]], meter: [], rawUsd: 0, offset: 0 }
}

export function isLedger(x: unknown): x is Ledger {
  const l = x as Ledger
  return (
    !!l &&
    l.v === 1 &&
    typeof l.sid === 'string' &&
    Array.isArray(l.cost) &&
    Array.isArray(l.meter)
  )
}

/** Records the host's cost total; returns whether the ledger changed. */
export function recordCost(l: Ledger, now: number, rawUsd: number): boolean {
  if (rawUsd < l.rawUsd - 1e-9) l.offset += l.rawUsd
  l.rawUsd = rawUsd
  const usd = l.offset + rawUsd
  const last = l.cost[l.cost.length - 1]
  if (last && usd <= last[1] + 1e-9) return false
  const prev = l.cost[l.cost.length - 2]
  // Fold samples closer than a minute into one, keeping the list short.
  if (last && prev && now - prev[0] < COST_STEP_MS) l.cost[l.cost.length - 1] = [now, usd]
  else l.cost.push([now, usd])
  prune(l, now)
  return true
}

/** Records one meter reading; returns whether the ledger changed. */
export function recordMeter(
  l: Ledger,
  now: number,
  kind: WindowKind,
  pct: number,
  resetAt: number,
): boolean {
  let last: MeterSample | undefined
  for (let i = l.meter.length - 1; i >= 0; i--) {
    const m = l.meter[i]!
    if (m[1] === kind) {
      last = m
      break
    }
  }
  const isSame =
    last && last[2] === pct && Math.abs(last[3] - resetAt) < RESET_TOLERANCE_MS
  if (isSame && last && now - last[0] < METER_HEARTBEAT_MS) return false
  l.meter.push([now, kind, pct, resetAt])
  prune(l, now)
  return true
}

function prune(l: Ledger, now: number) {
  const from = now - KEEP_MS
  // Keep the newest sample before the cutoff as the anchor for interpolation.
  let i = 0
  while (i + 1 < l.cost.length && l.cost[i + 1]![0] < from) i++
  if (i > 0) l.cost.splice(0, i)
  l.meter = l.meter.filter(m => m[0] >= from)
}

/** Cumulative cost at time t, linear between samples. */
export function costAt(samples: CostSample[], t: number): number {
  const first = samples[0]
  if (!first) return 0
  if (t <= first[0]) return first[1]
  for (let i = 1; i < samples.length; i++) {
    const [t1, c1] = samples[i]!
    if (t <= t1) {
      const [t0, c0] = samples[i - 1]!
      return t1 === t0 ? c1 : c0 + ((c1 - c0) * (t - t0)) / (t1 - t0)
    }
  }
  return samples[samples.length - 1]![1]
}

export function costIn(samples: CostSample[], a: number, b: number): number {
  return b <= a ? 0 : Math.max(0, costAt(samples, b) - costAt(samples, a))
}

/** The earliest moment any tracked ledger has data for. */
export function coverageFrom(ledgers: Ledger[]): number {
  let t = Infinity
  for (const l of ledgers) if (l.cost[0]) t = Math.min(t, l.cost[0][0])
  return t
}

type Raw = WindowView & { ownK: number | null }

function windowView(
  kind: WindowKind,
  ledgers: Ledger[],
  meSid: string,
  now: number,
  prior: Prior | undefined,
): Raw | null {
  const dur = WINDOWS[kind]
  const obs = ledgers.flatMap(l => l.meter.filter(m => m[1] === kind))
  if (obs.length === 0) return null
  const latest = obs.reduce((a, b) => (b[0] > a[0] ? b : a))
  const resetAt = latest[3]
  const isStale = resetAt <= now
  const ws = resetAt - dur
  const pts: [number, number][] = obs
    .filter(m => Math.abs(m[3] - resetAt) < RESET_TOLERANCE_MS && m[0] >= ws)
    .map(m => [m[0], m[2]] as [number, number])
    .sort((a, b) => a[0] - b[0])
  // The meter stood at zero when the window opened; that point is usable only
  // if the ledgers already covered every tracked session then.
  if (coverageFrom(ledgers) <= ws) pts.unshift([ws, 0])

  let ccDp = 0
  let ccDc = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const [t0, p0] = pts[i]!
    const [t1, p1] = pts[i + 1]!
    if (t1 <= t0) continue
    const dc = ledgers.reduce((s, l) => s + costIn(l.cost, t0, t1), 0)
    // Growth with no tracked spend is someone else's (claude.ai, an untracked
    // session); it stays out of the calibration.
    if (dc <= EPS_USD) continue
    ccDp += p1 - p0
    ccDc += dc
  }
  ccDp = Math.max(0, ccDp)

  const step = meterStep(obs.map(m => m[2]))
  // The rounding error of the end reading against the points observed.
  const ownError = ccDp > 0 ? step / ccDp : null
  const isOwnGood = ownError !== null && ownError <= GOOD_ERROR && ccDc > EPS_USD
  const ownK = isOwnGood ? ccDp / ccDc : null
  let k: number | null = null
  let confidence: Confidence = 'none'
  let errorPct: number | null = null
  if (prior && prior.k > 0 && !isOwnGood) {
    // A past window's good calibration outweighs this window's thin evidence:
    // it counts as the points a good calibration needs.
    const w = step / GOOD_ERROR / prior.k
    k = (ccDp + prior.k * w) / (ccDc + w)
    confidence = 'low'
    errorPct = Math.round(GOOD_ERROR * 100)
  } else if (ccDc > EPS_USD && ccDp > 0) {
    k = ccDp / ccDc
    confidence = isOwnGood ? 'good' : 'low'
    errorPct = ownError === null ? null : Math.round(Math.min(1, ownError) * 100)
  }

  const shares = ledgers.map(l => ({ l, usd: costIn(l.cost, ws, now) }))
  const mineUsd = shares.find(s => s.l.sid === meSid)?.usd ?? 0
  const allUsd = shares.reduce((s, x) => s + x.usd, 0)
  const accountPct = isStale ? 0 : latest[2]
  const view: Raw = {
    kind,
    accountPct,
    resetAt,
    isStale,
    k,
    confidence,
    evidencePts: round(ccDp, 1),
    errorPct,
    isBorrowed: false,
    minePct: null,
    othersPct: null,
    untrackedPct: null,
    mineUsd,
    sessions: [],
    ownK,
  }
  fill(view, shares, meSid, allUsd)
  return view
}

function fill(
  v: Raw,
  shares: { l: Ledger; usd: number }[],
  meSid: string,
  allUsd: number,
) {
  const k = v.k
  v.minePct = k === null ? null : v.mineUsd * k
  v.othersPct = k === null ? null : (allUsd - v.mineUsd) * k
  v.untrackedPct = k === null ? null : Math.max(0, v.accountPct - allUsd * k)
  v.sessions = shares
    .filter(s => s.usd > EPS_USD || s.l.sid === meSid)
    .sort((a, b) => b.usd - a.usd)
    .map(
      (s): SessionShare => ({
        sid: s.l.sid,
        label: s.l.label,
        usd: s.usd,
        pct: k === null ? null : s.usd * k,
        isMe: s.l.sid === meSid,
      }),
    )
}

export function compute(
  ledgers: Ledger[],
  meSid: string,
  now: number,
  priors: Priors,
): { view: View; priors: Priors } {
  const me = ledgers.find(l => l.sid === meSid)
  const raw: Partial<Record<WindowKind, Raw>> = {}
  for (const kind of Object.keys(WINDOWS) as WindowKind[]) {
    const v = windowView(kind, ledgers, meSid, now, priors[kind])
    if (v) raw[kind] = v
  }

  const next: Priors = { ...priors }
  const five = raw.five_hour
  const week = raw.seven_day
  if (five?.ownK) next.five_hour = { k: five.ownK }
  if (week?.ownK) next.seven_day = { k: week.ownK }
  if (five?.ownK && week?.ownK) {
    next.ratio = week.ownK / five.ownK
    // The relative errors of a quotient add up.
    next.ratioErrorPct = (five.errorPct ?? 0) + (week.errorPct ?? 0)
  }

  // The weekly meter moves slowly; until it has evidence of its own, borrow
  // the 5-hour calibration through the ratio the two windows last showed.
  if (week && five && week.confidence !== 'good' && five.confidence === 'good' && next.ratio) {
    week.k = (five.k ?? 0) * next.ratio
    week.confidence = 'low'
    week.errorPct = Math.min(100, (five.errorPct ?? 0) + (next.ratioErrorPct ?? 100))
    week.isBorrowed = true
    const dur = WINDOWS.seven_day
    const shares = ledgers.map(l => ({ l, usd: costIn(l.cost, week.resetAt - dur, now) }))
    fill(week, shares, meSid, shares.reduce((s, x) => s + x.usd, 0))
  }

  const windows: WindowView[] = []
  for (const v of [five, week]) {
    if (!v) continue
    const { ownK: _ownK, ...rest } = v
    windows.push(rest)
  }

  return {
    view: {
      updatedAt: now,
      hasCost: !!me && me.cost.length > 0,
      totalUsd: me?.cost[me.cost.length - 1]?.[1] ?? 0,
      trackedSessions: ledgers.length,
      windows,
    },
    priors: next,
  }
}

/** The meter's rounding step: 1 when every reading is a whole percent. */
function meterStep(readings: number[]): number {
  return readings.every(p => Number.isInteger(p)) ? 1 : 0.1
}

function round(x: number, digits: number) {
  const f = 10 ** digits
  return Math.round(x * f) / f
}
