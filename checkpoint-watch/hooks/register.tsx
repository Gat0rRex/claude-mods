// checkpoint-watch: the hooks module.
//
// ROLE
// The convention: every milestone, launch or held decision updates the
// project vault's `01 Overview/Checkpoint.md`, so a fresh session can resume
// there. An optional companion settings hook (a Python script named
// claude_checkpoint_hook.py, outside this repo) can *load* that note at
// session start and ask for an update after a compaction, but between those
// nothing says the note is falling behind the work. This mod does: it counts
// file edits since the note was last written and shows the gap above the
// prompt, turning amber (with one toast) once the gap is large and the note
// is old.
//
// It does not replace such a settings hook. That kind of hook injects the
// note into the model's context and saves compaction summaries; this mod
// only watches, and works with or without one.
//
// FINDING THE CHECKPOINT
// The same resolution as the companion settings hook, so both always agree
// on which note belongs to a session: walk the project root's path from the
// deepest folder up; the first folder named in the optional alias table
// (default `~/.claude/scripts/claude_checkpoint_projects.json`, see the
// README) or matching a vault folder's name (case-insensitively) under the
// vault root (the table's `vault_root`, default `~/Documents/Obsidian Docs`)
// wins. A worktree inside a repo therefore resolves to the repo's vault.
//
// EVENT FLOW
//   session.start ──────────────┐
//   turn.start (no target yet) ─┤
//   turn.complete (main) ───────┴─> refreshTarget() ─> $.state 'target' ─┐
//                              └─ note rewritten? reset the count  ├─> ui.render AbovePrompt
//   tool.call (Edit/Write/NotebookEdit) ─> countEdit() ─> 'editsSince'
//                              └─ edited the note itself? reset    └─> evaluate() ─> one toast
//
// SHARING THE BAND
// This mod draws its line above whatever the chain beneath draws
// (`await next(e)`), so it never hides another band mod's line.
//
// FAILURE MODE
// `claude plugin validate` lists the tool.call hook as a "gating hook without
// .catch". It never refuses anything; without `.catch`, a hook that throws is
// skipped and the edit goes ahead. A watcher must never block an edit.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckpointTarget } from '../types'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// "Falling behind" needs both: enough work since the note was written, and
// enough time. Many quick edits right after an update are not a gap, and an
// old note with no new work since is not one either.
const BEHIND_EDITS = 10
const BEHIND_MS = 60 * 60 * 1000

// The note's place inside a vault, as the companion settings hook and a
// `checkpoint` skill (both optional, see the README) have it.
const CHECKPOINT_REL = '01 Overview/Checkpoint.md'

// The tools that change files, and the input field each names its file in.
const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// Atoms are named slots in the host's session state (`$.state`), declared in
// types/index.d.ts. They survive a hot reload; module variables do not.
// Writing one redraws every drawing that read it.
const targetAtom = atom({ plugin: 'checkpoint-watch', key: 'target' } as const, null)
const editsSinceAtom = atom({ plugin: 'checkpoint-watch', key: 'editsSince' } as const, 0)
const hasWarnedAtom = atom({ plugin: 'checkpoint-watch', key: 'hasWarned' } as const, false)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Forward slashes, no trailing slash, lower case: for comparing Windows paths. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 95 minutes -> "1h ago"; 3 days -> "3d ago". Display only. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}

/** Is the note behind the work? Pure, so the band and the toast agree. */
function isBehind(target: CheckpointTarget, editsSince: number, now: number): boolean {
  if (editsSince < BEHIND_EDITS) {
    return false
  }
  return target.mtimeMs === null || now - target.mtimeMs >= BEHIND_MS
}

/** The optional alias table's shape (see claude_checkpoint_projects.json in the README). */
type AliasEntry = { vault?: string; vault_path?: string; name?: string }
type AliasConfig = { vault_root?: string; projects?: Record<string, AliasEntry> }

/**
 * Which vault a project root belongs to: a port of `resolve_project` in the
 * companion hook script claude_checkpoint_hook.py (outside this repo), so
 * both agree. Pure: the caller reads the files.
 *
 * Walks the path's folders from the deepest up. The first folder that is an
 * alias (its `vault` under the vault root, or its absolute `vault_path`) or
 * that names a vault folder wins.
 *
 * Empty values are treated as missing (`||`, not `??`), because Python's
 * `if alias.get("vault_path")` and `alias.get("name") or ...` skip an empty
 * string too. An alias entry `{}` is still an alias, as in Python.
 */
export function resolveVault(
  root: string,
  vaultRoot: string,
  aliases: Record<string, AliasEntry>,
  vaultDirs: readonly string[],
): { project: string; vault: string } | null {
  const byLower = new Map(vaultDirs.map(name => [name.toLowerCase(), name]))
  const lowerAliases = new Map(Object.entries(aliases).map(([key, entry]) => [key.toLowerCase(), entry]))
  const parts = root.replace(/\\/g, '/').split('/').filter(part => part !== '')

  for (const name of [...parts].reverse()) {
    const alias = lowerAliases.get(name.toLowerCase())
    if (alias !== undefined) {
      if (alias.vault_path) {
        const vault = alias.vault_path.replace(/\\/g, '/')
        return { project: alias.name || vault.split('/').filter(Boolean).pop() || vault, vault }
      }
      const vaultName = alias.vault || name
      return { project: vaultName, vault: `${vaultRoot}/${vaultName}` }
    }
    const vaultName = byLower.get(name.toLowerCase())
    if (vaultName !== undefined) {
      return { project: vaultName, vault: `${vaultRoot}/${vaultName}` }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * JOB: work out which checkpoint this session's project has, and how old it is.
 *
 * Triggered by: session.start, and the end of every main-loop turn (the
 *               project root can move with /cd or a worktree, and the user
 *               may edit the note by hand in Obsidian).
 * Reads:        the home folder (USERPROFILE on Windows, HOME elsewhere),
 *               the alias table, the vault root's folders, and the note's
 *               modification time.
 * Dispatches:   a write to 'target'. When the note is newer than last time,
 *               or the project changed, the edit count and the toast reset.
 *               Then evaluate().
 *
 * Any read that fails means "no aliases" or "no vault", as in the companion
 * settings hook: the band just stays empty.
 */
async function refreshTarget($: EngineInterface): Promise<void> {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  const config: AliasConfig = await $.fs
    .read(`${home}/.claude/scripts/claude_checkpoint_projects.json`)
    .then(text => JSON.parse(text) as AliasConfig)
    .catch(() => ({}))
  const vaultRoot = (config.vault_root || `${home}/Documents/Obsidian Docs`).replace(/\\/g, '/')
  // `$.fs.list` reports a symbolic link as `other` with `isLink`, where
  // Python's `is_dir()` follows it, so a linked vault folder counts too.
  const vaultDirs = await $.fs
    .list(vaultRoot)
    .then(entries => entries.filter(entry => entry.kind === 'dir' || entry.isLink).map(entry => entry.name))
    .catch(() => [])

  const found = resolveVault(await $.session.root(), vaultRoot, config.projects ?? {}, vaultDirs)
  let target: CheckpointTarget | null = null
  if (found !== null) {
    const path = `${found.vault}/${CHECKPOINT_REL}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    target = { project: found.project, path, mtimeMs: stat?.kind === 'file' ? stat.mtimeMs : null }
  }

  // Decide inside the update whether this is news: a different note, or the
  // same note with a different modification time (written, or restored from
  // an older copy). `update` re-runs the closure if another write landed
  // first, so the decision is made on the latest value. Every mtime stored
  // comes from `$.fs.stat`, never the clock, so "different" is safe to test.
  let isFresh = false
  await update($, targetAtom, previous => {
    const isSameNote = previous !== null && target !== null && samePath(previous.path, target.path)
    const wasRewritten = isSameNote && target?.mtimeMs !== previous?.mtimeMs
    isFresh = !isSameNote || wasRewritten
    return target
  })
  if (isFresh) {
    await markWritten($)
  }
  await evaluate($)
}

/**
 * JOB: count one file edit, or notice the checkpoint itself was edited.
 *
 * Triggered by: the tool.call listener, after an edit tool succeeded, in the
 *               main loop or a subagent's (a worker's edits are work too).
 * Dispatches:   for the note itself, its new mtime (read from disk: the
 *               disk is the source of truth, and the turn-end check compares
 *               against it; the clock only if the stat fails) and
 *               markWritten(); for any other file, +1 on 'editsSince' and
 *               evaluate().
 */
async function countEdit($: EngineInterface, path: string): Promise<void> {
  const target = await read($, targetAtom)
  if (target === null) {
    return
  }
  if (samePath(path, target.path)) {
    const stat = await $.fs.stat(target.path).catch(() => undefined)
    const mtimeMs = stat?.kind === 'file' ? stat.mtimeMs : await $.clock.now()
    await update($, targetAtom, current => (current === null ? null : { ...current, mtimeMs }))
    await markWritten($)
    return
  }
  await update($, editsSinceAtom, count => count + 1)
  await evaluate($)
}

/**
 * JOB: the note was just written: nothing is behind any more.
 *
 * Triggered by: refreshTarget() and countEdit().
 * Dispatches:   'editsSince' = 0 (the band hides) and 'hasWarned' = false
 *               (the next gap toasts again).
 */
async function markWritten($: EngineInterface): Promise<void> {
  await update($, editsSinceAtom, () => 0)
  await update($, hasWarnedAtom, () => false)
}

/**
 * JOB: toast once when the note falls behind.
 *
 * Triggered by: refreshTarget() and countEdit().
 * Dispatches:   one toast per gap. The decision is taken inside `update` on
 *               'hasWarned', so two overlapping evaluations cannot both toast.
 */
async function evaluate($: EngineInterface): Promise<void> {
  const target = await read($, targetAtom)
  if (target === null) {
    return
  }
  const editsSince = await read($, editsSinceAtom)
  const now = await $.clock.now()
  if (!isBehind(target, editsSince, now)) {
    return
  }

  let shouldToast = false
  await update($, hasWarnedAtom, hasWarned => {
    shouldToast = !hasWarned
    return true
  })
  if (shouldToast) {
    const age = target.mtimeMs === null ? 'has no checkpoint yet' : `checkpoint is ${formatAge(now - target.mtimeMs).replace(' ago', ' old')}`
    $.ui.toast(
      `${target.project} ${age}, ${editsSince} edits behind. Update it at the next milestone.`,
      { timeoutMs: 10_000 },
    )
  }
}

// ---------------------------------------------------------------------------
// Registration: the listeners
// ---------------------------------------------------------------------------

export const register: Register = on => {
  /**
   * LISTENER: session.start
   *
   * Triggered by: the process starting, and each fresh load of this module.
   * Reacts by:    finding the project's checkpoint and its age.
   * Dispatches:   refreshTarget().
   */
  on('session.start', async ($, e, next) => {
    await refreshTarget($)
    return next(e)
  })

  /**
   * LISTENER: turn.complete
   *
   * Triggered by: the end of every turn, the main loop's and each subagent's.
   * Reacts by:    on the main loop only (no `agentId`), looking again: the
   *               project may have moved, or the user may have edited the
   *               note.
   * Dispatches:   refreshTarget().
   */
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refreshTarget($)
    }
    return next(e)
  })

  /**
   * LISTENER: turn.start
   *
   * Triggered by: a prompt starting a main-loop turn (subagents raise none).
   * Reacts by:    finding the checkpoint when none is known yet, so the
   *               turn's edits are counted. That covers a /clear, which
   *               raises no session.start, if the host starts `$.state`
   *               over then (the API leaves that unspecified). The count
   *               itself is never reset by a /clear: the gap is between the
   *               note and the disk, not between conversations.
   * Dispatches:   refreshTarget().
   */
  on('turn.start', async ($, e, next) => {
    if ((await read($, targetAtom)) === null) {
      await refreshTarget($)
    }
    return next(e)
  })

  /**
   * LISTENER: tool.call (every tool; only the edit tools matter)
   *
   * Triggered by: any tool call, in any loop. One hook with no matcher,
   *               checked against EDIT_TOOLS, so a tool this build lacks
   *               (MultiEdit, say) cannot fail the mod's validation.
   * Reacts by:    letting the call run, then counting it if it succeeded.
   * Skips:        a held write (`staged: true`: the write waits for the
   *               machine owner's review and the file is unchanged).
   * Dispatches:   countEdit().
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
    // wrote, even if a hook beneath rewrote the input; the input's own field
    // (spread beside `tool` on `e`, named per tool) is the fallback.
    const record = (ran.result ?? {}) as { filePath?: unknown; staged?: unknown }
    const path = record.filePath ?? (e as unknown as Record<string, unknown>)[field]
    if (record.staged !== true && typeof path === 'string') {
      await countEdit($, path)
    }
    return ran
  })

  /**
   * RENDER: the band above the prompt (component 'AbovePrompt')
   *
   * Triggered by: the surface drawing the band, and again whenever an atom
   *               this hook read is written.
   * Reacts by:    drawing one line above the chain beneath while there are
   *               edits the note has not caught up with: dim while the gap is
   *               small, amber once it is behind.
   * Dispatches:   nothing. It only draws.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const target = await read($, targetAtom)
    const editsSince = await read($, editsSinceAtom)
    if (target === null || editsSince === 0) {
      return next(e)
    }

    const now = await $.clock.now()
    const text =
      target.mtimeMs === null
        ? `No checkpoint yet for ${target.project} · ${editsSince} edits so far`
        : `Checkpoint (${target.project}) updated ${formatAge(now - target.mtimeMs)} · ${editsSince} edits since`

    const beneath = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {isBehind(target, editsSince, now) ? <Text color="warning">{text}</Text> : <Text dimColor>{text}</Text>}
        {beneath}
      </Box>
    )
  })
}
