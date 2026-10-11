// context-band: the hooks module.
//
// ROLE
// Shows a band of up to two lines above the prompt, so a session's cost is
// visible before it gets expensive:
//   - the context line: how full the context window is (describeContext);
//   - the spend line, under it: what the session has cost so far and how
//     much of the plan's usage windows are gone (describeSpend).
// A line with nothing to show is left out: the context line before the first
// response or right after a compaction, the spend line while there is neither
// a cost nor a usage window to report. So the band is two lines, one line, or
// nothing.
//
// The band follows a simple cost rule: every model call re-reads the whole
// context, so cost scales with the tokens held. Past 250k tokens, plan a
// /compact with keep/drop instructions; past 350k, /compact now (or write a
// checkpoint and /clear). The spend line turns amber, then red, as a usage
// window nears its limit (80%, then 95%).
//
// EVENT FLOW
// Nothing here polls. The engine pushes its measurements, a few events say
// when the context was emptied, and all of them feed two shared values. The
// band is drawn from those values: 'reading' becomes the context line and
// 'spend' becomes the spend line under it:
//
//   session.measure ─┐                                  (main thread, after each turn)
//   session.start   ─┼─> publishReading() ─> $.state 'reading' ─┐
//     (one-time seed)│     └─ crossed a line? ─> $.ui.toast      ├─> ui.render AbovePrompt
//                    └─> publishSpend()   ─> $.state 'spend'   ─┘    (redraws on every write)
//                          └─ a usage window crossed 80/95%? ─> $.ui.toast
//
//   session.compact ───> clearReading()   ─> 'reading' = null (cost is unchanged by a compact)
//   session.end     ─┬─> clearReading()
//                    └─> clearSpend()     ─> 'spend' = null   (a /clear starts the cost over)
//
// Writing an atom redraws every drawing that read it, so the listeners never
// talk to the band directly. They only write state, and the band only reads
// it. That keeps each listener single-purpose.
//
// SHARING THE BAND
// The band above the prompt is one slot, and every mod hooking it is a link in
// a chain. A hook that returns its own tree without calling `next(e)` hides
// every mod beneath it. So this hook draws its lines *above* whatever the chain
// beneath draws (`await next(e)`), and several band mods stack instead of
// fighting over the slot.
//
// HOW A HOOK WORKS (the one-paragraph version)
// Every hook is ($, e, next). `e` is the event's input (a frozen plain value).
// `next(e)` hands the event to the hooks below this one and then to Claude
// Code's own behaviour, and resolves to the result. Every hook here only
// observes, so each one returns `next(e)` (or its awaited result) unchanged.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { ContextReading, ContextTier, LimitReading, SpendReading } from '../types'

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

// Absolute token counts, not percentages: cost scales with tokens re-read per
// call, whatever the model's window is. A 1M-window model at 250k is only 25%
// full but already in the expensive zone.
//
// Amber starts on context-handoff's heads-up line (250k; that mod scales its
// lines down on windows under ~360k, this one never does), so the person sees
// the colour change when the model gets its first note. Red starts past that
// mod's hand-off line (300k): a session still growing at 350k should already
// have handed off.
const WARN_AT = 250_000
const OVER_AT = 350_000

// Tiers in order, so "did we move up?" is a number comparison.
const RANK: Record<ContextTier, number> = { calm: 0, warn: 1, over: 2 }

// Usage-window lines, in percent. Each one toasts once per climb; the spend
// line turns amber at the first and red at the second.
const LIMIT_LINES = [80, 95] as const

/** Which tier a token count sits in. Pure, so it is easy to test and reason about. */
function tierOf(tokens: number): ContextTier {
  if (tokens >= OVER_AT) {
    return 'over'
  }
  if (tokens >= WARN_AT) {
    return 'warn'
  }
  return 'calm'
}

/** The highest limit line a percentage has reached: 0, 80 or 95. Pure. */
function limitLineOf(percentUsed: number): number {
  let reached = 0
  for (const line of LIMIT_LINES) {
    if (percentUsed >= line) {
      reached = line
    }
  }
  return reached
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// An atom is a named slot in `$.state` with an initial value. `read($, atom)`
// returns the initial value until something writes, so it is never undefined.
// The `{ plugin, key }` pair must match the contract in types/index.d.ts, and
// `as const` keeps the literal key types so TypeScript can check that it does.
//
// These live in the host's session state, not in module variables, so a hot
// reload (which re-runs this whole file) keeps the last reading and does not
// fire the same toast twice.
const readingAtom = atom({ plugin: 'context-band', key: 'reading' } as const, null)
const warnedTierAtom = atom({ plugin: 'context-band', key: 'warnedTier' } as const, 'calm')
const spendAtom = atom({ plugin: 'context-band', key: 'spend' } as const, null)
const warnedLimitsAtom = atom({ plugin: 'context-band', key: 'warnedLimits' } as const, {})

// What the toast says when the context first crosses into each tier. 'calm'
// never toasts: dropping back under a line is good news and needs no popup.
const CROSSING_TOAST: Record<Exclude<ContextTier, 'calm'>, string> = {
  warn: `Context passed ${formatTokens(WARN_AT)}: plan a /compact with keep/drop notes.`,
  over: `Context passed ${formatTokens(OVER_AT)}: every call re-reads it now. /compact, or checkpoint and /clear.`,
}

// ---------------------------------------------------------------------------
// Jobs: the work the listeners trigger
// ---------------------------------------------------------------------------

/**
 * JOB: publish one context measurement.
 *
 * Triggered by: the session.measure listener (the engine's pushed figures)
 *               and, once, the session.start listener (a seed).
 * Reads:        `context.tokens`, the input side of the last model response
 *               (uncached, cache-write and cache-read together), and
 *               `context.window`, the model's maximum.
 * Dispatches:   a write to 'reading' (the band redraws); a write to
 *               'warnedTier'; a toast if the context just crossed into a
 *               higher tier.
 *
 * `tokens` is absent until the first response of the live window: in a fresh
 * session, and right after a compaction until the next response. Absent
 * means "no figure yet", so the context part hides rather than drawing a "0".
 */
async function publishReading($: EngineInterface, context: SessionContextUsage): Promise<void> {
  if (context.tokens === undefined) {
    await clearReading($)
    return
  }

  const reading: ContextReading = { tokens: context.tokens, window: context.window }
  await update($, readingAtom, () => reading)

  // Decide on the toast *inside* the update. `update` reads the value, runs
  // this closure, and writes only if nothing else wrote in between; if
  // something did, it runs the closure again on the fresh value. So when two
  // publishes overlap, the one that commits last has seen the other's tier,
  // and only one of them can see a rise and toast.
  const tier = tierOf(reading.tokens)
  let rose = false
  await update($, warnedTierAtom, warned => {
    rose = RANK[tier] > RANK[warned]
    return tier
  })

  // Toast only on the way up. On the way down the stored tier simply follows,
  // so the next climb past a line warns again.
  if (rose && tier !== 'calm') {
    $.ui.toast(CROSSING_TOAST[tier], { timeoutMs: 8000 })
  }
}

/**
 * JOB: publish the cost and usage-limit figures.
 *
 * Triggered by: the session.measure listener when its `changed` names `cost`
 *               or `rateLimits`, and once by the session.start seed.
 * Reads:        `cost.usd`, the engine's own running total for the session
 *               (the /cost figure, subagents included), and `rateLimits`,
 *               the plan's usage windows as the last response reported them.
 * Dispatches:   a write to 'spend' (the band redraws); a write to
 *               'warnedLimits'; a toast for each window that just climbed
 *               past 80% or 95%.
 *
 * The engine's figure is the one to trust here: it prices every response at
 * the rate the host knows, so this mod does not re-derive a cost of its own
 * from the transcripts or from cached statistics files.
 */
async function publishSpend(
  $: EngineInterface,
  cost: SessionCost | undefined,
  rateLimits: readonly SessionRateLimit[],
): Promise<void> {
  const limits: LimitReading[] = rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed }))
  const spend: SpendReading = { usd: cost?.usd, limits }
  await update($, spendAtom, () => spend)

  // Same pattern as the context tier: decide inside `update` so overlapping
  // publishes cannot both see the same rise. A window that dropped (it reset)
  // follows downwards, so its next climb warns again. A window that vanished
  // from the report is forgotten.
  const crossed: LimitReading[] = []
  await update($, warnedLimitsAtom, warned => {
    crossed.length = 0
    const next: Record<string, number> = {}
    for (const limit of limits) {
      const line = limitLineOf(limit.percentUsed)
      if (line > (warned[limit.kind] ?? 0)) {
        crossed.push(limit)
      }
      next[limit.kind] = line
    }
    return next
  })

  for (const limit of crossed) {
    $.ui.toast(`${limitName(limit.kind)} usage window at ${limit.percentUsed}%.`, { timeoutMs: 8000 })
  }
}

/**
 * JOB: forget the current context reading.
 *
 * Triggered by: the session.compact and session.end listeners, and by
 *               publishReading() when the engine has no figure.
 * Why it is needed: after a compaction or a /clear, `$.session.usage()` has
 *               no `tokens` until the next response, but our atom still
 *               holds the old, large reading. Something has to blank it, or
 *               the band would keep showing the pre-compact number.
 * Dispatches:   writes to 'reading' (null: the context part hides) and to
 *               'warnedTier' ('calm': the next climb warns again).
 */
async function clearReading($: EngineInterface): Promise<void> {
  await update($, readingAtom, () => null)
  await update($, warnedTierAtom, () => 'calm' as const)
}

/**
 * JOB: forget the cost and usage figures.
 *
 * Triggered by: the session.end listener. A /clear starts the session's cost
 *               over, so the old total would be wrong until the next
 *               measurement replaces it. The usage windows are the
 *               account's, not the session's, but they come back with that
 *               same measurement, so hiding them briefly is harmless.
 * Dispatches:   a write to 'spend' (null: the cost part hides). The
 *               'warnedLimits' memory is kept on purpose: the account's
 *               windows did not reset because the conversation did, so a
 *               /clear must not re-toast a line already announced.
 */
async function clearSpend($: EngineInterface): Promise<void> {
  await update($, spendAtom, () => null)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 182345 -> "182k", 1000000 -> "1M", 950 -> "950". Display only. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`
  }
  return String(n)
}

/** 3.14159 -> "$3.14", 0.004 -> "$0.00". Display only. */
function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** The engine's window names, shortened to fit the spend line: five_hour -> "5h". */
function limitName(kind: string): string {
  if (kind === 'five_hour') {
    return '5h'
  }
  if (kind === 'seven_day') {
    return '7d'
  }
  if (kind === 'spend_limit') {
    return 'spend'
  }
  return kind
}

/** How loud a band line is: dim, amber ('warning'), or red and bold ('error'). */
type Look = 'dim' | 'warning' | 'error'

/**
 * The context line: "Context 162k / 1M (16%)", plus advice once past
 * WARN_AT. Its look comes from the context size alone. Null with no reading
 * (a fresh session, or right after a compaction). Pure.
 */
function describeContext(reading: ContextReading | null): { text: string; look: Look } | null {
  if (reading === null) {
    return null
  }
  const percent = Math.round((reading.tokens / reading.window) * 100)
  const text = `Context ${formatTokens(reading.tokens)} / ${formatTokens(reading.window)} (${percent}%)`
  const tier = tierOf(reading.tokens)
  if (tier === 'over') {
    return { text: `${text}: past ${formatTokens(OVER_AT)}. /compact now, or checkpoint and /clear.`, look: 'error' }
  }
  if (tier === 'warn') {
    return { text: `${text}: plan a /compact before ${formatTokens(OVER_AT)}.`, look: 'warning' }
  }
  return { text, look: 'dim' }
}

/**
 * The spend line, drawn under the context line: "Cost $4.12 · 5h 34% ·
 * 7d 12%". Its look comes from the usage windows alone: amber from 80%, red
 * from 95%. It leads with "Usage" until the cost reaches half a cent (under
 * that, "$0.00" says nothing). Null when there is nothing to show. Pure.
 */
function describeSpend(spend: SpendReading | null): { text: string; look: Look } | null {
  if (spend === null) {
    return null
  }
  const parts: string[] = []
  let look: Look = 'dim'
  for (const limit of spend.limits) {
    parts.push(`${limitName(limit.kind)} ${limit.percentUsed}%`)
    // A usage window near its end raises the look, never lowers it.
    const line = limitLineOf(limit.percentUsed)
    if (line >= 95) {
      look = 'error'
    } else if (line >= 80 && look === 'dim') {
      look = 'warning'
    }
  }
  const hasCost = spend.usd !== undefined && spend.usd >= 0.005
  if (!hasCost && parts.length === 0) {
    return null
  }
  const text = hasCost ? ['Cost ' + formatUsd(spend.usd ?? 0), ...parts].join(' · ') : `Usage ${parts.join(' · ')}`
  return { text, look }
}

// ---------------------------------------------------------------------------
// Registration: the listeners
// ---------------------------------------------------------------------------

// `register` runs once each time the module loads (and again on every hot
// reload). It only wires listeners up. No work happens here.
export const register: Register = on => {
  /**
   * LISTENER: session.measure
   *
   * Triggered by: the engine measuring the session after each main-thread
   *               turn (and when a rate-limit window moves). These are the
   *               same figures `$.session.usage()` returns, pushed rather than
   *               polled. It never fires for subagents, so there is no
   *               `agentId` to filter on.
   * Reacts by:    publishing only what `changed` says moved: the context
   *               figure on `context`, the spend figures on `cost` or
   *               `rateLimits`.
   * Dispatches:   publishReading(), publishSpend().
   */
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await publishReading($, e.context)
    }
    if (e.changed.includes('cost') || e.changed.includes('rateLimits')) {
      await publishSpend($, e.cost, e.rateLimits)
    }

    return next(e)
  })

  /**
   * LISTENER: session.start
   *
   * Triggered by: the process starting, and each fresh load of this module
   *               (enabling it, or a hot reload). Not by /clear or an
   *               in-session resume: those raise only session.end.
   * Reacts by:    reading the current figures once, so a mod enabled
   *               mid-session shows them without waiting for the next turn.
   *               Before any response there is no context figure and no
   *               usage window; the cost may already read $0.00.
   * Dispatches:   publishReading(), publishSpend().
   */
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await publishReading($, usage.context)
    await publishSpend($, usage.cost, usage.rateLimits)

    return next(e)
  })

  /**
   * LISTENER: session.compact
   *
   * Triggered by: a compaction about to run: /compact (manual), the engine's
   *               own auto-compact, a plugin's, or a background precompute.
   * Reacts by:    letting it run first (`await next(e)`), then clearing the
   *               context reading only if the main conversation really was
   *               compacted. The cost stays: a compaction spends, it does
   *               not refund.
   * Skips:        `precompute` (computes a summary but installs nothing), a
   *               subagent's own compaction (`agentId`), and a vetoed one
   *               (the result carries `skip`).
   * Dispatches:   clearReading().
   *
   * `claude plugin validate` lists this as a "gating hook without .catch",
   * because a session.compact hook *could* veto a compaction. This one never
   * does, and leaving off `.catch` is deliberate: if this hook throws, the
   * engine skips it and the compaction goes ahead. A display mod should
   * fail open and never block the person's /compact.
   */
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    const isMainConversation = e.agentId === undefined
    const wasInstalled = e.trigger !== 'precompute' && result.skip === undefined
    if (isMainConversation && wasInstalled) {
      await clearReading($)
    }

    return result
  })

  /**
   * LISTENER: session.end
   *
   * Triggered by: the conversation ending, for any reason. Two of them keep
   *               the process running under a new session id with no
   *               session.start after: 'clear' (a /clear) and 'resume'
   *               (another session resumed in its place). The rest
   *               ('prompt_input_exit', 'logout', 'other') end the process.
   * Reacts by:    clearing both readings on every reason. For the two that
   *               carry on, the old figures would be wrong. For the rest,
   *               clearing is harmless.
   * Dispatches:   clearReading(), clearSpend().
   */
  on('session.end', async ($, e, next) => {
    await clearReading($)
    await clearSpend($)

    return next(e)
  })

  /**
   * RENDER: the band above the prompt (component 'AbovePrompt')
   *
   * Triggered by: the surface (terminal or desktop) drawing the band, and
   *               again whenever an atom this hook read is written.
   *               `read($, atom)` inside a render subscribes the drawing.
   * Reacts by:    drawing up to two lines from the current readings: the
   *               context line (describeContext) with the spend line
   *               (describeSpend) under it, both above whatever the mods
   *               beneath draw. A line with nothing to show is left out; with
   *               neither, or while a survey has the band, the chain's own
   *               drawing passes through untouched.
   * Dispatches:   nothing. It only draws.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey owns the band while it is up, so yield to it.
    if (e.props.hasSurvey) {
      return next(e)
    }

    const lines = [describeContext(await read($, readingAtom)), describeSpend(await read($, spendAtom))].filter(
      (line): line is { text: string; look: Look } => line !== null,
    )
    if (lines.length === 0) {
      return next(e)
    }

    // What the mods beneath (and the engine) draw. Our lines go on top of it,
    // so another band mod is never hidden by this one.
    const beneath = await next(e)

    // The elements come from the surface's own table, so one tree works in
    // the terminal (Ink) and in the desktop app alike. (A `key` on a plain
    // Text is dropped; keys are kept on Box and interactive elements.)
    const { Box, Text } = $.ui.resolve(e)

    // Theme keys ('warning', 'error') follow the person's colour theme rather
    // than hard-coding a colour that might vanish on a light background.
    const drawn = lines.map(({ text, look }) =>
      look === 'error' ? (
        <Text color="error" bold>
          {text}
        </Text>
      ) : look === 'warning' ? (
        <Text color="warning">{text}</Text>
      ) : (
        <Text dimColor>{text}</Text>
      ),
    )

    return (
      <Box flexDirection="column">
        {drawn}
        {beneath}
      </Box>
    )
  })
}
