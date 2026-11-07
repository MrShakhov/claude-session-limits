import { expect, test } from 'claude-code/testing'

import { compute, newLedger, recordCost, recordMeter, type Ledger } from '../hooks/ledger'

const H = 3600_000
const T0 = Date.UTC(2026, 10, 7, 9, 0)
const RESET5 = T0 + 5 * H
const RESET7 = T0 + 3 * 24 * H

// Two sessions spend at a true rate of 2 meter points per USD; every
// minute each records its cost and the meter its last response carried.
function run(opts: { externalAt?: number; externalPts?: number } = {}) {
  const a = newLedger('a', 'project-a', T0)
  const b = newLedger('b', 'project-b', T0)
  let usdA = 0
  let usdB = 0
  let external = 0
  for (let m = 1; m <= 120; m++) {
    const t = T0 + m * 60_000
    usdA += 0.03
    if (m % 2 === 0) usdB += 0.02
    if (opts.externalAt === m) external += opts.externalPts ?? 0
    const meter = Math.floor((2 * (usdA + usdB) + external) * 10) / 10
    for (const [l, usd] of [
      [a, usdA],
      [b, usdB],
    ] as [Ledger, number][]) {
      recordCost(l, t, usd)
      recordMeter(l, t, 'five_hour', meter, RESET5)
      recordMeter(l, t, 'seven_day', Math.floor(meter * 2) / 20, RESET7)
    }
  }
  return { a, b, usdA, usdB, now: T0 + 120 * 60_000 }
}

test('splits the 5-hour meter between parallel sessions by cost', () => {
  const { a, b, usdA, usdB, now } = run()
  const { view } = compute([a, b], 'a', now, {})
  const five = view.windows.find(w => w.kind === 'five_hour')!

  expect(five.confidence).toBe('good')
  expect(Math.abs(five.minePct! - 2 * usdA)).toBeLessThan(0.15)
  expect(Math.abs(five.othersPct! - 2 * usdB)).toBeLessThan(0.15)
  expect(five.untrackedPct!).toBeLessThan(0.15)
  expect(five.sessions.map(s => s.sid)).toEqual(['a', 'b'])
})

test('meter growth with no tracked spend counts as untracked', () => {
  const plain = run()
  // Between two readings nobody tracked spent anything, yet the meter rose.
  const a = plain.a
  const quiet = plain.now + 10 * 60_000
  const before = a.meter.filter(m => m[1] === 'five_hour').at(-1)![2]
  recordMeter(a, quiet, 'five_hour', before + 3, RESET5)

  const { view } = compute([a, plain.b], 'a', quiet, {})
  const five = view.windows.find(w => w.kind === 'five_hour')!

  expect(Math.abs(five.untrackedPct! - 3)).toBeLessThan(0.2)
  expect(Math.abs(five.minePct! - 2 * plain.usdA)).toBeLessThan(0.15)
})

test('the weekly window borrows the 5-hour calibration through the ratio', () => {
  const { a, b, usdA, now } = run()
  const priors = { ratio: 0.1, ratioErrorPct: 20 }
  const { view } = compute([a, b], 'a', now, priors)
  const week = view.windows.find(w => w.kind === 'seven_day')!

  expect(Math.abs(week.minePct! - 0.2 * usdA)).toBeLessThan(0.05)
})

test('a host cost total that drops keeps the ledger monotonic', () => {
  const l = newLedger('a', 'x', T0)
  recordCost(l, T0 + 60_000, 1.5)
  recordCost(l, T0 + 180_000, 0.25)

  expect(l.cost.at(-1)![1]).toBe(1.75)
})

test('one whole-percent step of the meter is a rough calibration, not a good one', () => {
  const a = newLedger('a', 'x', T0)
  for (let m = 1; m <= 60; m++) {
    const t = T0 + m * 60_000
    recordCost(a, t, m * 0.05)
    recordMeter(a, t, 'seven_day', m < 30 ? 27 : 28, RESET7)
  }
  const { view } = compute([a], 'a', T0 + 60 * 60_000, {})
  const week = view.windows.find(w => w.kind === 'seven_day')!

  expect(week.confidence).toBe('low')
  expect(week.errorPct).toBe(100)
})

test('a borrowed weekly figure carries the ratio error too', () => {
  const { a, b, now } = run()
  // Only the 5-hour window here: the weekly meter does not move.
  for (const l of [a, b]) l.meter = l.meter.filter(m => m[1] === 'five_hour')
  recordMeter(a, now, 'seven_day', 28, RESET7)
  const { view } = compute([a, b], 'a', now, { ratio: 0.1, ratioErrorPct: 20 })
  const five = view.windows.find(w => w.kind === 'five_hour')!
  const week = view.windows.find(w => w.kind === 'seven_day')!

  expect(week.isBorrowed).toBe(true)
  expect(week.errorPct).toBe(five.errorPct! + 20)
})
