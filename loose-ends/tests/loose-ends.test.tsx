// loose-ends' tests, run with `claude plugin test <mod folder>`.
//
// The test's `on` sits beneath the mod and stands in for Claude Code: it
// answers the tools (Bash, TaskStop), the desktop app's MCP listings, and
// the engine's own events the mod passes on with next(e). The tests raise
// those events through `$`, as a session would.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/**
 * Stands in for the engine. `listing.tabs` / `listing.previews` are the text
 * the desktop app's MCP tools answer; `listing.isAbsent` makes both calls
 * fail, as outside the desktop app. `context` records what the mod attached
 * to a prompt for the model.
 */
function stubEngine(on: On) {
  const listing = { tabs: '[]', previews: '[]\n\nSession preview: {}', isAbsent: false }
  const context: string[][] = []

  on('mcp.call', ($, e) => {
    if (listing.isAbsent) {
      return { deny: 'no such server' }
    }
    const text = e.tool === 'list_terminal_tabs' ? listing.tabs : listing.previews
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => ({
    result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: e.run_in_background === true ? `bg-${e.command}` : undefined,
    },
  }))
  on('tool.call', { tool: 'TaskStop' }, ($, e) => ({
    result: { message: 'stopped', task_id: e.task_id ?? '', task_type: 'local_bash' },
  }))
  on('prompt.submit', ($, e) => {
    context.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })

  return { listing, context }
}

/** Plays the end of a main-loop turn (the mod re-lists tabs and servers). */
async function endTurn($: Engine) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

/** Mounts the band, reads this mod's line (if any), unmounts. */
async function drawBand($: Engine, props = BAND_PROPS) {
  const ui = await $.ui.mount({ plugin: 'loose-ends', surface: 'terminal', component: 'AbovePrompt', props })
  const line = await ui.find({ type: 'Text', text: /^Still running/ })
  const beneath = await ui.find({ type: 'Box', key: 'engine-band' })
  await ui.unmount()
  return { line, beneath }
}

test('draws nothing when nothing is running', async ($, on) => {
  stubEngine(on)
  await endTurn($)

  const { line, beneath } = await drawBand($)
  expect(line).toBeUndefined()
  expect(beneath).toBeDefined()
})

test('a background shell shows until TaskStop stops it', async ($, on) => {
  stubEngine(on)

  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const running = await drawBand($)
  expect(running.line?.text).toBe('Still running: shell "npm run dev"')
  expect(running.line?.props).toMatchObject({ color: 'warning' })
  expect(running.beneath).toBeDefined()

  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-npm run dev' })
  expect((await drawBand($)).line).toBeUndefined()
})

test('a completion notification clears the shell; a progress note does not', async ($, on) => {
  stubEngine(on)
  await $.tool.call({ tool: 'Bash', command: 'build', run_in_background: true })

  const progress = '<task-notification>\n<task-id>bg-build</task-id>\n<status>running</status>\n</task-notification>'
  await $.prompt.submit({ text: progress, wait: false, origin: { kind: 'task-notification' } })
  expect((await drawBand($)).line?.text).toBe('Still running: shell "build"')

  const done = '<task-notification>\n<task-id>bg-build</task-id>\n<status>completed</status>\n</task-notification>'
  await $.prompt.submit({ text: done, wait: false, origin: { kind: 'task-notification' } })
  expect((await drawBand($)).line).toBeUndefined()
})

test('lists only the terminal tabs Claude opened, and preview servers', async ($, on) => {
  const engine = stubEngine(on)
  engine.listing.tabs = JSON.stringify([
    { tab_id: '0', title: 'Terminal 1', opened_by: 'user' },
    { tab_id: 'c1', title: 'context-band trial', opened_by: 'claude' },
  ])
  engine.listing.previews = '[{"serverId":"s1","name":"web"}]\n\nSession preview: {"tabs": []}'
  await endTurn($)

  expect((await drawBand($)).line?.text).toBe('Still running: terminal "context-band trial" · preview "web"')

  // Both closed: the next turn's listing clears them.
  engine.listing.tabs = '[]'
  engine.listing.previews = '[]'
  await endTurn($)
  expect((await drawBand($)).line).toBeUndefined()
})

test('outside the desktop app the listings fail quietly', async ($, on) => {
  const engine = stubEngine(on)
  engine.listing.isAbsent = true
  await $.tool.call({ tool: 'Bash', command: 'serve', run_in_background: true })
  await endTurn($)

  expect((await drawBand($)).line?.text).toBe('Still running: shell "serve"')
})

test("the user's prompt carries a note for the model while something runs", async ($, on) => {
  const engine = stubEngine(on)

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(engine.context.at(-1)).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(engine.context.at(-1)?.[0]).toMatch(/^Still running from this session \(loose-ends mod\): shell "npm run dev"/)
})

test('dim while a turn runs, and names three then counts the rest', async ($, on) => {
  stubEngine(on)
  for (const command of ['a', 'b', 'c', 'd', 'e']) {
    await $.tool.call({ tool: 'Bash', command, run_in_background: true })
  }

  const { line } = await drawBand($, { ...BAND_PROPS, isWorking: true })
  expect(line?.text).toBe('Still running: shell "a" · shell "b" · shell "c" +2 more')
  expect(line?.props).toMatchObject({ dimColor: true })
})

test('a /clear forgets the shells; a subagent\'s shells are never listed', async ($, on) => {
  stubEngine(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  await $.tool.call({ tool: 'Bash', command: 'old', run_in_background: true })
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
  expect((await drawBand($)).line).toBeUndefined()

  // A shell raised from inside a subagent's loop carries its agentId.
  await $.tool.call({ tool: 'Bash', command: 'agent-shell', run_in_background: true, agentId: 'a1' } as never)
  expect((await drawBand($)).line).toBeUndefined()
})
