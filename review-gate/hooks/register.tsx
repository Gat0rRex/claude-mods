// review-gate: the hooks module.
//
// ROLE
// A review workflow: code written by one agent gets a review from a stronger
// reviewer agent, each part of a system is reviewed before the next part
// starts, and anything touching a database gets a database reviewer before it
// is called done. Nothing checked that workflow; it relied on Claude
// remembering. This mod keeps the list of files edited since a reviewer last
// finished, shows it in the band above the prompt, and tells the model about
// it when the user sends their next message.
//
// Which agents count as reviewers is a plain list of agent type names
// (GENERAL_REVIEWERS and DB_REVIEWER below; reviewer-opus, senior-fable and
// db-adversarial-reviewer by default). Edit them to match your own agents.
//
// HOW A FILE GETS CLEARED
// Every edit takes the next number from a counter (`seq`), and the file
// remembers the number of its latest edit. When a reviewer agent is spawned
// it remembers the counter as it stood (`reviewsUpTo`): anything edited after
// that can't be in what it read. When that reviewer's turn ends with an
// answer, every file whose latest edit is at or below its number is cleared.
// The mod can't see which files the reviewer actually read, so a finished
// review counts for everything edited before it started. That is the
// trade-off: cheap and honest about time, blind to scope.
//
// Two kinds of file, two kinds of reviewer:
// - General reviewers (the agent types in GENERAL_REVIEWERS) clear ordinary
//   files. feature-dev:code-reviewer is left out on purpose: it runs on
//   Sonnet, and a Sonnet review is weaker than the stronger-model review this
//   gate is meant to enforce.
// - Database files (paths matching the globs in isDbPath, which were copied
//   from an optional rules file at ~/.claude/rules/database-review.md; see
//   the README) are only cleared by the database reviewer (DB_REVIEWER),
//   which clears nothing else.
//
// Not counted: notes and docs (.md, .txt), anything under an "Obsidian Docs"
// folder (the default notes-vault location), and session scratchpads under
// the temp folder. They aren't code to review.
//
// EVENT FLOW
//   tool.call Edit/Write/NotebookEdit (any loop) ──> recordEdit()   ─┐
//   agent.spawn (a reviewer type) ─────────────────> addReviewer()  ─┼─> $.state 'gate' ──> ui.render AbovePrompt
//   turn.complete (a reviewer's loop) ─────────────> finishReview() ─┤
//   command.run /review-gate clear ────────────────> empties 'pending' ┘
//   each of the three changes above ───────────────> saveGate() ─> $.store 'gate:<root>'
//   session.start / turn.start ────────────────────> ensureLoaded() <─ $.store 'gate:<root>'
//   session.end (/clear, files waiting) ───────────> a toast naming the count
//
//   prompt.submit (the user typed) ──> reads 'gate' ──> adds one context line for the model
//
// SURVIVING A RESTART
// `$.state` lives with the session's process: an app restart starts it
// empty. So the counter and the pending files are also saved in `$.store`
// (a JSON file of the plugin's own, kept between sessions), one key per
// project root: `gate:<root>`. The root is the session's at the first load
// and stays pinned: a later `/cd` keeps writing to the same key. A git
// worktree is its own root, so its own list (it is its own checkout). The
// root is used as the host spells it, so `c:\` and `C:\` would be two lists.
// The list is loaded when the session starts (or before the first edit, if
// that comes first) and saved after every change; an empty list deletes its
// key. Reviewers in flight are not saved: they die with the process, and
// their answers can't arrive afterwards. The store is a lagging copy and
// `$.state` stays the authority: two saves that overlap can land out of
// order, which the next change's save repairs; only a crash in that window
// loses that one save. Two sessions open on the same project share the key,
// and the last save wins; the next change in either session writes its own
// view again.
//
// SHARING THE BAND
// The band above the prompt is one slot shared by every mod hooking it. This
// mod draws its line above whatever the chain beneath draws (`await next(e)`),
// so it never hides another mod's line.
//
// FAILURE MODE: FAIL OPEN, ON PURPOSE
// `claude plugin validate` lists the tool.call, agent.spawn and prompt.submit
// hooks as "gating hook without .catch", because hooks on those events
// *could* refuse a call. These never do; they only watch. Leaving off
// `.catch` means a hook that throws is skipped and the call goes ahead
// untouched. A tracker must never block Claude's work.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Gate, PendingEdit, SavedGate } from '../types'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The edit tools and the input field each names its file in. Checked by name
// on an unmatched tool.call hook, so a tool this build lacks (MultiEdit, say)
// can't fail validation.
const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

// Agent types whose finished answer counts as a review of ordinary files.
// Edit this set to match your own agents. A plugin's agent is spelled
// `<plugin>:<name>` in agent.spawn's `subagentType`; feature-dev:code-reviewer
// would match that way, but it is a Sonnet agent, so it doesn't count (see
// the header).
const GENERAL_REVIEWERS = new Set(['reviewer-opus', 'senior-fable'])

// The only agent type that clears database files (and it clears nothing else).
// Edit it to match your own database reviewer agent.
const DB_REVIEWER = 'db-adversarial-reviewer'

// Folder names from the `**/<name>/**` patterns of an optional rules file
// (~/.claude/rules/database-review.md; copied here, not read at run time): a
// file anywhere below one of these is database work. Exact case, as the globs
// are.
const DB_FOLDERS = new Set(['migrations', 'migrate', 'models', 'Models', 'prisma', 'alembic', 'database'])

// How many file names the band shows per group before "+N more".
const NAMED_IN_BAND = 3

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// The atom is a named slot in the host's session state (`$.state`), declared
// in types/index.d.ts. It survives a hot reload; module variables do not.
// Writing it redraws every drawing that read it.
const EMPTY_GATE: Gate = { seq: 0, pending: {}, reviewers: {}, root: null }
const gateAtom = atom({ plugin: 'review-gate', key: 'gate' } as const, EMPTY_GATE)

// ---------------------------------------------------------------------------
// Path rules (pure)
// ---------------------------------------------------------------------------

/** Forward slashes, so Windows and POSIX paths compare and match alike. */
function normalise(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The last path segment, for the band. */
function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * Whether a path is database work, by these globs (the same ones as the
 * optional rules file ~/.claude/rules/database-review.md; see the README):
 * - `**\/<folder>/**` for the DB_FOLDERS: any parent folder with that name;
 * - `**\/*.sql`: the file ends in .sql;
 * - `**\/schema*`: the file's own name starts with "schema" (a `*` in a glob
 *   never crosses a `/`, so a folder called "schemas" doesn't count);
 * - `**\/*repository*` and `**\/*Repository*`: the file's name contains it.
 * The globs are copied here rather than read from that file at run time; if
 * your rules change, change this too.
 */
export function isDbPath(path: string): boolean {
  const segments = normalise(path).split('/').filter(Boolean)
  const name = segments.pop() ?? ''
  return (
    segments.some(folder => DB_FOLDERS.has(folder)) ||
    name.endsWith('.sql') ||
    name.startsWith('schema') ||
    /[rR]epository/.test(name)
  )
}

/**
 * Whether an edited path needs no code review: notes and plain text, the
 * Obsidian vaults (any path under an "Obsidian Docs" folder, the default
 * notes location; edit this to match yours), and the temp folder, where
 * session scratchpads live and die with the session.
 */
export function isExempt(path: string): boolean {
  const p = normalise(path)
  return (
    /\.(md|txt)$/i.test(p) ||
    p.includes('/Obsidian Docs/') ||
    /\/AppData\/Local\/Temp\//i.test(p)
  )
}

// ---------------------------------------------------------------------------
// Describing the gate (pure)
// ---------------------------------------------------------------------------

/** "a.py, b.ts, c.ts +2 more", in edit order. */
function nameList(edits: readonly PendingEdit[]): string {
  const named = edits.slice(0, NAMED_IN_BAND).map(edit => baseName(edit.path)).join(', ')
  const more = edits.length - NAMED_IN_BAND
  return more > 0 ? `${named} +${more} more` : named
}

/** Pending files split into ordinary and database, each oldest edit first. */
function pendingGroups(gate: Gate): { general: PendingEdit[]; db: PendingEdit[] } {
  const all = Object.values(gate.pending).sort((a, b) => a.seq - b.seq)
  return { general: all.filter(edit => !edit.isDb), db: all.filter(edit => edit.isDb) }
}

/**
 * The band's line and how loud it is, or null when nothing waits.
 * - 'dim': a reviewer is running, so the gate is being dealt with.
 * - 'warning' (amber): ordinary files wait.
 * - 'error' (red): database files wait; that review is mandatory.
 * The render hook also dims everything while a turn is running.
 */
export function describeGate(gate: Gate): { text: string; look: 'dim' | 'warning' | 'error' } | null {
  const { general, db } = pendingGroups(gate)
  if (general.length === 0 && db.length === 0) {
    return null
  }

  const parts: string[] = []
  if (general.length > 0) {
    parts.push(`${general.length} file${general.length === 1 ? '' : 's'} unreviewed (${nameList(general)})`)
  }
  if (db.length > 0) {
    parts.push(`${db.length} DB file${db.length === 1 ? '' : 's'} await ${DB_REVIEWER} (${nameList(db)})`)
  }
  const isReviewing = Object.keys(gate.reviewers).length > 0
  if (isReviewing) {
    parts.push('review running')
  }

  const look = isReviewing ? 'dim' : db.length > 0 ? 'error' : 'warning'
  return { text: `Review gate: ${parts.join(' · ')}`, look }
}

// ---------------------------------------------------------------------------
// Saving and loading (the store side)
// ---------------------------------------------------------------------------

/** The store key for a project's list. */
function storeKey(root: string): string {
  return `gate:${root}`
}

/**
 * Reads a saved list back, or null when it is missing or not the expected
 * shape (an older version's, or edited by hand). Each entry is checked, so
 * one bad entry is dropped rather than the whole list. Exported for tests.
 */
export function parseSaved(value: unknown): SavedGate | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { seq, pending } = value as { seq?: unknown; pending?: unknown }
  if (typeof seq !== 'number' || typeof pending !== 'object' || pending === null) {
    return null
  }
  const kept: Record<string, PendingEdit> = {}
  for (const [key, edit] of Object.entries(pending as Record<string, unknown>)) {
    const { path, seq: editSeq, isDb } = (edit ?? {}) as { path?: unknown; seq?: unknown; isDb?: unknown }
    if (typeof path === 'string' && typeof editSeq === 'number' && typeof isDb === 'boolean') {
      kept[key] = { path, seq: editSeq, isDb }
    }
  }
  return { seq, pending: kept }
}

/**
 * Whether 'gate' has been loaded from the store (it names its root). A
 * `typeof` test, not `!== null`: a gate written by 0.1.0 has no `root` field
 * at all, and `$.state` survives a hot reload, so after an upgrade the field
 * reads as undefined (the atom's initial only applies to a value never
 * written). Undefined has to mean "not loaded" too. Exported for tests.
 */
export function isLoaded(gate: { root?: unknown }): boolean {
  return typeof gate.root === 'string'
}

/**
 * JOB: load this project's saved list into the session, once.
 *
 * Triggered by: session.start, turn.start, and the start of each change
 *               job, so the list is in place before anything reads or
 *               changes it. A no-op once 'gate' names its root.
 * Calls:        `$.session.root()` and `$.store.get('gate:<root>')`. A store
 *               that fails to read counts as nothing saved: the gate still
 *               works for this session, it just starts empty.
 * Dispatches:   one write to 'gate': the saved files merged with any already
 *               held, the counter at the higher of the two, the root set.
 */
async function ensureLoaded($: EngineInterface): Promise<void> {
  if (isLoaded(await read($, gateAtom))) {
    return
  }
  // No root (a host error, a hook refusing it): stay unloaded, so the gate
  // works for this session alone and tries again on the next call.
  const rawRoot = await $.session.root().catch(() => undefined)
  if (rawRoot === undefined) {
    return
  }
  const root = normalise(rawRoot)
  const saved = parseSaved(await $.store.get(storeKey(root)).catch(() => undefined))
  await update($, gateAtom, gate =>
    isLoaded(gate)
      ? gate // another hook loaded it while this one read the store
      : {
          ...gate,
          root,
          seq: Math.max(gate.seq, saved?.seq ?? 0),
          pending: { ...(saved?.pending ?? {}), ...gate.pending },
        },
  )
}

/**
 * JOB: save the list for this project.
 *
 * Triggered by: each change job (recordEdit, finishReview, the clear
 *               command), right after its write to 'gate'.
 * Reads:        'gate' as it stands now, the whole list. Two saves that
 *               overlap (a subagent's edit as a reviewer finishes) can land
 *               out of order and leave the store one change behind; the
 *               next change writes the full list again. Serialising saves
 *               isn't worth it for a copy that only matters after a crash.
 * Dispatches:   `$.store.set('gate:<root>', { seq, pending })`, or
 *               `$.store.delete` when nothing waits, so finished projects
 *               leave no key behind. A failed save is dropped: persistence
 *               is a convenience, never a reason to fail a tool call.
 */
async function saveGate($: EngineInterface): Promise<void> {
  const gate = await read($, gateAtom)
  // Not loaded (see isLoaded): no root, so nowhere to save.
  if (!isLoaded(gate) || gate.root === null) {
    return
  }
  const key = storeKey(gate.root)
  const saving =
    Object.keys(gate.pending).length === 0
      ? $.store.delete(key)
      : $.store.set(key, { seq: gate.seq, pending: gate.pending } satisfies SavedGate)
  await saving.catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * JOB: record an edit.
 *
 * Triggered by: the tool.call listener, after an edit tool succeeded.
 * Dispatches:   one write to 'gate': the counter moves on and the file is
 *               (re)marked pending with the new number, so a reviewer
 *               already running no longer covers it; then saveGate().
 */
async function recordEdit($: EngineInterface, rawPath: string): Promise<void> {
  await ensureLoaded($)
  const path = normalise(rawPath)
  await update($, gateAtom, gate => {
    const seq = gate.seq + 1
    return { ...gate, seq, pending: { ...gate.pending, [path]: { path, seq, isDb: isDbPath(path) } } }
  })
  await saveGate($)
}

/**
 * JOB: remember a reviewer that started.
 *
 * Triggered by: the agent.spawn listener, for a reviewer type.
 * Dispatches:   a write to 'gate' adding the reviewer under its agent id,
 *               with the counter as it stood before the spawn.
 */
async function addReviewer($: EngineInterface, agentId: string, type: string, reviewsUpTo: number): Promise<void> {
  await update($, gateAtom, gate => ({ ...gate, reviewers: { ...gate.reviewers, [agentId]: { type, reviewsUpTo } } }))
}

/**
 * JOB: settle a reviewer whose turn ended.
 *
 * Triggered by: the turn.complete listener, when the turn's loop is a
 *               reviewer this mod is tracking.
 * Dispatches:   one write to 'gate': the reviewer is dropped, and if it
 *               answered (not interrupted, not an API error), the files it
 *               covers are cleared: ordinary files for a general reviewer,
 *               database files for db-adversarial-reviewer, and in both
 *               cases only those last edited before it was spawned; then
 *               saveGate().
 */
async function finishReview($: EngineInterface, agentId: string, didAnswer: boolean): Promise<void> {
  await ensureLoaded($)
  await update($, gateAtom, gate => {
    const reviewer = gate.reviewers[agentId]
    if (reviewer === undefined) {
      return gate
    }
    const reviewers = { ...gate.reviewers }
    delete reviewers[agentId]

    const clearsDb = reviewer.type === DB_REVIEWER
    const pending = { ...gate.pending }
    if (didAnswer) {
      for (const [key, edit] of Object.entries(pending)) {
        if (edit.isDb === clearsDb && edit.seq <= reviewer.reviewsUpTo) {
          delete pending[key]
        }
      }
    }
    return { ...gate, pending, reviewers }
  })
  await saveGate($)
}

// ---------------------------------------------------------------------------
// Registration: the listeners
// ---------------------------------------------------------------------------

export const register: Register = on => {
  /**
   * LISTENER: tool.call (every tool; only the edit tools matter)
   *
   * Triggered by: any tool call in any loop, the main one or a subagent's. A
   *               worker's edits need review as much as Claude's own.
   * Reacts by:    letting the call run, then recording the file if the edit
   *               succeeded and the file isn't exempt.
   * Skips:        a held write (`staged: true`: the write waits for the
   *               machine owner's review and the file is unchanged).
   * Dispatches:   recordEdit().
   */
  on('tool.call', async ($, e, next) => {
    const field = EDIT_TOOLS[e.tool]
    if (field === undefined) {
      return next(e)
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError !== undefined) {
      return ran
    }
    // On a hook with no tool matcher `ran.result` is untyped, so read the two
    // fields loosely. The path the tool reports (`filePath`) is the one it
    // wrote; the input's own field (spread beside `tool` on `e`, named per
    // tool) is the fallback.
    // NotebookEdit reports its own failure in `error` (no `isError`), so a
    // failed notebook edit is skipped too.
    const record = (ran.result ?? {}) as { filePath?: unknown; staged?: unknown; error?: unknown }
    const path = record.filePath ?? (e as unknown as Record<string, unknown>)[field]
    if (record.staged !== true && record.error === undefined && typeof path === 'string' && !isExempt(path)) {
      await recordEdit($, path)
    }
    return ran
  })

  /**
   * LISTENER: agent.spawn
   *
   * Triggered by: the Agent tool (or a workflow script) about to start a
   *               subagent.
   * Reacts by:    for a reviewer type only, reading the edit counter first
   *               (the reviewer sees the files as they are now), letting the
   *               spawn go ahead, then remembering the reviewer by the id
   *               the spawn resolves to. A workflow's remote agent has no
   *               local loop and no id, so it can't be followed and is
   *               skipped; its review then doesn't clear anything.
   * Dispatches:   addReviewer().
   */
  on('agent.spawn', async ($, e, next) => {
    const isReviewer = GENERAL_REVIEWERS.has(e.subagentType) || e.subagentType === DB_REVIEWER
    if (!isReviewer) {
      return next(e)
    }
    const reviewsUpTo = (await read($, gateAtom)).seq
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      await addReviewer($, spawned.agentId, e.subagentType, reviewsUpTo)
    }
    return spawned
  })

  /**
   * LISTENER: turn.complete
   *
   * Triggered by: the end of every turn, the main loop's and each
   *               subagent's. A subagent's whole run is one turn, so its
   *               turn.complete is its finish, carrying its `agentId`. A
   *               resumed agent (SendMessage) or a teammate runs more turns
   *               under the same id; the reviewer is dropped at its first,
   *               so only its first answer clears anything. Deliberately
   *               conservative: a later turn can't say what it re-read.
   * Reacts by:    when the turn is a tracked reviewer's, letting the engine
   *               finish the turn first, then settling the review. Only
   *               reason `answer` clears files: an interrupted or failed
   *               review didn't review anything.
   * Dispatches:   finishReview().
   */
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined && (await read($, gateAtom)).reviewers[e.agentId] !== undefined) {
      await finishReview($, e.agentId, e.reason === 'answer')
    }
    return result
  })

  /**
   * LISTENER: prompt.submit
   *
   * Triggered by: every prompt entering the session.
   * Reacts by:    for the user's own prompts (`composer`, or `bridge` through
   *               Remote Control) while files wait, adding one line of
   *               context for the model (the user never sees it): which
   *               files are unreviewed. It doesn't restate the review rules
   *               (a CLAUDE.md can carry them), so it informs without
   *               pushing Claude to spawn a reviewer on every message.
   * Dispatches:   a rewritten prompt carrying the context.
   */
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return next(e)
    }
    const { general, db } = pendingGroups(await read($, gateAtom))
    if (general.length === 0 && db.length === 0) {
      return next(e)
    }
    const lines: string[] = []
    if (general.length > 0) {
      lines.push(`edited since the last finished review: ${general.map(edit => edit.path).join(', ')}`)
    }
    if (db.length > 0) {
      lines.push(`database files awaiting ${DB_REVIEWER}: ${db.map(edit => edit.path).join(', ')}`)
    }
    const note = `Review gate (review-gate mod): ${lines.join('; ')}.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  /**
   * LISTENER: session.end
   *
   * Triggered by: the conversation ending; a /clear (reason `clear`) keeps
   *               the process under a new conversation.
   * Reacts by:    on a /clear with files still waiting, a toast saying so.
   *               A /clear usually marks a task boundary, exactly when an
   *               unreviewed change matters. The list itself is not lost:
   *               it is saved per project and comes back in the new
   *               conversation (see SURVIVING A RESTART).
   * Dispatches:   $.ui.toast. One read and one toast, inside the short time
   *               bound all session.end hooks share.
   */
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const { general, db } = pendingGroups(await read($, gateAtom))
      const count = general.length + db.length
      if (count > 0) {
        const dbPart = db.length > 0 ? ` (${db.length} database)` : ''
        await $.ui.toast(`Cleared with ${count} file${count === 1 ? '' : 's'}${dbPart} edited and not reviewed.`)
      }
    }
    return next(e)
  })

  /**
   * LISTENER: session.start
   *
   * Triggered by: the process starting, and each fresh load of this module.
   * Reacts by:    registering the /review-gate command (commands are the
   *               module's, so each load registers again), and loading the
   *               project's saved list, so files left unreviewed before a
   *               restart show at once.
   * Dispatches:   ensureLoaded().
   */
  on('session.start', async ($, e, next) => {
    // The command first: loading can't then cost the command.
    await $.command.register({
      name: 'review-gate',
      description: 'List the files waiting for review; "/review-gate clear" marks them all reviewed',
    })
    await ensureLoaded($)
    return next(e)
  })

  /**
   * LISTENER: turn.start
   *
   * Triggered by: a main-loop turn starting: a prompt, or a continuation
   *               turn the engine starts itself (empty text).
   * Reacts by:    loading the saved list if this session's 'gate' has none
   *               yet: the case if the host ever starts `$.state` over
   *               without a session.start (the API leaves /clear
   *               unspecified). One state read when already loaded.
   * Dispatches:   ensureLoaded().
   */
  on('turn.start', async ($, e, next) => {
    await ensureLoaded($)
    return next(e)
  })

  /**
   * LISTENER: command.run (/review-gate)
   *
   * Triggered by: the user typing /review-gate, with or without `clear`.
   * Reacts by:    with `clear`, emptying the pending list (the user reviewed
   *               the files themselves, or they need none). Otherwise,
   *               listing every waiting file by full path, which the band
   *               can't fit.
   * Dispatches:   a write to 'gate' and saveGate() (which deletes the saved
   *               key) for `clear`; the text shown to the user.
   *
   * Reviewers in flight are kept on `clear`, so one that finishes later is
   * still settled; it has nothing left to clear, which is harmless.
   */
  on('command.run', { command: 'review-gate' }, async ($, e) => {
    await ensureLoaded($)
    if (e.args.trim() === 'clear') {
      const before = Object.keys((await read($, gateAtom)).pending).length
      await update($, gateAtom, gate => ({ ...gate, pending: {} }))
      await saveGate($)
      return { text: `Review gate cleared (${before} file${before === 1 ? '' : 's'} marked reviewed).` }
    }

    const gate = await read($, gateAtom)
    const { general, db } = pendingGroups(gate)
    if (general.length === 0 && db.length === 0) {
      return { text: 'Review gate: nothing waiting for review.' }
    }
    const lines = [
      ...(general.length > 0 ? ['Unreviewed:', ...general.map(edit => `  ${edit.path}`)] : []),
      ...(db.length > 0 ? [`Awaiting ${DB_REVIEWER}:`, ...db.map(edit => `  ${edit.path}`)] : []),
      ...Object.values(gate.reviewers).map(reviewer => `Running: ${reviewer.type}`),
    ]
    return { text: lines.join('\n') }
  })

  /**
   * RENDER: the band above the prompt (component 'AbovePrompt')
   *
   * Triggered by: the surface drawing the band, and again whenever 'gate'
   *               is written.
   * Reacts by:    drawing one line above the chain beneath while files wait.
   *               Dim while a turn runs (the work isn't finished) or a
   *               reviewer runs; otherwise amber, or red for database files.
   * Dispatches:   nothing. It only draws.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const band = describeGate(await read($, gateAtom))
    if (band === null) {
      return next(e)
    }

    const beneath = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const look = e.props.isWorking ? 'dim' : band.look

    return (
      <Box flexDirection="column">
        {look === 'dim' ? (
          <Text dimColor>{band.text}</Text>
        ) : (
          // Theme keys follow the person's colour theme rather than fixed colours.
          <Text color={look}>{band.text}</Text>
        )}
        {beneath}
      </Box>
    )
  })
}
