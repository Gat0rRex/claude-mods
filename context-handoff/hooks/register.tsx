// context-handoff: the hooks module.
//
// ROLE
// Tells the model when its context has grown large, so it finishes the task
// it is on and then hands off to a fresh session instead of starting another.
// A model can't see its own token count, so something has to tell it:
// context-band shows the figure to the person, this mod tells the model.
//
// Two lines, as constants below:
//   - the heads-up line (250k): carry on, and plan to hand off when this
//     task is done;
//   - the hand-off line (300k): finish the task you're on, then follow the
//     context-handoff skill (~/.claude/skills/context-handoff/SKILL.md);
//     don't start another.
// A note never asks the model to stop. Going past the line to finish the
// current task is fine; what the line stops is the *next* task. So past the
// hand-off line, every new prompt carries a note asking the model to sort it:
// a reply, approval or correction to the current task is part of that task;
// new work is listed and handed off.
//
// The notes are context lines: text the model reads and the person never
// sees. After a tool call the note follows the tool's result (as a
// PostToolUse hook's additionalContext does); on a prompt it follows the
// prompt. The notes don't restate the skill's rules, only point at it, so the
// two can't drift apart. This mod draws nothing; context-band already shows
// the figure in the band above the prompt.
//
// EVENT FLOW
// Nothing here runs on a timer. Two observers read the engine's own figure
// (`$.session.usage().context`) at the moments a note can still reach the
// model, and one listener handles compaction:
//
//   tool.call (main loop, the model's own call) ─┐
//     after the tool ran                          ├─> checkAfterTool() ─> a line newly crossed?
//                                                 │     └─ yes ─> one more entry in the result's `context`
//   prompt.submit (not a task notification) ─────┴─> checkPrompt() ─> past the hand-off line? (every prompt)
//                                                       or the heads-up line newly crossed?
//                                                       └─ yes ─> one more entry in the prompt's `context`
//
//   session.compact ─┬─ auto / plugin, main loop ─> past the hand-off line before it?
//                    │     ├─ yes ─> instructions for the summary; 'carried' = true,
//                    │     │         'noted' = hand-off, 'reissue' = true (the next tool call repeats the note)
//                    │     └─ no ──> rearm(): every line can be noted again
//                    └─ manual (/compact) ───────> rearm()
//   session.end ────────────────────────────────> rearm()   (a /clear starts a new conversation)
//
// Why `tool.call` and not `session.measure`: session.measure fires only after
// a turn ends, and a long task is one turn of many tool calls. The model must
// hear about the line while it is still working, so the tool.call observer
// reads `$.session.usage()` mid-turn. That is a read at a moment no event
// pushes, not polling. The figure is the input side of the main loop's last
// model response, the one that issued this tool call.
//
// ONCE PER LINE, NO NAGGING
// After a tool call, each line is noted once per conversation. There is no
// periodic reminder: a note on every tool call would push the model to stop
// early, mid-task, which is the opposite of the rule. Prompts are different:
// past the hand-off line each new prompt is exactly the decision point (is
// this the current task, or new work?), so every one carries the note.
//
// Parallel tool calls in one model step run this hook concurrently. The
// "newly crossed?" decision is made inside `update()`'s closure, which
// re-runs on a fresh value when another writer got there first, so only one
// of the concurrent calls carries the note.
//
// COMPACTION
// An automatic compaction past the hand-off line does not clear the
// hand-off: compacting doesn't finish the task or make it cheaper to start
// the next one (the rule is to hand off, not to compact and carry on). So
// the summary is told the hand-off is due, and the next tool call repeats the
// note once, since the summary may have dropped it. "Past the line" is read
// from the figures (the size before the compaction, `tokensBefore`, or the
// last response's), never from the trigger: the engine's auto-compact window
// is settable, so an 'auto' compaction can run well under 300k. An unknown
// size counts as past (it fails toward handing off). Under the line, a
// compaction re-arms both lines.
//
// A plugin's compaction is treated like the engine's: it is not the
// person's choice to carry on, and a mod that compacts on its own must not
// quietly cancel a hand-off. Only a /compact the person typed ('manual') is
// that choice, so it always re-arms both lines.
//
// SURVIVING A RESTART
// The state lives in `$.state`, which a hot reload keeps and a restart of the
// session's process does not. After a restart the next tool call past a line
// notes it once more. That repeat is harmless (the model reads the same
// pointer twice), so the state is not saved to `$.store`.
//
// HOW A HOOK WORKS (the one-paragraph version)
// Every hook is ($, e, next). `e` is the event's input (a frozen plain value).
// `next(e)` hands the event to the hooks below this one and then to Claude
// Code's own behaviour, and resolves to the result. These hooks only add
// context: a tool call's result goes back with one more `context` entry, a
// prompt goes down with one more, a compaction's summary gets instructions.
//
// FAILURE MODE: FAIL OPEN, ON PURPOSE
// `claude plugin validate` lists the tool.call, prompt.submit and
// session.compact hooks as "gating hook without .catch", because hooks on
// those events *could* refuse. These never do. Leaving off `.catch` means a
// hook that throws is skipped and the work goes ahead untouched; a missed
// note costs less than a blocked tool call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NoteLevel } from '../types'

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

// Absolute token counts, as context-band's are: cost scales with the tokens
// every call re-reads, whatever the model's window. Both are the owner's
// choice (2026-10-10).
const HEADS_UP = 250_000
const HAND_OFF = 300_000

// For a model whose window is too small for the lines above, each line moves
// down to this share of the window, so it can still be reached.
const HEADS_UP_SHARE = 0.7
// 0.8, not 0.85: on a 200k window the engine's default auto-compact runs at
// about 167k, so 85% (170k) could never be reached; 80% (160k) can.
const HAND_OFF_SHARE = 0.8

// Levels in order, so "did we move up?" is a number comparison.
const RANK: Record<NoteLevel, number> = { none: 0, 'heads-up': 1, 'hand-off': 2 }

// What the summary of an automatic compaction is told while the hand-off is
// due, so the compacted conversation still knows it.
const COMPACT_INSTRUCTIONS =
  'This session passed the context hand-off line before compacting. Finish the current task, then follow the context-handoff skill.'

/** The two lines for a model's window: the constants, scaled down when the window is small. Pure. */
export function linesFor(window: number): { headsUp: number; handOff: number } {
  return {
    headsUp: Math.min(HEADS_UP, Math.floor(window * HEADS_UP_SHARE)),
    handOff: Math.min(HAND_OFF, Math.floor(window * HAND_OFF_SHARE)),
  }
}

/** The highest line a token count has reached in a window. Pure. */
export function levelOf(tokens: number, window: number): NoteLevel {
  const { headsUp, handOff } = linesFor(window)
  if (tokens >= handOff) {
    return 'hand-off'
  }
  if (tokens >= headsUp) {
    return 'heads-up'
  }
  return 'none'
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// Atoms are named slots in `$.state` with an initial value; the `{ plugin,
// key }` pair must match the contract in types/index.d.ts. They live in the
// host's session state, not in module variables, so a hot reload (which
// re-runs this whole file) doesn't repeat a note.
const notedAtom = atom({ plugin: 'context-handoff', key: 'noted' } as const, 'none')
const carriedAtom = atom({ plugin: 'context-handoff', key: 'carried' } as const, false)
const reissueAtom = atom({ plugin: 'context-handoff', key: 'reissue' } as const, false)

// ---------------------------------------------------------------------------
// The notes
// ---------------------------------------------------------------------------

/** 182345 -> "182k", 1000000 -> "1M", 950 -> "950". Display only. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`
  }
  return String(n)
}

const PREFIX = 'Context hand-off (context-handoff mod):'

/**
 * How much is held, for the hand-off notes: "312k held, past the 300k
 * hand-off line", or, once an auto-compaction made the figure small (or
 * absent) while the hand-off is still due, "this session passed the 300k
 * hand-off line before it compacted". Pure.
 */
function heldPhrase(tokens: number | undefined, handOff: number): string {
  if (tokens !== undefined && tokens >= handOff) {
    return `${formatTokens(tokens)} held, past the ${formatTokens(handOff)} hand-off line`
  }
  return `this session passed the ${formatTokens(handOff)} hand-off line before it compacted`
}

/** The heads-up note, after a tool call. Pure. */
export function headsUpNote(tokens: number, window: number): string {
  const { headsUp, handOff } = linesFor(window)
  return (
    `${PREFIX} ${formatTokens(tokens)} of ${formatTokens(window)} held; heads-up line ${formatTokens(headsUp)}, ` +
    `hand-off line ${formatTokens(handOff)}. Carry on; plan to hand off (context-handoff skill) when this task is done.`
  )
}

/** The hand-off note, after a tool call. Pure. */
export function handOffToolNote(tokens: number | undefined, window: number): string {
  const { handOff } = linesFor(window)
  return `${PREFIX} ${heldPhrase(tokens, handOff)}. Finish the task you're on, then follow the context-handoff skill; don't start another.`
}

/** The hand-off note, on a prompt. Pure. */
export function handOffPromptNote(tokens: number | undefined, window: number): string {
  const { handOff } = linesFor(window)
  return (
    `${PREFIX} ${heldPhrase(tokens, handOff)}. If this message belongs to the task you're on ` +
    `(an answer, approval or correction), finish that task. If it is new work, don't start it: ` +
    `write the checkpoint, hand off, and list it under Next.`
  )
}

// ---------------------------------------------------------------------------
// Jobs: the work the listeners trigger
// ---------------------------------------------------------------------------

/**
 * JOB: decide whether a main-loop tool call carries a note.
 *
 * Triggered by: the tool.call listener, after the tool ran and was not
 *               refused.
 * Reads:        `$.session.usage().context`: `tokens`, the input side of the
 *               main loop's last response (the one that issued this call),
 *               and `window`, the model's window.
 * Decides:      inside one `update()` of 'noted', so concurrent calls can't
 *               both decide yes:
 *               - 'reissue' set (a compaction past the hand-off line since
 *                 the last tool call or prompt): the hand-off note, once;
 *               - otherwise a line higher than any noted so far: that line's
 *                 note.
 * Dispatches:   writes to 'noted' and 'reissue'. Returns the note, or null.
 *
 * With no `tokens` (a fresh conversation, or one just compacted, before its
 * next response) there is no figure to report, so it says nothing and leaves
 * a pending reissue for the next call.
 */
async function checkAfterTool($: EngineInterface): Promise<string | null> {
  const { tokens, window } = (await $.session.usage()).context
  if (tokens === undefined) {
    return null
  }
  const reached = levelOf(tokens, window)

  // The reissue flag is cleared in its own update, and only the call that
  // cleared it speaks for it: two concurrent calls can't both repeat it.
  let reissue = false
  await update($, reissueAtom, pending => {
    reissue = pending
    return false
  })

  let note: string | null = null
  await update($, notedAtom, noted => {
    note = null
    if (reissue) {
      note = handOffToolNote(tokens, window)
      return 'hand-off'
    }
    if (RANK[reached] > RANK[noted]) {
      note = reached === 'hand-off' ? handOffToolNote(tokens, window) : headsUpNote(tokens, window)
      return reached
    }
    return noted
  })
  return note
}

/**
 * JOB: decide whether a prompt carries a note.
 *
 * Triggered by: the prompt.submit listener, for any prompt that is not a
 *               background task's notification.
 * Reads:        `$.session.usage().context` and 'carried'.
 * Decides:      past the hand-off line (by the figure, or carried over an
 *               auto-compaction): the prompt's hand-off note, on every
 *               prompt, and 'noted' rises to 'hand-off' so the next tool call
 *               doesn't repeat it. Otherwise, a newly crossed heads-up line:
 *               the heads-up note, once (shared with the tool calls).
 * Dispatches:   writes to 'noted' and, past the hand-off line, 'reissue'
 *               (cleared: this note covers it). Returns the note, or null.
 */
async function checkPrompt($: EngineInterface): Promise<string | null> {
  const { tokens, window } = (await $.session.usage()).context
  const carried = await read($, carriedAtom)
  if (tokens === undefined && !carried) {
    return null
  }
  const reached = tokens === undefined ? 'none' : levelOf(tokens, window)

  if (carried || reached === 'hand-off') {
    // This note covers a pending reissue too: the model has just been told.
    await update($, notedAtom, () => 'hand-off' as const)
    await update($, reissueAtom, () => false)
    return handOffPromptNote(tokens, window)
  }

  if (tokens === undefined || reached !== 'heads-up') {
    return null
  }
  let note: string | null = null
  await update($, notedAtom, noted => {
    note = null
    if (RANK[noted] < RANK['heads-up']) {
      note = headsUpNote(tokens, window)
      return 'heads-up'
    }
    return noted
  })
  return note
}

/**
 * JOB: re-arm both lines.
 *
 * Triggered by: the session.compact listener (a /compact, or any compaction
 *               of the main conversation under the hand-off line) and the session.end
 *               listener (a /clear or the end of the conversation).
 * Dispatches:   writes to 'noted' ('none'), 'carried' and 'reissue' (false).
 */
async function rearm($: EngineInterface): Promise<void> {
  // 'reissue' first and 'noted' last: a tool call running in between must
  // never find a pending reissue with 'noted' already at 'none', or it would
  // consume the reissue and write 'hand-off' over the re-arm.
  await update($, reissueAtom, () => false)
  await update($, carriedAtom, () => false)
  await update($, notedAtom, () => 'none' as const)
}

// ---------------------------------------------------------------------------
// Registration: the listeners
// ---------------------------------------------------------------------------

// `register` runs once each time the module loads (and again on every hot
// reload). It only wires listeners up. No work happens here.
export const register: Register = on => {
  /**
   * LISTENER: tool.call
   *
   * Triggered by: every tool call, before it runs.
   * Skips:        a subagent's call (`agentId`: it has its own window and
   *               its own figure), and a call another plugin made through
   *               `$.tool.call` (`next.origin` isn't the engine): the model
   *               never reads that call's context, so a note there would be
   *               spent unseen.
   * Reacts by:    letting the tool run first (`await next(e)`), then, if it
   *               wasn't refused, asking checkAfterTool() for a note. A
   *               refused call's result has no `context` to carry one.
   * Dispatches:   checkAfterTool(); the tool's result, with the note as one
   *               more `context` entry after any already there.
   */
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || next.origin.plugin !== 'engine') {
      return next(e)
    }

    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }

    const note = await checkAfterTool($)
    if (note === null) {
      return ran
    }
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  /**
   * LISTENER: prompt.submit
   *
   * Triggered by: every prompt entering the session: the person's, a
   *               Remote Control message, a peer session's, a scheduled
   *               one's, a plugin's.
   * Skips:        a background task's notification (`task-notification`): it
   *               reports on the current turn's work, it isn't new work.
   * Reacts by:    asking checkPrompt() for a note and attaching it on the way
   *               down, after any context already there.
   * Dispatches:   checkPrompt(); the prompt, with the note as one more
   *               `context` entry.
   */
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      return next(e)
    }

    const note = await checkPrompt($)
    if (note === null) {
      return next(e)
    }
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  /**
   * LISTENER: session.compact
   *
   * Triggered by: a compaction about to run: /compact (manual), the engine's
   *               own auto-compact, a plugin's, or a background precompute.
   * Skips:        `precompute` (installs nothing), a subagent's own
   *               compaction (`agentId`), and a vetoed one (the result
   *               carries `skip`), as context-band does.
   * Reacts by:    for a /compact the person typed ('manual'), re-arming both
   *               lines once it was installed. For the engine's or a
   *               plugin's ('auto', 'plugin'): if the conversation was past
   *               the hand-off line (by the figures; unknown counts as past),
   *               adding the hand-off to the summary's instructions (after
   *               any already given) and, once installed, keeping the
   *               hand-off due; under the line, re-arming once installed.
   * Dispatches:   writes to 'carried', 'reissue' and 'noted' (past the
   *               line); rearm() (manual, or under the line).
   */
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') {
      return next(e)
    }

    if (e.trigger === 'manual') {
      const result = await next(e)
      if (result.skip === undefined) {
        await rearm($)
      }
      return result
    }

    // 'auto' or 'plugin'. Before it runs, only the last response's figure is
    // known; it decides the summary's instructions. A hand-off already carried
    // over an earlier compaction stays due whatever the size.
    const { tokens: lastTokens, window } = (await $.session.usage()).context
    const { handOff } = linesFor(window)
    const carried = await read($, carriedAtom)
    const pastBefore = carried || lastTokens === undefined || lastTokens >= handOff

    const instructions = !pastBefore
      ? e.instructions
      : e.instructions === undefined
        ? COMPACT_INSTRUCTIONS
        : `${e.instructions}\n\n${COMPACT_INSTRUCTIONS}`
    const result = await next(instructions === undefined ? e : { ...e, instructions })
    if (result.skip !== undefined) {
      return result
    }

    // After it, the engine's own size before the compaction is the better
    // figure (it counts what was added since the last response); the last
    // response's stands in when the engine didn't record one. The two can
    // disagree, on purpose: when one large tool result pushed the size past
    // the line after the last response, the hand-off is carried without the
    // summary's instructions, and the next tool call's repeated note tells the
    // model instead (one response late). The reverse (no figure yet, so
    // instructions given, then a size under the line, so re-armed) needs a
    // compaction before any response of the live window: rare and harmless.
    const before = result.tokensBefore ?? lastTokens
    if (carried || before === undefined || before >= handOff) {
      await update($, carriedAtom, () => true)
      await update($, reissueAtom, () => true)
      await update($, notedAtom, () => 'hand-off' as const)
    } else {
      await rearm($)
    }
    return result
  })

  /**
   * LISTENER: session.end
   *
   * Triggered by: the conversation ending, for any reason; a /clear
   *               (reason 'clear') or an in-place resume keeps the process
   *               under a new conversation.
   * Reacts by:    re-arming both lines. After a /clear the new conversation
   *               starts small; after a resume it may not, and then the next
   *               tool call notes its lines once more, which is what a
   *               conversation the model hasn't been told about needs.
   * Dispatches:   rearm().
   */
  on('session.end', async ($, e, next) => {
    await rearm($)
    return next(e)
  })
}
