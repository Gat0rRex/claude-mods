// context-band's tests, run with `claude plugin test <mod folder>`.
//
// How the kit works: each test gets the engine's real `$` and an `on` whose
// hooks sit *beneath* every plugin, standing in for Claude Code itself.
// Anything the mod asks of the engine (its usage figures, a toast, the
// engine's own band) has to be answered by a hook here, or the bottom of the
// chain throws and names the event it was missing.
//
// The tests raise engine events themselves through `$`: `$.session.measure`
// plays the engine's after-turn measurement, `$.session.compact` a /compact,
// `$.session.end` a /clear.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, RenderSurface, SessionMessage } from 'claude-code'

// What a surface passes when it draws the band: no survey, idle, room to spare.
const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const WINDOW = 1_000_000

// A compaction always leaves at least one message (the summary), and the
// engine refuses one that would leave none, so the stubs carry this one.
const SUMMARY: SessionMessage = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

/**
 * Stands in for the engine beneath the mod and hands back the knobs a test
 * turns: `usage.tokens` is what $.session.usage() reports (only the
 * session.start seed asks), `toasts` records every toast the mod raised.
 */
function stubEngine(on: On) {
  const usage: { tokens: number | undefined } = { tokens: undefined }
  const toasts: string[] = []

  // Calls a plugin makes on `$` (unlike engine events) are answered as
  // `{ value }` or `{ deny }`.
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: usage.tokens, window: WINDOW }, rateLimits: [] },
  }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // The engine's own answers to the events the mod passes on with next(e).
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: [SUMMARY] }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  // The engine's own band, drawn when the mod defers with next(e).
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })

  return { usage, toasts }
}

/** Plays the engine's after-turn measurement with the context at `tokens`. */
async function measure($: Engine, tokens: number | undefined) {
  await $.session.measure({ context: { tokens, window: WINDOW }, rateLimits: [], changed: ['context'] })
}

/** Mounts the band on a surface, reads the mod's line (if any), unmounts. */
async function drawBand($: Engine, surface: RenderSurface = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: BAND_PROPS })
  // The mod's line is the one Text that starts with "Context "; the engine's
  // stand-in band has no text at all.
  const line = await ui.find({ type: 'Text', text: /^Context / })
  await ui.unmount()
  return line
}

test('draws nothing of its own before the first response', async ($, on) => {
  stubEngine(on)

  expect(await drawBand($)).toBeUndefined()
})

test('climbs calm -> warn -> over, toasting once per line crossed', async ($, on) => {
  const engine = stubEngine(on)

  await measure($, 40_000)
  const calm = await drawBand($)
  expect(calm?.text).toBe('Context 40k / 1M (4%)')
  expect(engine.toasts).toHaveLength(0)

  await measure($, 160_000)
  const warn = await drawBand($)
  expect(warn?.text).toMatch(/plan a \/compact before 200k/)
  expect(warn?.props).toMatchObject({ color: 'warning' })
  expect(engine.toasts).toHaveLength(1)

  // Still in the warn tier: no second toast.
  await measure($, 170_000)
  expect(engine.toasts).toHaveLength(1)

  await measure($, 210_000)
  const over = await drawBand($)
  expect(over?.props).toMatchObject({ color: 'error' })
  expect(engine.toasts).toHaveLength(2)
})

test('a compaction hides the band until the next measurement, and re-arms the toasts', async ($, on) => {
  const engine = stubEngine(on)

  await measure($, 210_000)
  expect(engine.toasts).toHaveLength(1)

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(await drawBand($)).toBeUndefined()

  await measure($, 30_000)
  expect((await drawBand($))?.text).toBe('Context 30k / 1M (3%)')

  // Climbing past 150k again warns again.
  await measure($, 155_000)
  expect(engine.toasts).toHaveLength(2)
})

test('a precompute does not clear the reading', async ($, on) => {
  stubEngine(on)

  await measure($, 90_000)
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })

  expect((await drawBand($))?.text).toBe('Context 90k / 1M (9%)')
})

test('a /clear hides the band', async ($, on) => {
  stubEngine(on)

  await measure($, 90_000)
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })

  expect(await drawBand($)).toBeUndefined()
})

test('a measurement where only the rate limits moved leaves the band alone', async ($, on) => {
  const engine = stubEngine(on)

  await measure($, 40_000)
  await $.session.measure({
    context: { tokens: 300_000, window: WINDOW },
    rateLimits: [],
    changed: ['rateLimits'],
  })

  expect((await drawBand($))?.text).toBe('Context 40k / 1M (4%)')
  expect(engine.toasts).toHaveLength(0)
})

test('a measurement with no token figure hides the band', async ($, on) => {
  stubEngine(on)

  await measure($, 90_000)
  await measure($, undefined)

  expect(await drawBand($)).toBeUndefined()
})

test('session.start seeds the band from the current usage', async ($, on) => {
  const engine = stubEngine(on)
  engine.usage.tokens = 120_000

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })

  expect((await drawBand($))?.text).toBe('Context 120k / 1M (12%)')
})

test('draws the same line on the terminal and in the desktop app', async ($, on) => {
  stubEngine(on)
  await measure($, 160_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    expect((await drawBand($, surface))?.text).toMatch(/^Context 160k \/ 1M \(16%\)/)
  }
})

// ---------------------------------------------------------------------------
// Cost and usage windows (added in 0.2.0)
// ---------------------------------------------------------------------------

/** Plays a measurement where only the cost and usage windows moved. */
async function measureSpend($: Engine, usd: number, limits: { kind: string; percentUsed: number }[]) {
  await $.session.measure({
    context: { tokens: undefined, window: WINDOW },
    cost: { usd },
    rateLimits: limits,
    changed: ['cost', 'rateLimits'],
  })
}

/** Mounts the band and reads the spend line (the one under the context line). */
async function drawSpend($: Engine) {
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const line = await ui.find({ type: 'Text', text: /^(Cost|Usage) / })
  await ui.unmount()
  return line
}

test('puts the cost and usage windows on their own line under the context', async ($, on) => {
  stubEngine(on)

  await measure($, 40_000)
  await measureSpend($, 1.234, [{ kind: 'five_hour', percentUsed: 23 }, { kind: 'seven_day', percentUsed: 41.5 }])

  expect((await drawBand($))?.text).toBe('Context 40k / 1M (4%)')
  expect((await drawSpend($))?.text).toBe('Cost $1.23 · 5h 23% · 7d 41.5%')

  // Before the cost reaches half a cent the line leads with the windows.
  await measureSpend($, 0, [{ kind: 'five_hour', percentUsed: 5 }])
  expect((await drawSpend($))?.text).toBe('Usage 5h 5%')
})

test('a compaction hides the context part but keeps the cost', async ($, on) => {
  stubEngine(on)

  await measure($, 90_000)
  await measureSpend($, 2, [])
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const line = await ui.find({ type: 'Text', text: /^Cost / })
  await ui.unmount()
  expect(line?.text).toBe('Cost $2.00')
})

test('a usage window toasts once per line and colours the band', async ($, on) => {
  const engine = stubEngine(on)
  await measure($, 40_000)

  await measureSpend($, 1, [{ kind: 'five_hour', percentUsed: 82 }])
  expect(engine.toasts).toEqual(['5h usage window at 82%.'])
  expect((await drawSpend($))?.props).toMatchObject({ color: 'warning' })
  // The context line keeps its own look: 40k is calm.
  expect((await drawBand($))?.props).toMatchObject({ dimColor: true })

  // Still past 80 but under 95: no second toast.
  await measureSpend($, 1, [{ kind: 'five_hour', percentUsed: 90 }])
  expect(engine.toasts).toHaveLength(1)

  await measureSpend($, 1, [{ kind: 'five_hour', percentUsed: 96 }])
  expect(engine.toasts).toHaveLength(2)
  expect((await drawSpend($))?.props).toMatchObject({ color: 'error' })

  // A /clear does not reset the account's window, so no repeat toast.
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
  await measureSpend($, 0, [{ kind: 'five_hour', percentUsed: 96 }])
  expect(engine.toasts).toHaveLength(2)

  // The window resets, then climbs again: it warns again.
  await measureSpend($, 0, [{ kind: 'five_hour', percentUsed: 3 }])
  await measureSpend($, 0, [{ kind: 'five_hour', percentUsed: 81 }])
  expect(engine.toasts).toHaveLength(3)
})

test('stacks above what the chain beneath draws instead of hiding it', async ($, on) => {
  stubEngine(on)
  await measure($, 40_000)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const beneath = await ui.find({ type: 'Box', key: 'engine-band' })
  await ui.unmount()
  expect(beneath).toBeDefined()
})
