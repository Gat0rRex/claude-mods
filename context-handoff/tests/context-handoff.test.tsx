// context-handoff's tests, run with `claude plugin test <mod folder>`.
//
// The test's `on` sits beneath the mod and stands in for Claude Code: it
// reports the context figure a test sets, answers one tool (a stand-in MCP
// tool, so no built-in output schema applies), records the context each
// prompt reaches the engine with, and records the instructions each
// compaction's summary is given. The tests raise the session's events through
// `$`, as a session would; `$`'s own dispatches come from the engine, as the
// model's tool calls do.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, SessionMessage } from 'claude-code'

import { handOffPromptNote, handOffToolNote, headsUpNote, levelOf, linesFor } from '../hooks/register'

const WINDOW = 1_000_000
const TOOL = 'mcp__lab__step'
const SUMMARY: SessionMessage = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

/**
 * Stands in for the engine. `usage.tokens` / `usage.window` are what
 * `$.session.usage()` reports. The stand-in tool refuses when its input says
 * `refuse`, and answers with an `existing` context entry when given one.
 * `prompts` records each prompt's context; `compactions` each summary's
 * instructions; `compact.skip` vetoes the next compactions.
 */
function stubEngine(on: On) {
  const usage: { tokens: number | undefined; window: number } = { tokens: undefined, window: WINDOW }
  const prompts: string[][] = []
  const compactions: (string | undefined)[] = []
  const compact: { skip: boolean; tokensBefore?: number } = { skip: false }

  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: usage.tokens, window: usage.window }, rateLimits: [] },
  }))
  on('tool.call', { tool: TOOL }, ($, e) => {
    const input = e as unknown as { refuse?: boolean; failed?: boolean; existing?: string }
    if (input.refuse === true) {
      return { deny: 'refused' }
    }
    if (input.failed === true) {
      return { result: 'failed', isError: true }
    }
    return input.existing === undefined ? { result: 'ok' } : { result: 'ok', context: [input.existing] }
  })
  on('prompt.submit', ($, e) => {
    prompts.push([...(e.context ?? [])])
    return { text: e.text }
  })
  on('session.compact', ($, e) => {
    compactions.push(e.instructions)
    return compact.skip ? { skip: 'vetoed' } : { messages: [SUMMARY], tokensBefore: compact.tokensBefore }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  return { usage, prompts, compactions, compact }
}

/** One main-loop tool call; resolves to the context entries the model reads after it. */
async function step($: Engine, extra: Record<string, unknown> = {}): Promise<readonly string[]> {
  const ran = await $.tool.call({ tool: TOOL, ...extra } as never)
  return (ran as { context?: readonly string[] }).context ?? []
}

/** Submits a prompt from `kind`; the context it reached the engine with is the stub's last `prompts` entry. */
async function prompt($: Engine, kind: PromptOrigin['kind'] = 'composer') {
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind } as PromptOrigin } as never)
}

const isNote = (line: string) => line.startsWith('Context hand-off (context-handoff mod):')

test('the lines are 250k and 300k, scaled to 70% and 80% of a small window', () => {
  expect(linesFor(1_000_000)).toEqual({ headsUp: 250_000, handOff: 300_000 })
  expect(linesFor(200_000)).toEqual({ headsUp: 140_000, handOff: 160_000 })
  expect(levelOf(249_999, 1_000_000)).toBe('none')
  expect(levelOf(250_000, 1_000_000)).toBe('heads-up')
  expect(levelOf(300_000, 1_000_000)).toBe('hand-off')
  expect(levelOf(150_000, 200_000)).toBe('heads-up')
  expect(levelOf(170_000, 200_000)).toBe('hand-off')
})

test('the notes carry the figures and point at the skill', () => {
  expect(headsUpNote(262_000, WINDOW)).toBe(
    'Context hand-off (context-handoff mod): 262k of 1M held; heads-up line 250k, hand-off line 300k. Carry on; plan to hand off (context-handoff skill) when this task is done.',
  )
  expect(handOffToolNote(312_000, WINDOW)).toBe(
    "Context hand-off (context-handoff mod): 312k held, past the 300k hand-off line. Finish the task you're on, then follow the context-handoff skill; don't start another.",
  )
  expect(handOffPromptNote(312_000, WINDOW)).toMatch(/If it is new work, don't start it: write the checkpoint, hand off, and list it under Next\.$/)
})

test('no figure means no note', async ($, on) => {
  stubEngine(on)

  expect(await step($)).toEqual([])
  await prompt($)
})

test('each line is noted once after a tool call, with no repeats', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 100_000
  expect(await step($)).toEqual([])

  engine.usage.tokens = 255_000
  const headsUp = await step($)
  expect(headsUp).toEqual([headsUpNote(255_000, WINDOW)])
  engine.usage.tokens = 270_000
  expect(await step($)).toEqual([])

  engine.usage.tokens = 305_000
  expect(await step($)).toEqual([handOffToolNote(305_000, WINDOW)])
  engine.usage.tokens = 400_000
  expect(await step($)).toEqual([])
})

test('jumping straight past both lines notes only the hand-off', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 320_000
  expect(await step($)).toEqual([handOffToolNote(320_000, WINDOW)])
  expect(await step($)).toEqual([])
})

test('every prompt past the hand-off line carries the note', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 310_000
  await prompt($)
  await prompt($, 'bridge')
  expect(engine.prompts).toEqual([[handOffPromptNote(310_000, WINDOW)], [handOffPromptNote(310_000, WINDOW)]])
  // The prompt told the model already, so the next tool call stays quiet.
  expect(await step($)).toEqual([])
})

test('a prompt notes the heads-up line once, shared with the tool calls', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 260_000
  await prompt($)
  await prompt($)
  expect(engine.prompts).toEqual([[headsUpNote(260_000, WINDOW)], []])
  expect(await step($)).toEqual([])
})

test("a background task's notification gets no note", async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 310_000
  await prompt($, 'task-notification')
  expect(engine.prompts).toEqual([[]])
})

test("a subagent's tool calls get no note", async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 310_000
  expect(await step($, { agentId: 'a1' })).toEqual([])
  // The main loop still hears about it.
  expect(await step($)).toEqual([handOffToolNote(310_000, WINDOW)])
})

test('parallel tool calls crossing a line together carry one note', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  const results = await Promise.all([step($), step($), step($)])
  expect(results.flat().filter(isNote)).toEqual([handOffToolNote(305_000, WINDOW)])
})

test('a refused call gets no note, and the line waits for the next call', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  const refused = await $.tool.call({ tool: TOOL, refuse: true } as never)
  expect((refused as { deny?: string }).deny).toBe('refused')
  expect((refused as { context?: unknown }).context).toBeUndefined()
  expect(await step($)).toEqual([handOffToolNote(305_000, WINDOW)])
})

test('a note is appended after existing context, never in its place', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  expect(await step($, { existing: 'from beneath' })).toEqual(['from beneath', handOffToolNote(305_000, WINDOW)])

  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' }, context: ['mine'] } as never)
  expect(engine.prompts).toEqual([['mine', handOffPromptNote(305_000, WINDOW)]])
})

test('a /compact re-arms both lines', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  expect(await step($)).toHaveLength(1)
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(engine.compactions).toEqual([undefined])

  engine.usage.tokens = 260_000
  expect(await step($)).toEqual([headsUpNote(260_000, WINDOW)])
})

test('a vetoed /compact re-arms nothing', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  engine.compact.skip = true
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(await step($)).toEqual([])
})

test('an auto-compaction keeps the hand-off due', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  expect(engine.compactions[0]).toMatch(/passed the context hand-off line before compacting/)

  // Right after the compaction there is no figure yet: nothing to say.
  engine.usage.tokens = undefined
  expect(await step($)).toEqual([])
  // The first figure after it brings the note back, once.
  engine.usage.tokens = 40_000
  const again = await step($)
  expect(again).toEqual([handOffToolNote(40_000, WINDOW)])
  expect(again[0]).toMatch(/passed the 300k hand-off line before it compacted/)
  expect(await step($)).toEqual([])

  // Every prompt still carries it, and the heads-up line can't fire under it.
  await prompt($)
  expect(engine.prompts[0]?.[0]).toMatch(/before it compacted\. If this message belongs/)
  engine.usage.tokens = 260_000
  expect(await step($)).toEqual([])
})

test('an auto-compaction keeps instructions already given', async ($, on) => {
  const engine = stubEngine(on)

  await $.session.compact({ trigger: 'auto', messages: [SUMMARY], instructions: 'keep the plan' })
  expect(engine.compactions[0]).toMatch(/^keep the plan\n\nThis session passed/)
})

test("precompute and a subagent's compaction change nothing", async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY], agentId: 'a1' })
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY], agentId: 'a1' })
  expect(engine.compactions).toEqual([undefined, undefined, undefined])
  expect(await step($)).toEqual([])
})

test('a /clear re-arms both lines and drops a carried hand-off', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })

  engine.usage.tokens = 20_000
  expect(await step($)).toEqual([])
  await prompt($)
  expect(engine.prompts).toEqual([[]])
})

test('a small window scales the lines down', async ($, on) => {
  const engine = stubEngine(on)
  engine.usage.window = 200_000

  engine.usage.tokens = 145_000
  expect(await step($)).toEqual([headsUpNote(145_000, 200_000)])
  expect(headsUpNote(145_000, 200_000)).toMatch(/heads-up line 140k, hand-off line 160k/)
  engine.usage.tokens = 171_000
  expect(await step($)).toEqual([handOffToolNote(171_000, 200_000)])
})

test('a compaction under the hand-off line re-arms, with or without the engine\'s size', async ($, on) => {
  const engine = stubEngine(on)

  // The engine's own size before it, under the line.
  engine.usage.tokens = 255_000
  expect(await step($)).toEqual([headsUpNote(255_000, WINDOW)])
  engine.compact.tokensBefore = 262_000
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  expect(engine.compactions).toEqual([undefined])
  expect(await step($)).toEqual([headsUpNote(255_000, WINDOW)])

  // No size recorded: the last response's figure decides.
  engine.compact.tokensBefore = undefined
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  expect(await step($)).toEqual([headsUpNote(255_000, WINDOW)])
  await prompt($)
  expect(engine.prompts).toEqual([[]])
})

test("the engine's size before a compaction can carry the hand-off past the last figure", async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 290_000
  engine.compact.tokensBefore = 310_000
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  // Too late for the summary's instructions, but the next tool call repeats the note.
  expect(engine.compactions).toEqual([undefined])
  engine.usage.tokens = 30_000
  expect(await step($)).toEqual([handOffToolNote(30_000, WINDOW)])
})

test("a plugin's compaction past the line keeps the hand-off due, as the engine's does", async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  await $.session.compact({ trigger: 'plugin', messages: [SUMMARY] })
  expect(engine.compactions[0]).toMatch(/passed the context hand-off line before compacting/)
  engine.usage.tokens = 30_000
  expect(await step($)).toEqual([handOffToolNote(30_000, WINDOW)])
})

test('parallel tool calls after an auto-compaction repeat the note once', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  engine.usage.tokens = 30_000
  const results = await Promise.all([step($), step($), step($)])
  expect(results.flat().filter(isNote)).toEqual([handOffToolNote(30_000, WINDOW)])
})

test('a prompt after an auto-compaction covers the repeat, so the next tool call is quiet', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  await step($)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  engine.usage.tokens = undefined
  await prompt($)
  expect(engine.prompts[0]?.[0]).toMatch(/before it compacted\. If this message belongs/)
  engine.usage.tokens = 30_000
  expect(await step($)).toEqual([])
})

test('a tool that reported an error still carries the note', async ($, on) => {
  const engine = stubEngine(on)

  engine.usage.tokens = 305_000
  expect(await step($, { failed: true })).toEqual([handOffToolNote(305_000, WINDOW)])
})

// Not covered here: a call another plugin raised through `$.tool.call`
// (skipped by `next.origin`). The kit raises every `$` call as the engine, so
// it can't play another plugin's call; live check 1 covers it.
