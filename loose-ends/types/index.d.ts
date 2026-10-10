// loose-ends' type contract.
//
// Role: declares the values this mod keeps in `$.state`, the session-scoped
// store the host owns, so they survive a hot reload of the module.
// `claude plugin validate` holds every `$.state` key the module names to this
// file.

/**
 * One thing Claude started that may still be running.
 * - `id`: what stops it (a background task id, a terminal tab id, a preview
 *   server id), so a stop can be matched back to it.
 * - `label`: what the band shows (the command, the tab's title, the server).
 */
export type LooseEnd = { id: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'loose-ends': {
      /** Background shells (Bash / PowerShell) not yet seen to finish, keyed by task id. */
      shells: Record<string, LooseEnd>
      /** Terminal-panel tabs Claude opened that are still open, from the last listing. */
      tabs: LooseEnd[]
      /** Preview (dev) servers still running, from the last listing. */
      previews: LooseEnd[]
    }
  }
}
