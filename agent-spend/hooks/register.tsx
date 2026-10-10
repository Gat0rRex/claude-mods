// agent-spend: the hooks module.
//
// ROLE
// Cost scales with the tokens a context holds, and every subagent holds its
// own. Claude Code shows one figure for the whole session (/cost), so which
// agent cost what is invisible. This mod keeps a row per subagent: its type,
// model, tokens and an estimated cost. /agent-spend opens a pane listing them
// against the session's total.
//
// WHERE EACH FACT COMES FROM
// - The row starts at `agent.spawn`: the agent type, the task description,
//   and the agent id the spawn resolves to.
// - Tokens arrive at `turn.complete`. Each turn of a subagent's loop carries
//   that loop's `agentId` and the turn's `usage` (four token counts and the
//   model that answered). A subagent's run is one turn; a continuation
//   (SendMessage) is another, so counts add up.
// - The session's total is Claude Code's own (`session.measure`'s
//   `cost.usd`, the /cost figure), read on every measure.
//
// THE ESTIMATE
// Costs are API list prices (as of 2026-09-25), copied into PRICES below. A
// turn's usage has no split of cache writes by lifetime, so every write is
// priced as a 1-hour write (2x input), which is what Claude Code mostly
// writes: at worst a slight overcount. A model missing from the table (Haiku
// 5.5 today) is shown as "?" and never priced as something else. The
// engine's session figure is the authority; the per-agent numbers are for
// comparing agents, not for billing. The usage carries only the four token
// counts, so fast mode (a price multiplier) and web-search fees can't be
// counted, and a subagent's own compaction isn't in its turn's usage: small
// undercounts against the engine's figure.
//
// EVENT FLOW
//   agent.spawn ────────────> startRow()      ─┐
//   turn.complete (subagent) ─> addTurn()      ─┼─> $.state 'agents' ──┐
//   session.end (clear) ─────> forgetAll()    ─┘                       ├─> ui.render Pane 'agent-spend'
//   session.measure ─────────> 'sessionUsd' ──────────────────────────┘
//   command.run /agent-spend ─> $.ui.open('agent-spend')
//
// FAILURE MODE: FAIL OPEN, ON PURPOSE
// `claude plugin validate` lists the agent.spawn hook as "gating hook
// without .catch", because a hook there *could* refuse a spawn. This one
// never does; it only watches. Leaving off `.catch` means a hook that throws
// is skipped and the agent starts anyway. A meter must never block work.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnCompleteReason, TurnUsage } from 'claude-code'

import type { AgentRow, AgentStatus, AgentTokens } from '../types'

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

// US dollars per million tokens: (input, output, cache read). API list prices
// as of 2026-09-25; update them when the published prices change. Keys are
// prefixes, so dated ids and suffixes resolve.
const PRICES: Record<string, readonly [number, number, number]> = {
  'claude-fable-5-1': [10.0, 50.0, 0.25],
  'claude-mythos-5-1': [10.0, 50.0, 0.25],
  'claude-fable-5': [10.0, 50.0, 1.0],
  'claude-mythos-5': [10.0, 50.0, 1.0],
  'claude-opus-5-5': [4.0, 20.0, 0.2],
  'claude-opus-5': [5.0, 25.0, 0.5],
  'claude-opus-4-8': [5.0, 25.0, 0.5],
  'claude-opus-4-7': [5.0, 25.0, 0.5],
  'claude-opus-4-6': [5.0, 25.0, 0.5],
  'claude-opus-4-5': [5.0, 25.0, 0.5],
  'claude-opus-4-1': [15.0, 75.0, 1.5],
  'claude-opus-4': [15.0, 75.0, 1.5],
  'claude-sonnet-5-5': [2.0, 10.0, 0.2],
  'claude-sonnet-5': [2.0, 10.0, 0.2],
  'claude-sonnet-4-6': [3.0, 15.0, 0.3],
  'claude-sonnet-4-5': [3.0, 15.0, 0.3],
  'claude-sonnet-4': [3.0, 15.0, 0.3],
  'claude-haiku-4-5': [1.0, 5.0, 0.1],
}

// Cache writes cost this many times the input price (1-hour lifetime).
const CACHE_WRITE_FACTOR = 2.0

// The pane's id: what `$.ui.open` names and the render hook matches.
const PANE = 'agent-spend'

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// Atoms are named slots in the host's session state (`$.state`), declared in
// types/index.d.ts. They survive a hot reload; module variables do not.
// Writing one redraws every drawing that read it (here, the pane).
const agentsAtom = atom({ plugin: 'agent-spend', key: 'agents' } as const, {})
const sessionUsdAtom = atom({ plugin: 'agent-spend', key: 'sessionUsd' } as const, null)

const NO_TOKENS: AgentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// ---------------------------------------------------------------------------
// Pricing and formatting (pure)
// ---------------------------------------------------------------------------

/**
 * The price row for a model id, by longest matching prefix, so
 * `claude-opus-5-5` wins over `claude-opus-5`. Undefined when none matches.
 */
export function priceFor(model: string): readonly [number, number, number] | undefined {
  const id = model.toLowerCase()
  const key = Object.keys(PRICES)
    .filter(prefix => id.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0]
  return key === undefined ? undefined : PRICES[key]
}

/** A turn's usage as this mod's token counts. */
function tokensOf(usage: TurnUsage): AgentTokens {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
}

/** Estimated US dollars for one turn's tokens on `model`; undefined if unpriced. */
export function estimateUsd(model: string, tokens: AgentTokens): number | undefined {
  const price = priceFor(model)
  if (price === undefined) {
    return undefined
  }
  const [input, output, cacheRead] = price
  return (
    (tokens.input * input +
      tokens.cacheWrite * input * CACHE_WRITE_FACTOR +
      tokens.cacheRead * cacheRead +
      tokens.output * output) /
    1_000_000
  )
}

/** The status a turn's ending reason leaves an agent in. */
function statusOf(reason: TurnCompleteReason): AgentStatus {
  return reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
}

/** 950 → "950", 12_345 → "12.3k", 1_234_567 → "1.2M". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`
  }
  return String(count)
}

/** "$1.84", or "?" when nothing about it could be priced. */
function formatRowUsd(row: AgentRow): string {
  if (row.hasUnpriced && row.usd === 0) {
    return '?'
  }
  return `$${row.usd.toFixed(2)}${row.hasUnpriced ? '+?' : ''}`
}

/** Fits text to `width` columns: cut with "…" or padded with spaces. */
function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)
}

/**
 * How the pane draws a line: the header bold, a running agent plain, a
 * finished one dim, a failed one red, the notes dim.
 */
export type PaneTone = 'header' | 'running' | 'finished' | 'failed' | 'note'

/**
 * The pane's lines: a header, one row per agent (start order), and a total.
 * Exported for the tests; the render hook only draws each line in its tone.
 */
export function paneLines(
  rows: readonly AgentRow[],
  sessionUsd: number | null,
  columns: number,
): { text: string; tone: PaneTone }[] {
  if (rows.length === 0) {
    return [{ text: 'No subagents yet this conversation.', tone: 'note' }]
  }
  const fixed = [24, 14, 9, 8, 9, 8] as const
  const rest = Math.max(10, columns - fixed.reduce((sum, width) => sum + width, 0))
  const line = (parts: readonly string[]) =>
    parts.map((part, i) => cell(part, fixed[i] ?? rest)).join('').trimEnd()

  const ordered = [...rows].sort((a, b) => a.order - b.order)
  const total = ordered.reduce((sum, row) => sum + row.usd, 0)
  const anyUnpriced = ordered.some(row => row.hasUnpriced)
  const session = sessionUsd === null ? 'unknown yet' : `$${sessionUsd.toFixed(2)}`

  const toneOf = (status: AgentStatus): PaneTone =>
    status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'finished'

  return [
    { text: line(['agent', 'model', 'in', 'out', 'cost', 'status', 'task']), tone: 'header' },
    ...ordered.map(row => ({
      tone: toneOf(row.status),
      text: line([
        row.type,
        row.model.replace(/^claude-/, ''),
        // "in" is every input token the agent paid for: plain, cache reads
        // and cache writes. That is what grows with its context.
        formatTokens(row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite),
        formatTokens(row.tokens.output),
        formatRowUsd(row),
        row.status,
        row.description,
      ]),
    })),
    { text: '', tone: 'note' },
    {
      text: `Subagents ≈ $${total.toFixed(2)}${anyUnpriced ? ' + unpriced' : ''} of the session's ${session} (Claude Code's figure, as of the last main turn).`,
      tone: 'note',
    },
    { text: 'Estimates at API list prices; cache writes priced as 1-hour writes; fast mode and web search not counted.', tone: 'note' },
  ]
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * JOB: start an agent's row.
 *
 * Triggered by: the agent.spawn listener, once the spawn resolved an id.
 * Dispatches:   a write to 'agents' (the pane redraws), status 'running',
 *               no tokens yet: they arrive when its turn ends.
 *
 * If the agent's turn already ended (a row made by addTurn() before this
 * write landed), only the type and task are filled in; its tokens, cost
 * and status are kept.
 */
async function startRow($: EngineInterface, row: Omit<AgentRow, 'order'>): Promise<void> {
  await update($, agentsAtom, agents => {
    const existing = agents[row.id]
    return {
      ...agents,
      [row.id]:
        existing === undefined
          ? { ...row, order: Object.keys(agents).length }
          : { ...existing, type: row.type, description: row.description },
    }
  })
}

/**
 * JOB: add a finished turn to an agent's row.
 *
 * Triggered by: the turn.complete listener, for a subagent's turn.
 * Calls:        `$.agent.list()` only when the agent has no row (it was
 *               spawned before this mod loaded), for its type and task.
 * Dispatches:   a write to 'agents' (the pane redraws): tokens added, cost
 *               added (or marked unpriced), model and status updated.
 */
async function addTurn(
  $: EngineInterface,
  agentId: string,
  reason: TurnCompleteReason,
  usage: TurnUsage | undefined,
): Promise<void> {
  const known = (await read($, agentsAtom))[agentId]
  const listed =
    known === undefined
      ? (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
      : undefined

  await update($, agentsAtom, agents => {
    const order = Object.keys(agents).length
    const row: AgentRow = agents[agentId] ?? {
      id: agentId,
      order,
      type: listed?.type ?? 'unknown',
      description: listed?.description ?? '',
      model: usage?.model ?? '?',
      status: 'running',
      tokens: NO_TOKENS,
      usd: 0,
      hasUnpriced: false,
    }
    // An interrupted turn or an API error may have no usage at all.
    if (usage === undefined) {
      return { ...agents, [agentId]: { ...row, status: statusOf(reason) } }
    }
    const turn = tokensOf(usage)
    const usd = estimateUsd(usage.model, turn)
    return {
      ...agents,
      [agentId]: {
        ...row,
        model: usage.model,
        status: statusOf(reason),
        tokens: {
          input: row.tokens.input + turn.input,
          output: row.tokens.output + turn.output,
          cacheRead: row.tokens.cacheRead + turn.cacheRead,
          cacheWrite: row.tokens.cacheWrite + turn.cacheWrite,
        },
        usd: row.usd + (usd ?? 0),
        hasUnpriced: row.hasUnpriced || usd === undefined,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Registration: the listeners
// ---------------------------------------------------------------------------

export const register: Register = on => {
  /**
   * LISTENER: agent.spawn
   *
   * Triggered by: the Agent tool (or a workflow script) about to start a
   *               subagent, a nested one included.
   * Reacts by:    letting the spawn go ahead, then starting a row under the
   *               id it resolved to. A workflow's remote agent has no local
   *               loop and no id; nothing reports its tokens here, so it
   *               gets no row.
   * Dispatches:   startRow().
   */
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      await startRow($, {
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description,
        model: spawned.model,
        status: 'running',
        tokens: NO_TOKENS,
        usd: 0,
        hasUnpriced: false,
      })
    }
    return spawned
  })

  /**
   * LISTENER: turn.complete
   *
   * Triggered by: the end of every turn, the main loop's and each
   *               subagent's.
   * Reacts by:    for a subagent's turn (`agentId` set), letting the engine
   *               finish it, then adding its usage to the agent's row. The
   *               main loop's turns are the session total's business.
   * Dispatches:   addTurn().
   */
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      await addTurn($, e.agentId, e.reason, e.usage)
    }
    return result
  })

  /**
   * LISTENER: session.measure
   *
   * Triggered by: the engine's figures being re-measured: after each main
   *               turn (never for a subagent's), and when a usage window
   *               moves a whole point. So mid-turn the figure lags: a
   *               subagent that just finished can make the subagent sum
   *               briefly exceed it.
   * Reacts by:    copying the session's cost (always the full current
   *               figure, whatever `changed` names) for the pane's total.
   * Dispatches:   a write to 'sessionUsd' (the pane redraws).
   */
  on('session.measure', async ($, e, next) => {
    if (e.cost !== undefined) {
      const usd = e.cost.usd
      await update($, sessionUsdAtom, () => usd)
    }
    return next(e)
  })

  /**
   * LISTENER: session.end
   *
   * Triggered by: the conversation ending. A /clear (reason `clear`) or an
   *               in-place resume (`resume`) keeps the process under a new
   *               conversation, with no session.start after.
   * Reacts by:    on those two, forgetting every row and the session figure:
   *               Claude Code's cost starts over on a /clear, so the pane
   *               compares like with like. On a resume it doesn't quite: the
   *               resumed session's cost counts from its first launch, and
   *               includes subagents this list no longer has.
   * Dispatches:   writes to 'agents' and 'sessionUsd'.
   *
   * All session.end hooks share one short time bound, so this does two
   * state writes and nothing slow.
   */
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, agentsAtom, () => ({}))
      await update($, sessionUsdAtom, () => null)
    }
    return next(e)
  })

  /**
   * LISTENER: session.start
   *
   * Triggered by: the process starting, and each fresh load of this module.
   * Reacts by:    registering /agent-spend (commands are the module's, so
   *               each load registers again). The pane isn't opened here:
   *               it opens when the user asks for it.
   */
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-spend',
      description: 'Open a pane with each subagent’s tokens and estimated cost',
    })
    return next(e)
  })

  /**
   * LISTENER: command.run (/agent-spend)
   *
   * Triggered by: the user typing /agent-spend.
   * Reacts by:    opening the pane (opened by the user's own command, it
   *               seats at any width; opening it again just brings it back)
   *               and answering with a one-line summary.
   * Dispatches:   $.ui.open, which raises the pane's ui.render.
   */
  on('command.run', { command: 'agent-spend' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agent spend' })
    const rows = Object.values(await read($, agentsAtom))
    const total = rows.reduce((sum, row) => sum + row.usd, 0)
    // Same wording as the pane's footer: an unpriced model is said, not hidden in $0.00.
    const unpriced = rows.some(row => row.hasUnpriced) ? ' + unpriced' : ''
    return {
      text: `Agent spend pane opened: ${rows.length} subagent${rows.length === 1 ? '' : 's'}, ≈ $${total.toFixed(2)}${unpriced}.`,
    }
  })

  /**
   * RENDER: the pane (component 'Pane', id 'agent-spend')
   *
   * Triggered by: the pane opening, and again whenever 'agents' or
   *               'sessionUsd' is written.
   * Reacts by:    drawing the table from paneLines(), whole. A pane scrolls
   *               on its own, so the tree isn't trimmed to fit; its room is
   *               `e.props.scroll.bodyRows` by `e.props.bodyColumns`, while
   *               `e.viewport` is the whole screen, not the pane. Running
   *               rows are plain, finished ones dim, failed ones red.
   * Dispatches:   nothing. It only draws.
   */
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = Object.values(await read($, agentsAtom))
    const lines = paneLines(rows, await read($, sessionUsdAtom), e.props.bodyColumns)


    return (
      <Box flexDirection="column">
        {lines.map(({ text, tone }) =>
          tone === 'header' ? (
            <Text bold>{text}</Text>
          ) : tone === 'failed' ? (
            <Text color="error">{text}</Text>
          ) : tone === 'running' ? (
            <Text>{text}</Text>
          ) : (
            <Text dimColor>{text}</Text>
          ),
        )}
      </Box>
    )
  })
}
