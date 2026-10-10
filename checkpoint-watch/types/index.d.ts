// checkpoint-watch's type contract.
//
// Role: declares the values this mod keeps in `$.state`, the session-scoped
// store the host owns, so they survive a hot reload of the module.
// `claude plugin validate` holds every `$.state` key the module names to this
// file.

/**
 * The project's checkpoint note as last looked at.
 * - `project`: the vault's folder name (what the band names).
 * - `path`: the note's absolute path, `<vault>/01 Overview/Checkpoint.md`.
 * - `mtimeMs`: when it was last written, or null when it does not exist yet.
 */
export type CheckpointTarget = { project: string; path: string; mtimeMs: number | null }

declare module 'claude-code' {
  interface PluginState {
    'checkpoint-watch': {
      /** The session's project checkpoint, or null when the session is in no project with a vault. */
      target: CheckpointTarget | null
      /** File edits (Edit, Write, NotebookEdit) since the checkpoint was last written. */
      editsSince: number
      /** True once the "falling behind" toast has shown; re-armed when the checkpoint is written. */
      hasWarned: boolean
    }
  }
}
