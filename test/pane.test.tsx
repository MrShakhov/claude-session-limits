import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-limits',
  component: 'Pane',
  requestId: 'session-limits',
  props: {
    title: 'Лимиты сессии',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = Date.UTC(2026, 10, 7, 10, 0)
const OTHER = {
  v: 1,
  sid: 'other',
  label: 'project-b',
  rawUsd: 1,
  offset: 0,
  cost: [
    [NOW - 3600_000, 0],
    [NOW, 1],
  ],
  meter: [],
}

test('the pane shows this session and a parallel one', async ($, on) => {
  const files: Record<string, string> = {
    'other.json': JSON.stringify(OTHER),
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'session-limits' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/Users/x/Dev/project-a' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 3600_000,
      context: {} as never,
      cost: { usd: 3 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 8, resetsAt: new Date(NOW + 4 * 3600_000).toISOString() },
      ],
    },
  }))
  on('fs.read', (_, e) => {
    const text = files[e.path.split('/').pop()!]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path.split('/').pop()!] = e.text
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: Object.keys(files).map(name => ({
      name,
      kind: 'file',
      size: 1,
      mtimeMs: NOW,
      isLink: false,
    })),
  }))
  on('store.get', () => ({ value: { five_hour: { k: 2 } } }))
  on('store.set', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: {} as never, rateLimits: [], changed: ['cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, plugin: 'session-limits', surface })
    expect((await ui.find({ type: 'Text', text: /^5 часов/ }))?.text).toContain('5 часов')
    expect(await ui.find({ type: 'Text', text: /project-b/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$3\.00/ })).toBeTruthy()
    await ui.unmount()
  }
  expect(Object.keys(files)).toContain('me.json')
})

test('the band above the prompt shows the share and opens the pane', async ($, on) => {
  const opened: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'session-limits' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.surfaces', () => ({ value: [] }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/Users/x/Dev/project-a' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 3600_000,
      context: {} as never,
      cost: { usd: 3 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 8, resetsAt: new Date(NOW + 4 * 3600_000).toISOString() },
      ],
    },
  }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: { five_hour: { k: 2 } } }))
  on('store.set', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: {} as never, rateLimits: [], changed: ['cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-limits',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 60,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /^Эта сессия: 5 ч/ }))?.text).toContain('≈')
    await ui.press({ key: 'open-limits' })
    await ui.unmount()
  }
  expect(opened).toEqual(['session-limits', 'session-limits'])
})
