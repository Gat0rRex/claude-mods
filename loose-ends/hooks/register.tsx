// loose-ends: the hooks module.
//
// ROLE
// The rule: temporary services and ports get stopped when their goal is met,
// with nothing left dangling. Nothing checked that rule; it relied on Claude
// remembering. This mod keeps a list of what Claude started that may still be
// running, shows it in the band above the prompt, and tells the model about
// it when the user sends their next message, so a leftover is seen by both.
//
// WHAT IT TRACKS, AND WHERE EACH FACT COMES FROM
// - Background shells (Bash or PowerShell with run_in_background, or a
//   command that timed out and was moved to the background). Known from the
//   tool's own result (`backgroundTaskId`). Gone when TaskStop stops it, or
//   when its completion notification arrives.
// - Terminal-panel tabs Claude opened, and preview (dev) servers. These are
//   the desktop app's own MCP servers, and each can list what is open, so
//   instead of reconstructing them from tool calls the mod asks for the
//   truth after every main turn. Outside the desktop app those servers do
//   not exist; the calls fail and the lists stay empty.
//
// EVENT FLOW
//   tool.call Bash/PowerShell ──(background id)──> addShell()    ─┐
//   tool.call TaskStop ─────────(stopped id)─────> removeShells() ─┤
//   prompt.submit (task notification) ─(ids)─────> removeShells() ─┼─> $.state ──> ui.render AbovePrompt
//   turn.complete (main) ─┐                                         │
//   session.start (seed) ─┴──> refreshListings() ─> tabs, previews ─┘
//
//   prompt.submit (the user typed) ──> reads $.state ──> adds one context line for the model
//
// SHARING THE BAND
// The band above the prompt is one slot shared by every mod hooking it. This
// mod draws its line above whatever the chain beneath draws (`await next(e)`),
// so it never hides another mod's line.
//
// FAILURE MODE: FAIL OPEN, ON PURPOSE
// `claude plugin validate` lists the tool.call and prompt.submit hooks as
// "gating hook without .catch", because hooks on those events *could* refuse
// a call or drop a prompt. These never do; they only watch. Leaving off
// `.catch` means a hook that throws is skipped and the tool call or prompt
// goes ahead untouched. A tracker must never block Claude's work, so that is
// the right failure. (Contrast a settings guard, which fails loud on purpose.)

import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { LooseEnd } from '../types'

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// Atoms are named slots in the host's session state (`$.state`), declared in
// types/index.d.ts. They survive a hot reload; module variables do not.
// Writing one redraws every drawing that read it.
const shellsAtom = atom({ plugin: 'loose-ends', key: 'shells' } as const, {})
const tabsAtom = atom({ plugin: 'loose-ends', key: 'tabs' } as const, [])
const previewsAtom = atom({ plugin: 'loose-ends', key: 'previews' } as const, [])

// The desktop app's MCP servers, by the spelling their tool names use
// (`mcp__terminal__list_terminal_tabs`); `$.mcp.call` accepts that spelling.
const TERMINAL_SERVER = 'terminal'
const BROWSER_SERVER = 'Claude_Browser'

// How many items the band names before it says "+N more".
const NAMED_IN_BAND = 3

// ---------------------------------------------------------------------------
// Parsing helpers (pure)
// ---------------------------------------------------------------------------

/** First line of a command, cut to `max` characters, for a one-line label. */
function shortLabel(text: string, max = 40): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine
}

/**
 * Reads the finished task ids out of a task notification's text.
 *
 * The engine delivers a background task's end to the model as a message made
 * of `<task-notification>` blocks, each with a `<task-id>` and a `<status>`
 * (`completed`, `failed`, `killed`, ...). A block whose status is still
 * `running` or `pending` is a progress note, not an end, so it is skipped.
 * A block with no status is treated as an end: notifications are sent when a
 * task stops, and a stale entry is worse than a dropped one only if the task
 * really is still running, which a progress note would have said.
 */
export function finishedTaskIds(text: string): string[] {
  const ids: string[] = []
  for (const block of text.split('<task-notification>').slice(1)) {
    const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(block)?.[1]
    const status = /<status>\s*([A-Za-z_-]+)\s*<\/status>/.exec(block)?.[1]?.toLowerCase()
    if (id !== undefined && status !== 'running' && status !== 'pending') {
      ids.push(id)
    }
  }
  return ids
}

/** The text blocks of an MCP result, joined: where these servers put their JSON. */
function resultText(result: McpToolResult): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/**
 * The terminal tabs Claude opened, from `list_terminal_tabs`' JSON array:
 * `[{ tab_id, title, opened_by: 'user' | 'claude', ... }]`. The user's own
 * tabs are theirs to manage, so only `opened_by: 'claude'` counts.
 */
export function claudeTabs(text: string): LooseEnd[] {
  const rows: unknown = JSON.parse(text)
  if (!Array.isArray(rows)) {
    return []
  }
  return rows
    .filter(row => row?.opened_by === 'claude' && typeof row?.tab_id === 'string')
    .map(row => ({ id: String(row.tab_id), label: `terminal "${row.title ?? row.tab_id}"` }))
}

/**
 * The preview servers, from `preview_list`'s text: a JSON array of process
 * entries first, then a blank line and notes about the browser tabs. The
 * entries' field names are not documented, so the id and name are read
 * tolerantly (`serverId`, then `id`; `name`, then the id).
 */
export function previewServers(text: string): LooseEnd[] {
  const head = text.split(/\r?\n\s*\r?\n/, 1)[0] ?? ''
  const rows: unknown = JSON.parse(head)
  if (!Array.isArray(rows)) {
    return []
  }
  return rows.flatMap(row => {
    const id = row?.serverId ?? row?.id ?? row?.name
    if (id === undefined) {
      return []
    }
    return [{ id: String(id), label: `preview "${row?.name ?? id}"` }]
  })
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * JOB: remember a background shell.
 *
 * Triggered by: the Bash and PowerShell listeners, when the tool's result
 *               carries a `backgroundTaskId`.
 * Dispatches:   a write to 'shells' (the band redraws).
 */
async function addShell($: EngineInterface, id: string, label: string): Promise<void> {
  await update($, shellsAtom, shells => ({ ...shells, [id]: { id, label: `shell "${label}"` } }))
}

/**
 * JOB: forget background shells that ended.
 *
 * Triggered by: the TaskStop listener (Claude stopped one) and the
 *               prompt.submit listener (a completion notification arrived).
 * Dispatches:   a write to 'shells' when any id was known (the band redraws).
 *               Ids that were never shells here (a subagent's, a monitor's)
 *               are ignored.
 */
async function removeShells($: EngineInterface, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return
  }
  await update($, shellsAtom, shells => {
    const kept = { ...shells }
    for (const id of ids) {
      delete kept[id]
    }
    return kept
  })
}

/**
 * JOB: ask the desktop app what is still open.
 *
 * Triggered by: the turn.complete listener (main loop only) and once by the
 *               session.start listener.
 * Calls:        `list_terminal_tabs` and `preview_list` on the app's own MCP
 *               servers. `$.mcp.call` raises no permission prompt (the
 *               plugin's call is the grant), and both tools only list.
 * Dispatches:   writes to 'tabs' and 'previews' (the band redraws).
 *
 * Each listing fails on its own (the server is absent outside the desktop
 * app, or its output changed shape); a failure empties that list rather than
 * keeping a stale one, so the band never names something that may be gone.
 */
async function refreshListings($: EngineInterface): Promise<void> {
  const [tabs, previews] = await Promise.all([
    $.mcp
      .call(TERMINAL_SERVER, 'list_terminal_tabs', {})
      .then(result => (result.isError ? [] : claudeTabs(resultText(result))))
      .catch(() => []),
    $.mcp
      .call(BROWSER_SERVER, 'preview_list', {})
      .then(result => (result.isError ? [] : previewServers(resultText(result))))
      .catch(() => []),
  ])
  await update($, tabsAtom, () => tabs)
  await update($, previewsAtom, () => previews)
}

/** Everything still running, in band order: shells, tabs, previews. */
async function looseEnds($: EngineInterface): Promise<LooseEnd[]> {
  const shells = Object.values(await read($, shellsAtom))
  return [...shells, ...(await read($, tabsAtom)), ...(await read($, previewsAtom))]
}

/** "a · b · c +2 more": the band's (and the model note's) list. */
function describe(ends: readonly LooseEnd[]): string {
  const named = ends.slice(0, NAMED_IN_BAND).map(end => end.label).join(' · ')
  const more = ends.length - NAMED_IN_BAND
  return more > 0 ? `${named} +${more} more` : named
}

// ---------------------------------------------------------------------------
// Registration: the listeners
// ---------------------------------------------------------------------------

export const register: Register = on => {
  /**
   * LISTENER: tool.call (Bash, and PowerShell below)
   *
   * Triggered by: any shell call, in the main loop or a subagent's.
   * Reacts by:    letting the call run (`await next(e)`), then reading its
   *               result: a `backgroundTaskId` means the command is now
   *               running on its own. That covers run_in_background, a
   *               command moved there by its timeout, and one the user moved
   *               with ctrl+b.
   * Skips:        any shell started inside a subagent (`agentId` set). A
   *               synchronous subagent's background command dies with its
   *               final response; a background subagent's survives it, but
   *               its end notification goes to that agent's own loop, which
   *               the main prompt.submit never sees, so it would sit in the
   *               band forever. The main loop's shells are the ones the rule
   *               in the header is about.
   * Dispatches:   addShell().
   */
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.result !== undefined && ran.isError === undefined) {
      const id = ran.result.backgroundTaskId
      if (id !== undefined && ran.result.backgroundEndsWithFinalResponse !== true) {
        await addShell($, id, shortLabel(e.description ?? e.command))
      }
    }
    return ran
  })

  // The same listener for PowerShell, whose result carries the same fields.
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.result !== undefined && ran.isError === undefined) {
      const id = ran.result.backgroundTaskId
      if (id !== undefined && ran.result.backgroundEndsWithFinalResponse !== true) {
        await addShell($, id, shortLabel(e.description ?? e.command))
      }
    }
    return ran
  })

  /**
   * LISTENER: tool.call (TaskStop)
   *
   * Triggered by: Claude stopping a background task.
   * Reacts by:    letting it run, then forgetting the stopped id when the
   *               stop succeeded (the result names the id it stopped).
   * Dispatches:   removeShells().
   */
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result !== undefined && ran.isError === undefined) {
      await removeShells($, [ran.result.task_id])
    }
    return ran
  })

  /**
   * LISTENER: prompt.submit
   *
   * Triggered by: every prompt entering the session: the user's, a task
   *               notification, a peer's, a plugin's.
   * Reacts by:    two things, by where the prompt came from (`origin.kind`).
   *               - A task notification: forget the shells it says ended.
   *               - The user's own prompt (`composer`, or `bridge` from a
   *                 phone or the web through Remote Control): if anything is
   *                 still running, add one line of context for the model (the
   *                 user never sees it) so Claude can stop what it no longer
   *                 needs.
   * Dispatches:   removeShells(); a rewritten prompt carrying the context.
   */
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      await removeShells($, finishedTaskIds(e.text))
      return next(e)
    }

    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const ends = await looseEnds($)
      if (ends.length > 0) {
        const note =
          `Still running from this session (loose-ends mod): ${ends.map(end => end.label).join(', ')}. ` +
          `Stop temporary services when their goal is met; keep any that are still needed.`
        return next({ ...e, context: [...(e.context ?? []), note] })
      }
    }

    return next(e)
  })

  /**
   * LISTENER: turn.complete
   *
   * Triggered by: the end of every turn, the main loop's and each
   *               subagent's.
   * Reacts by:    on the main loop only (no `agentId`), re-listing the
   *               terminal tabs and preview servers. The main turn's end is
   *               when the user looks at the band, and a subagent's turn would
   *               only repeat the work. It lets the engine finish the turn
   *               first (`await next(e)`), so two MCP round trips never
   *               delay the turn's completion or the hooks beneath.
   * Dispatches:   refreshListings().
   */
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await refreshListings($)
    }
    return result
  })

  /**
   * LISTENER: session.start
   *
   * Triggered by: the process starting, and each fresh load of this module.
   *               Never by a /clear: that raises only session.end (below).
   * Reacts by:    listing once, so tabs and servers left from earlier in the
   *               session show without waiting for a turn.
   * Dispatches:   refreshListings().
   */
  on('session.start', async ($, e, next) => {
    await refreshListings($)
    return next(e)
  })

  /**
   * LISTENER: session.end
   *
   * Triggered by: the conversation ending. A /clear (reason `clear`) and an
   *               in-place resume (`resume`) keep the process running under
   *               a new conversation, with no session.start after.
   * Reacts by:    on those two, forgetting the shells. Their end
   *               notifications belong to the old conversation and can no
   *               longer reach this one's prompt.submit, so every entry would
   *               stay in the band for good. Tabs and preview servers are
   *               left alone: the next turn's listing is the truth for them.
   * Dispatches:   a write to 'shells' (the band redraws).
   *
   * All session.end hooks share one short time bound (1.5 s by default), so
   * this does one state write and nothing slow.
   */
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, shellsAtom, () => ({}))
    }
    return next(e)
  })

  /**
   * RENDER: the band above the prompt (component 'AbovePrompt')
   *
   * Triggered by: the surface drawing the band, and again whenever an atom
   *               this hook read is written.
   * Reacts by:    drawing one line above the chain beneath, when anything is
   *               still running. Dim while a turn runs (Claude may still be
   *               using it); amber once the turn is over and it is still up.
   * Dispatches:   nothing. It only draws.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const ends = await looseEnds($)
    if (ends.length === 0) {
      return next(e)
    }

    const beneath = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const text = `Still running: ${describe(ends)}`

    return (
      <Box flexDirection="column">
        {e.props.isWorking ? <Text dimColor>{text}</Text> : <Text color="warning">{text}</Text>}
        {beneath}
      </Box>
    )
  })
}
