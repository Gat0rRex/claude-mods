// review-gate's type contract.
//
// Role: declares the one value this mod keeps in `$.state`, the
// session-scoped store the host owns, so it survives a hot reload of the
// module. `claude plugin validate` holds every `$.state` key the module names
// to this file.

/**
 * A file edited and not yet covered by a finished review.
 * - `path`: the file, slashes normalised to `/`.
 * - `seq`: the gate's edit counter at this file's latest edit. A reviewer
 *   covers the file only if it was spawned after that edit (its
 *   `reviewsUpTo` is at least this number).
 * - `isDb`: the path matches the database globs in isDbPath (copied from an
 *   optional rules file, `~/.claude/rules/database-review.md`), so only the
 *   database reviewer (db-adversarial-reviewer by default) can clear it.
 */
export type PendingEdit = { path: string; seq: number; isDb: boolean }

/**
 * A reviewer agent that has started and not yet finished.
 * - `type`: its agent type (`senior-fable`, `db-adversarial-reviewer`, ...).
 * - `reviewsUpTo`: the edit counter when it was spawned. Edits made after
 *   that can't be in what it read, so they stay pending.
 */
export type RunningReviewer = { type: string; reviewsUpTo: number }

/**
 * Everything the gate knows, kept in one value so that bumping the counter
 * and recording the edit happen in one write.
 */
export type Gate = {
  /** Edits counted so far this session; each edit takes the next number. */
  seq: number
  /** Unreviewed files, keyed by normalised path. */
  pending: Record<string, PendingEdit>
  /** Reviewers in flight, keyed by agent id. Never saved: they die with the process. */
  reviewers: Record<string, RunningReviewer>
  /**
   * The project root whose saved list this is (slashes normalised), or null
   * until the saved list has been loaded into this session.
   */
  root: string | null
}

/** What is saved in `$.store` per project: the counter and the pending files. */
export type SavedGate = Pick<Gate, 'seq' | 'pending'>

declare module 'claude-code' {
  interface PluginState {
    'review-gate': {
      gate: Gate
    }
  }
}
