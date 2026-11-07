import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View, WindowView } from '../types'
import {
  WINDOWS,
  compute,
  isLedger,
  newLedger,
  recordCost,
  recordMeter,
  type Ledger,
  type Priors,
  type WindowKind,
} from './ledger'

const PANE = 'session-limits'
const TITLE = 'Лимиты сессии'
const POLL_MS = 30_000
/** Cells of each window's meter in the band above the prompt. */
const BAND_CELLS = 8
const STALE_FILE_MS = 8 * 24 * 3600_000
const MAX_FILES = 80
// Bumped when stored calibrations stop being trustworthy: 0.1.0 kept ones
// that rested on a single whole-percent step of the meter.
const PRIORS_KEY = 'priors-2'

const viewAtom = atom({ plugin: 'session-limits', key: 'view' } as const, null, {
  shape: 'view-1',
})

type Api = EngineInterface

/** The module's own working state; a reload starts it over from the file. */
const S: {
  ledger: Ledger | null
  dir: string | null
  hasCost: boolean
  running: Promise<void> | null
  isAgain: boolean
  /** The pane was placed once; a closed pane is not reopened unasked. */
  isPlaced: boolean
} = { ledger: null, dir: null, hasCost: false, running: null, isAgain: false, isPlaced: false }

/** Opens the pane once a surface can draw it; a session starts with none. */
async function openPane($: Api) {
  if (S.isPlaced) return
  try {
    if ((await $.session.surfaces()).length === 0) return
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (opened.isPlaced) S.isPlaced = true
  } catch {
    // No surface attached yet: session.attach tries again.
  }
}


/** Every session writes its own file in one folder all sessions share. */
// The API exposes no home directory: take the Claude config folder from the
// plugin's own path when it lies inside one, else the home from the path.
function sharedDir(root: string): string | null {
  const at = root.indexOf('/.claude/')
  if (at >= 0) return `${root.slice(0, at)}/.claude/session-limits/sessions`
  const home = /^\/(?:Users|home)\/[^/]+/.exec(root)?.[0]
  return home ? `${home}/.claude/session-limits/sessions` : null
}

async function init($: Api): Promise<Ledger> {
  const [sid, cwd, usage] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.usage(),
  ])
  S.dir = sharedDir($.plugin.root)
  const label = cwd.split('/').filter(Boolean).pop() ?? sid.slice(0, 8)
  if (S.dir) {
    try {
      const saved: unknown = JSON.parse(await $.fs.read(`${S.dir}/${sid}.json`))
      if (isLedger(saved)) return { ...saved, label }
    } catch {
      // No file yet: a fresh session.
    }
  }
  return newLedger(sid, label, usage.startedAt)
}

async function others($: Api, now: number, own: string): Promise<Ledger[]> {
  if (!S.dir) return []
  let entries
  try {
    entries = await $.fs.list(S.dir)
  } catch {
    return []
  }
  const fresh = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .filter(f => f.name !== `${own}.json` && now - f.mtimeMs < STALE_FILE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES)
  const read = await Promise.all(
    fresh.map(async f => {
      try {
        const x: unknown = JSON.parse(await $.fs.read(`${S.dir}/${f.name}`))
        return isLedger(x) ? x : null
      } catch {
        return null
      }
    }),
  )
  return read.filter((x): x is Ledger => x !== null)
}

/** One measurement at a time; a call during one asks for another after it. */
function tick($: Api): Promise<void> {
  if (S.running) {
    S.isAgain = true
    return S.running
  }
  S.running = (async () => {
    try {
      do {
        S.isAgain = false
        try {
          await measure($)
        } catch {
          // A failed reading is retried by the next poll.
        }
      } while (S.isAgain)
    } finally {
      S.running = null
    }
  })()
  return S.running
}

async function measure($: Api) {
  S.ledger ??= await init($)
  const l = S.ledger
  const now = await $.clock.now()
  const usage = await $.session.usage()
  let isChanged = false
  if (usage.cost) {
    S.hasCost = true
    isChanged = recordCost(l, now, usage.cost.usd) || isChanged
  }
  for (const rl of usage.rateLimits) {
    if (!(rl.kind in WINDOWS) || !rl.resetsAt) continue
    const resetAt = Date.parse(rl.resetsAt)
    if (Number.isNaN(resetAt)) continue
    isChanged = recordMeter(l, now, rl.kind as WindowKind, rl.percentUsed, resetAt) || isChanged
  }
  if (isChanged && S.dir) {
    try {
      await $.fs.write(`${S.dir}/${l.sid}.json`, JSON.stringify(l))
    } catch {
      S.dir = null
    }
  }

  const all = [l, ...(await others($, now, l.sid))]
  const priors = ((await $.store.get(PRIORS_KEY)) ?? {}) as Priors
  const result = compute(all, l.sid, now, priors)
  if (JSON.stringify(result.priors) !== JSON.stringify(priors)) {
    await $.store.set(PRIORS_KEY, result.priors)
  }
  const view: View = { ...result.view, hasCost: S.hasCost }
  if (!S.dir) view.note = 'Нет общей папки: видна только эта сессия.'
  else if (usage.rateLimits.length === 0)
    view.note = 'Лимиты подписки ещё не пришли в ответе API.'
  await update($, viewAtom, () => view)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'session-limits',
      description: 'Открыть панель: сколько 5-часового и недельного лимита ест эта сессия',
    })
    $.clock.every(POLL_MS, () => void tick($))
    void tick($)
    void openPane($)
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    void openPane($)
    return attached
  })

  on('session.measure', async ($, e, next) => {
    await tick($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await tick($)
    return next(e)
  })

  on('command.run', { command: 'session-limits' }, async $ => {
    void tick($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced ? 'Панель лимитов открыта.' : `Панель не открылась: ${opened.reason}`,
    }
  })

  // The app's own pane buttons (browser, files) take no plugin's: a band
  // above the prompt carries this session's share and the way back in. The
  // whole row is one press, so it reads as a chip, not a label and a button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Button, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const open = async () => {
      void tick($)
      await $.ui.open({ id: PANE, title: TITLE })
    }
    const windows = (view?.windows ?? []).filter(w => !w.isStale)
    const hasMeters = e.props.bodyColumns >= 56

    const meter = (w: WindowView) => {
      const mine = clamp(w.minePct ?? 0)
      const used = clamp(w.accountPct)
      const a = Math.min(BAND_CELLS, Math.round((mine / 100) * BAND_CELLS) || (mine > 0 ? 1 : 0))
      const b = Math.max(0, Math.min(BAND_CELLS - a, Math.round((used / 100) * BAND_CELLS) - a))
      return [
        <Text color="claude">{'━'.repeat(a)}</Text>,
        <Text color="inactive">{'━'.repeat(b)}</Text>,
        <Text dimColor>{'─'.repeat(BAND_CELLS - a - b)}</Text>,
      ]
    }

    const chip = (w: WindowView, i: number) => [
      i > 0 ? <Text dimColor>{'   '}</Text> : null,
      <Text dimColor>{w.kind === 'five_hour' ? '5 ч ' : 'неделя '}</Text>,
      ...(hasMeters ? [...meter(w), <Text>{' '}</Text>] : []),
      <Text color="claude" weight="semibold" tabular>
        {pct(w.minePct)}
      </Text>,
    ]

    return (
      <Button key="open-limits" plain onPress={open}>
        <Text weight="medium">{'Лимиты сессии  '}</Text>
        {windows.length > 0 ? (
          windows.flatMap(chip)
        ) : (
          <Text dimColor>{view ? 'ждём ответ API' : 'собираю данные…'}</Text>
        )}
        <Text dimColor>{'  ›'}</Text>
      </Button>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const width = Math.max(16, Math.min(32, (e.viewport?.columns ?? 36) - 2))

    if (!view) return <Text dimColor>Собираю данные…</Text>

    const row = (label: string, value: string, isStrong = false, color?: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={color}>{label}</Text>
        <Text weight={isStrong ? 'bold' : 'regular'} color={color}>
          {value}
        </Text>
      </Box>
    )

    const section = (w: WindowView) => {
      const title = w.kind === 'five_hour' ? '5 часов' : 'Неделя'
      const resets = w.isStale
        ? 'окно сброшено'
        : `сброс ${w.kind === 'five_hour' ? 'в ' + hhmm(w.resetAt) : dayTime(w.resetAt)}`
      const mine = clamp(w.minePct ?? 0)
      const other = clamp(w.othersPct ?? 0)
      const ext = clamp(Math.max(0, w.accountPct - mine - other))
      const cells = (x: number) => Math.round((x / 100) * width)
      const a = Math.min(width, cells(mine) || (mine > 0 ? 1 : 0))
      const b = Math.min(width - a, cells(other))
      const c = Math.min(width - a - b, cells(ext))
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text weight="semibold">{title}</Text>
            <Text dimColor>{`  ${resets}`}</Text>
          </Text>
          <Text>
            <Text color="claude">{'█'.repeat(a)}</Text>
            <Text color="suggestion">{'█'.repeat(b)}</Text>
            <Text color="warning">{'█'.repeat(c)}</Text>
            <Text dimColor>{'·'.repeat(Math.max(0, width - a - b - c))}</Text>
          </Text>
          {row('Эта сессия', pct(w.minePct), true, 'claude')}
          {row('Другие сессии', pct(w.othersPct), false, 'suggestion')}
          {row('Вне учёта', pct(w.untrackedPct), false, 'warning')}
          {row('Аккаунт всего', `${w.accountPct.toFixed(1)}%`)}
          <Text dimColor size="caption">
            {accuracy(w)}
          </Text>
        </Box>
      )
    }

    const five = view.windows.find(w => w.kind === 'five_hour')
    const list = (five?.sessions ?? []).slice(0, 6)

    return (
      <Box flexDirection="column">
        {view.windows.length === 0 && (
          <Text dimColor>Ждём первый ответ API с лимитами…</Text>
        )}
        {view.windows.map(section)}
        {list.length > 1 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text weight="semibold">Сессии в окне 5 ч</Text>
            {list.map(s =>
              row(
                `${s.isMe ? '• ' : '  '}${short(s.label, width - 8)}`,
                s.pct === null ? `$${s.usd.toFixed(2)}` : pct(s.pct),
                s.isMe,
              ),
            )}
          </Box>
        )}
        <Text dimColor size="caption">
          {view.hasCost
            ? `Сессия всего: $${view.totalUsd.toFixed(2)} по ценам API · сессий в учёте: ${view.trackedSessions}`
            : 'Стоимость сессии недоступна в этом окружении.'}
        </Text>
        {view.note && (
          <Text dimColor size="caption">
            {view.note}
          </Text>
        )}
        <Text dimColor size="caption">
          {`Обновлено в ${hhmm(view.updatedAt)}. Оценка: траты × калибровка %/$.`}
        </Text>
      </Box>
    )
  })
}

function clamp(x: number) {
  return Math.max(0, Math.min(100, x))
}

function pct(x: number | null): string {
  if (x === null) return '—'
  if (x < 0.005) return '0%'
  if (x < 0.01) return '<0.01%'
  return `≈${x < 1 ? x.toFixed(2) : x.toFixed(1)}%`
}

function accuracy(w: WindowView): string {
  if (w.confidence === 'none') return 'Калибровка: мало данных, точность появится по мере работы.'
  const error = w.errorPct === null ? '' : ` (±${w.errorPct}%)`
  if (w.isBorrowed) return `Калибровка: по 5-часовому окну${error}, неделя пока растёт мало.`
  if (w.confidence === 'good') return `Калибровка: точная${error}, по ${w.evidencePts.toFixed(0)} п.п. счётчика.`
  if (w.evidencePts === 0) return `Калибровка: по прошлым окнам${error}.`
  return `Калибровка: грубая${error}, по ${w.evidencePts.toFixed(0)} п.п. счётчика.`
}

function short(s: string, n: number) {
  const max = Math.max(6, n)
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function dayTime(ms: number) {
  const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
  return `${days[new Date(ms).getDay()]} ${hhmm(ms)}`
}
