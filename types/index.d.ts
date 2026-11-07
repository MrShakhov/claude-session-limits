export type Confidence = 'good' | 'low' | 'none'

export type SessionShare = {
  sid: string
  label: string
  /** Estimated percent of the window this session used. */
  pct: number | null
  /** API-priced cost inside the window, USD. */
  usd: number
  isMe: boolean
}

export type WindowView = {
  kind: 'five_hour' | 'seven_day'
  /** The account meter as the freshest response reported it. */
  accountPct: number
  resetAt: number
  /** True once resetAt has passed and no fresh reading has arrived. */
  isStale: boolean
  /** Estimated percent points per USD of API-priced cost. */
  k: number | null
  confidence: Confidence
  /** Meter points the calibration rests on. */
  evidencePts: number
  /** Relative error of the estimate, in percent of it (±). */
  errorPct: number | null
  /** Whether k was borrowed from the other window through the stored ratio. */
  isBorrowed: boolean
  minePct: number | null
  othersPct: number | null
  /** Meter points no tracked session accounts for. */
  untrackedPct: number | null
  mineUsd: number
  sessions: SessionShare[]
}

export type View = {
  updatedAt: number
  hasCost: boolean
  totalUsd: number
  trackedSessions: number
  windows: WindowView[]
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-limits': { view: Shaped<View | null> }
  }
}
