// review-gate's tests, run with `claude plugin test <mod folder>`.
//
// The test's `on` sits beneath the mod and stands in for Claude Code: it
// answers the edit tools, starts subagents (each gets an id from its tool
// call), and records what the mod attaches to the user's prompts. The tests
// raise the session's events through `$`, as a session would.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteReason } from 'claude-code'

import { isDbPath, isExempt, isLoaded } from '../hooks/register'

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const SRC = 'C:/Users/me/Desktop/my-app/src'

/**
 * Stands in for the engine. A Write whose content is 'staged' is held for
 * review (the file is unchanged). A spawned agent's id is `agent-<call id>`.
 * `context` records the context lines each prompt reached the engine with.
 */
function stubEngine(on: On) {
  const context: string[][] = []
  const toasts: string[] = []
  // The plugin's store, kept between sessions, and the session's root.
  // `session.storeFails` makes every store call fail, as a broken disk would.
  const store = new Map<string, unknown>()
  const session = { root: 'C:\\Users\\me\\Desktop\\my-app', storeFails: false }

  on('store.get', ($, e) => (session.storeFails ? { deny: 'disk error' } : { value: store.get(e.key) }))
  on('store.set', ($, e) => {
    if (session.storeFails) {
      return { deny: 'disk error' }
    }
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    if (session.storeFails) {
      return { deny: 'disk error' }
    }
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.root', () => ({ value: session.root }))

  on('tool.call', { tool: 'Write' }, ($, e) => ({
    result: {
      type: 'update',
      filePath: e.file_path,
      content: e.content,
      structuredPatch: [],
      originalFile: '',
      staged: e.content === 'staged',
    },
  }))
  on('agent.spawn', ($, e) => ({ model: 'claude-fable-5-1', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    context.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })

  return { context, toasts, store, session }
}

async function edit($: Engine, path: string, content = 'x') {
  await $.tool.call({ tool: 'Write', file_path: path, content })
}

/** Starts a subagent of `type`; its agent id is `agent-<callId>`. */
async function spawn($: Engine, type: string, callId: string) {
  await $.agent.spawn({
    tool_use_id: callId,
    prompt: 'Review the change.',
    description: 'review',
    subagentType: type,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
}

/** Ends a subagent's run (its one turn). */
async function finish($: Engine, callId: string, reason: Exclude<TurnCompleteReason, 'refusal'> = 'answer') {
  await $.turn.complete({
    answer: 'Looks fine.',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: `turn-${callId}`,
    reason,
    agentId: `agent-${callId}`,
  })
}

async function drawBand($: Engine, props = BAND_PROPS) {
  const ui = await $.ui.mount({ plugin: 'review-gate', surface: 'terminal', component: 'AbovePrompt', props })
  const line = await ui.find({ type: 'Text', text: /^Review gate/ })
  const beneath = await ui.find({ type: 'Box', key: 'engine-band' })
  await ui.unmount()
  return { line, beneath }
}

async function runCommand($: Engine, args: string) {
  return $.command.run({
    command: 'review-gate',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

test('database paths follow the database globs; notes, vaults and scratch are exempt', () => {
  expect(isDbPath(`${SRC}/migrations/001_init.py`)).toBe(true)
  expect(isDbPath('C:\\code\\app\\Models\\User.cs')).toBe(true)
  expect(isDbPath(`${SRC}/queries/report.sql`)).toBe(true)
  expect(isDbPath(`${SRC}/schema.prisma`)).toBe(true)
  expect(isDbPath(`${SRC}/UserRepository.ts`)).toBe(true)
  expect(isDbPath(`${SRC}/schemas/user.ts`)).toBe(false)
  expect(isDbPath(`${SRC}/game/player.cpp`)).toBe(false)

  expect(isExempt(`${SRC}/README.md`)).toBe(true)
  expect(isExempt('C:/Users/me/Documents/Obsidian Docs/MyApp/01 Overview/plan.canvas')).toBe(true)
  expect(isExempt('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\x\\scratchpad\\fix.py')).toBe(true)
  expect(isExempt(`${SRC}/main.py`)).toBe(false)
})

test('draws nothing until code is edited', async ($, on) => {
  stubEngine(on)
  await edit($, `${SRC}/NOTES.md`)

  const { line, beneath } = await drawBand($)
  expect(line).toBeUndefined()
  expect(beneath).toBeDefined()
})

test('lists unreviewed files once each, amber when idle and dim mid-turn', async ($, on) => {
  stubEngine(on)
  for (const name of ['a.py', 'b.py', 'a.py', 'c.py', 'd.py']) {
    await edit($, `${SRC}/${name}`)
  }

  const idle = (await drawBand($)).line
  expect(idle?.text).toBe('Review gate: 4 files unreviewed (b.py, a.py, c.py +1 more)')
  expect(idle?.props).toMatchObject({ color: 'warning' })

  const working = (await drawBand($, { ...BAND_PROPS, isWorking: true })).line
  expect(working?.props).toMatchObject({ dimColor: true })
})

test('a finished review clears what was edited before it started, not after', async ($, on) => {
  stubEngine(on)
  await edit($, `${SRC}/a.py`)
  await edit($, `${SRC}/b.py`)

  await spawn($, 'senior-fable', 'r1')
  await edit($, `${SRC}/b.py`) // changed again while the review runs
  const during = (await drawBand($)).line
  expect(during?.text).toBe('Review gate: 2 files unreviewed (a.py, b.py) · review running')
  expect(during?.props).toMatchObject({ dimColor: true })

  await finish($, 'r1')
  expect((await drawBand($)).line?.text).toBe('Review gate: 1 file unreviewed (b.py)')
})

test('an interrupted review clears nothing; a non-reviewer agent never counts', async ($, on) => {
  stubEngine(on)
  await edit($, `${SRC}/a.py`)

  await spawn($, 'reviewer-opus', 'r1')
  await finish($, 'r1', 'aborted')
  await spawn($, 'worker-sonnet', 'w1')
  await finish($, 'w1')

  expect((await drawBand($)).line?.text).toBe('Review gate: 1 file unreviewed (a.py)')
})

test('database files wait for db-adversarial-reviewer alone, in red', async ($, on) => {
  stubEngine(on)
  await edit($, `${SRC}/migrations/002_scores.sql`)
  await edit($, `${SRC}/game/score.py`)

  await spawn($, 'senior-fable', 'r1')
  await finish($, 'r1')
  const after = (await drawBand($)).line
  expect(after?.text).toBe('Review gate: 1 DB file await db-adversarial-reviewer (002_scores.sql)')
  expect(after?.props).toMatchObject({ color: 'error' })

  await spawn($, 'db-adversarial-reviewer', 'd1')
  await finish($, 'd1')
  expect((await drawBand($)).line).toBeUndefined()
})

test('a held (staged) write is not an edit', async ($, on) => {
  stubEngine(on)
  await edit($, `${SRC}/a.py`, 'staged')
  expect((await drawBand($)).line).toBeUndefined()
})

test("the user's prompt carries a note for the model while files wait", async ($, on) => {
  const engine = stubEngine(on)

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(engine.context.at(-1)).toEqual([])

  await edit($, `${SRC}/a.py`)
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(engine.context.at(-1)?.[0]).toBe(`Review gate (review-gate mod): edited since the last finished review: ${SRC}/a.py.`)

  // A task notification isn't the user talking; it gets no note.
  await $.prompt.submit({ text: '<task-notification/>', wait: false, origin: { kind: 'task-notification' } })
  expect(engine.context.at(-1)).toEqual([])
})

test('/review-gate lists the files; /review-gate clear marks them reviewed', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: SRC, surface: 'terminal', isInteractive: true })
  await edit($, `${SRC}/a.py`)
  await edit($, `${SRC}/models/user.py`)

  const listing = await runCommand($, '')
  expect(listing.text).toBe(`Unreviewed:\n  ${SRC}/a.py\nAwaiting db-adversarial-reviewer:\n  ${SRC}/models/user.py`)

  const cleared = await runCommand($, 'clear')
  expect(cleared.text).toBe('Review gate cleared (2 files marked reviewed).')
  expect((await drawBand($)).line).toBeUndefined()
})

test('db-adversarial-reviewer leaves ordinary files pending; a Sonnet reviewer clears nothing', async ($, on) => {
  stubEngine(on)
  await edit($, `${SRC}/game/score.py`)
  await edit($, `${SRC}/prisma/schema.prisma`)

  await spawn($, 'db-adversarial-reviewer', 'd1')
  await finish($, 'd1')
  await spawn($, 'feature-dev:code-reviewer', 'c1')
  await finish($, 'c1')
  expect((await drawBand($)).line?.text).toBe('Review gate: 1 file unreviewed (score.py)')
})

test('edits landing at once are all counted', async ($, on) => {
  stubEngine(on)
  await Promise.all(['a', 'b', 'c', 'd'].map(name => edit($, `${SRC}/${name}.py`)))
  expect((await drawBand($)).line?.text).toBe('Review gate: 4 files unreviewed (a.py, b.py, c.py +1 more)')
})

test('a /clear with files waiting raises a toast', async ($, on) => {
  const engine = stubEngine(on)
  await $.session.end({ reason: 'clear', sessionId: 's0', resume: { id: 's0' } })
  expect(engine.toasts).toEqual([])

  await edit($, `${SRC}/a.py`)
  await edit($, `${SRC}/models/user.py`)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(engine.toasts).toEqual(['Cleared with 2 files (1 database) edited and not reviewed.'])
})

const KEY = 'gate:C:/Users/me/Desktop/my-app'

test('the list is saved per project, and an empty list leaves no key', async ($, on) => {
  const engine = stubEngine(on)
  await edit($, `${SRC}/a.py`)
  await edit($, `${SRC}/migrations/001.sql`)
  expect(engine.store.get(KEY)).toEqual({
    seq: 2,
    pending: {
      [`${SRC}/a.py`]: { path: `${SRC}/a.py`, seq: 1, isDb: false },
      [`${SRC}/migrations/001.sql`]: { path: `${SRC}/migrations/001.sql`, seq: 2, isDb: true },
    },
  })

  await spawn($, 'senior-fable', 'r1')
  await finish($, 'r1')
  expect(Object.keys((engine.store.get(KEY) as { pending: object }).pending)).toEqual([`${SRC}/migrations/001.sql`])

  await runCommand($, 'clear')
  expect(engine.store.has(KEY)).toBe(false)
})

test('after a restart the saved list is back, and the counter carries on', async ($, on) => {
  const engine = stubEngine(on)
  // What an earlier process saved: two files, the counter at 7.
  engine.store.set(KEY, {
    seq: 7,
    pending: {
      [`${SRC}/a.py`]: { path: `${SRC}/a.py`, seq: 6, isDb: false },
      [`${SRC}/b.py`]: { path: `${SRC}/b.py`, seq: 7, isDb: false },
      bad: { path: 42 },
    },
  })
  await $.session.start({ cwd: SRC, surface: 'terminal', isInteractive: true })
  expect((await drawBand($)).line?.text).toBe('Review gate: 2 files unreviewed (a.py, b.py)')

  // A new edit numbers after the saved ones, so a reviewer spawned now
  // covers the saved files and not the edit made after it started.
  await spawn($, 'reviewer-opus', 'r1')
  await edit($, `${SRC}/c.py`)
  await finish($, 'r1')
  expect((await drawBand($)).line?.text).toBe('Review gate: 1 file unreviewed (c.py)')
  expect((engine.store.get(KEY) as { seq: number }).seq).toBe(8)
})

test('another project keeps its own list', async ($, on) => {
  const engine = stubEngine(on)
  engine.store.set('gate:D:/other', { seq: 1, pending: { 'D:/other/x.py': { path: 'D:/other/x.py', seq: 1, isDb: false } } })
  await $.session.start({ cwd: SRC, surface: 'terminal', isInteractive: true })
  expect((await drawBand($)).line).toBeUndefined()

  await edit($, `${SRC}/a.py`)
  expect(engine.store.has('gate:D:/other')).toBe(true)
  expect(engine.store.has(KEY)).toBe(true)
})

test('a store that fails never breaks the gate', async ($, on) => {
  const engine = stubEngine(on)
  engine.session.storeFails = true
  await edit($, `${SRC}/a.py`)
  expect((await drawBand($)).line?.text).toBe('Review gate: 1 file unreviewed (a.py)')
})

test('a gate kept from 0.1.0 through a hot reload (no root field) counts as not loaded', () => {
  // `$.state` survives a hot reload, so after the upgrade the old value has
  // no `root` at all; treating that as loaded would save under 'gate:undefined'.
  expect(isLoaded({ seq: 1, pending: {}, reviewers: {} } as { root?: unknown })).toBe(false)
  expect(isLoaded({ root: null })).toBe(false)
  expect(isLoaded({ root: 'C:/Users/me/Desktop/my-app' })).toBe(true)
})
