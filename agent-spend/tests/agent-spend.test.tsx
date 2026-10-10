// agent-spend's tests, run with `claude plugin test <mod folder>`.
//
// The test's `on` sits beneath the mod and stands in for Claude Code: it
// starts subagents (each gets an id from its tool call), lists agents, opens
// panes, and registers commands. The tests raise the session's events
// through `$`, as a session would.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, TurnCompleteReason, TurnUsage } from 'claude-code'

import { estimateUsd, formatTokens, priceFor } from '../hooks/register'

// A short pane (5 body rows): the tree is drawn whole and the pane scrolls.
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Agent spend',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
}

/**
 * Stands in for the engine. A spawned agent's id is `agent-<call id>` and
 * it runs on `spawnModel`. `listed` is what `$.agent.list()` answers.
 * `opened` records each pane id `$.ui.open` was asked for.
 */
function stubEngine(on: On) {
  const opened: string[] = []
  const listed: { id: string; type: string; description: string; status: 'running' }[] = []

  on('agent.spawn', ($, e) => ({ model: 'claude-fable-5-1', agentId: `agent-${e.tool_use_id}` }))
  on('agent.list', () => ({ value: listed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: undefined }
  })

  return { opened, listed }
}

async function spawn($: Engine, type: string, callId: string, description = `task ${callId}`) {
  await $.agent.spawn({
    tool_use_id: callId,
    prompt: 'Do the thing.',
    description,
    subagentType: type,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
}

function usage(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): TurnUsage {
  return {
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  }
}

/** Ends one turn of a subagent's loop with the given usage. */
async function finish($: Engine, callId: string, used?: TurnUsage, reason: Exclude<TurnCompleteReason, 'refusal'> = 'answer') {
  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: `turn-${callId}`,
    reason,
    agentId: `agent-${callId}`,
    ...(used === undefined ? {} : { usage: used }),
  })
}

/** Mounts the pane and returns its lines' text, top to bottom. */
async function drawPane($: Engine) {
  const ui = await $.ui.mount({
    plugin: 'agent-spend',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'agent-spend',
    viewport: { columns: 120, rows: 30 },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(text => text.text)
}

test('prices by longest prefix, leaves unknown models unpriced', () => {
  expect(priceFor('claude-opus-5-5')).toEqual([4.0, 20.0, 0.2])
  expect(priceFor('claude-opus-5-20260101')).toEqual([5.0, 25.0, 0.5])
  expect(priceFor('claude-haiku-5-5')).toBeUndefined()

  // 1M input at $10, 100k output at $50, 2M cache reads at $0.25, 100k
  // cache writes at 2 x $10.
  const usd = estimateUsd('claude-fable-5-1', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 100_000 })
  expect(Math.abs((usd ?? 0) - (10 + 5 + 0.5 + 2))).toBeLessThan(1e-9)

  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(12_345)).toBe('12.3k')
  expect(formatTokens(1_234_567)).toBe('1.2M')
})

test('an empty conversation says so', async ($, on) => {
  stubEngine(on)
  expect(await drawPane($)).toEqual(['No subagents yet this conversation.'])
})

test('rows show type, model, tokens, cost and status, against the session total', async ($, on) => {
  stubEngine(on)
  await spawn($, 'senior-fable', 'r1', 'Review review-gate')
  await spawn($, 'worker-sonnet', 'w1', 'Sweep logs')

  const running = await drawPane($)
  expect(running[1]).toMatch(/^senior-fable\s+fable-5-1\s+0\s+0\s+\$0\.00\s+running\s+Review review-gate$/)

  await finish($, 'r1', usage('claude-fable-5-1', 10_000, 4_000, 200_000, 20_000))
  await finish($, 'w1', usage('claude-sonnet-5-5', 5_000, 2_000, 0, 0))
  await $.session.measure({ changed: ['cost'], cost: { usd: 3.5 } } as never)

  const lines = await drawPane($)
  // fable: 10k x $10 + 20k x $20 + 200k x $0.25 + 4k x $50 = 0.1 + 0.4 + 0.05 + 0.2 = $0.75
  expect(lines[1]).toMatch(/^senior-fable\s+fable-5-1\s+230\.0k\s+4\.0k\s+\$0\.75\s+done\s+Review review-gate$/)
  // sonnet: 5k x $2 + 2k x $10 = 0.01 + 0.02 = $0.03
  expect(lines[2]).toMatch(/^worker-sonnet\s+sonnet-5-5\s+5\.0k\s+2\.0k\s+\$0\.03\s+done\s+Sweep logs$/)
  expect(lines).toContain("Subagents ≈ $0.78 of the session's $3.50 (Claude Code's figure, as of the last main turn).")
})

test('a continued agent adds up; an unpriced model shows "?"', async ($, on) => {
  stubEngine(on)
  await spawn($, 'scout-haiku', 's1')
  await finish($, 's1', usage('claude-haiku-5-5', 1_000, 1_000))
  await finish($, 's1', usage('claude-haiku-5-5', 1_000, 1_000), 'aborted')

  const lines = await drawPane($)
  expect(lines[1]).toMatch(/^scout-haiku\s+haiku-5-5\s+2\.0k\s+2\.0k\s+\?\s+stopped/)
  expect(lines).toContain("Subagents ≈ $0.00 + unpriced of the session's unknown yet (Claude Code's figure, as of the last main turn).")
})

test('an agent spawned before the mod loaded is named from the agent list', async ($, on) => {
  const engine = stubEngine(on)
  engine.listed.push({ id: 'agent-old', type: 'Explore', description: 'Find callers', status: 'running' })

  await finish($, 'old', usage('claude-sonnet-5-5', 1_000, 0), 'error')
  expect((await drawPane($))[1]).toMatch(/^Explore\s+sonnet-5-5\s+1\.0k\s+0\s+\$0\.00\s+failed\s+Find callers$/)
})

test('a /clear starts the list over', async ($, on) => {
  stubEngine(on)
  await spawn($, 'senior-fable', 'r1')
  await finish($, 'r1', usage('claude-fable-5-1', 1_000, 1_000))

  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
  expect(await drawPane($)).toEqual(['No subagents yet this conversation.'])
})

test('/agent-spend opens the pane and sums up', async ($, on) => {
  const engine = stubEngine(on)
  await $.session.start({ cwd: 'C:/Users/me/Documents', surface: 'terminal', isInteractive: true })
  await spawn($, 'reviewer-opus', 'o1')
  await finish($, 'o1', usage('claude-opus-5-5', 100_000, 10_000))

  const ran = await $.command.run({
    command: 'agent-spend',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(engine.opened).toEqual(['agent-spend'])
  expect(ran.text).toBe('Agent spend pane opened: 1 subagent, ≈ $0.60.')
})

test('a turn that ends before its spawn is recorded keeps its tokens', async ($, on) => {
  stubEngine(on)
  await finish($, 'r1', usage('claude-fable-5-1', 2_000, 1_000))
  await spawn($, 'senior-fable', 'r1', 'Quick check')

  expect((await drawPane($))[1]).toMatch(/^senior-fable\s+fable-5-1\s+2\.0k\s+1\.0k\s+\$0\.07\s+done\s+Quick check$/)
})

test('a short pane still gets every row', async ($, on) => {
  stubEngine(on)
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await spawn($, 'Explore', id)
  }
  const lines = await drawPane($)
  expect(lines.filter(text => text.startsWith('Explore'))).toHaveLength(6)
  expect(lines[0]).toMatch(/^agent\s+model/)
})

test('/agent-spend names an unpriced model in its summary', async ($, on) => {
  stubEngine(on)
  await spawn($, 'scout-haiku', 'h1')
  await finish($, 'h1', usage('claude-haiku-5-5', 1_000, 100))

  const ran = await $.command.run({
    command: 'agent-spend',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toBe('Agent spend pane opened: 1 subagent, ≈ $0.00 + unpriced.')
})
