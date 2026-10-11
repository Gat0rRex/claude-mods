// context-handoff's type contract.
//
// Role: declares the values this mod keeps in `$.state`, the session-scoped
// store the host owns. Values there survive a hot reload of the module (its
// own `let` variables do not), so a reload doesn't repeat a note the model
// already has. They do not survive a restart of the session's process; see
// the header of hooks/register.tsx for what that costs.
//
// `claude plugin validate` holds every `$.state` key the module names to this
// file, so a typo in an atom's key is caught before the mod ever loads.

/**
 * The highest line the model has been told about in this conversation.
 * - none:     no note yet (or re-armed by a /compact, a compaction under the
 *             hand-off line, or a /clear)
 * - heads-up: the heads-up line (250k, scaled down for a small window)
 * - hand-off: the hand-off line (300k, scaled down for a small window)
 */
export type NoteLevel = 'none' | 'heads-up' | 'hand-off'

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': {
      /** The highest line already noted (after a tool call or on a prompt), so each line is noted once. */
      noted: NoteLevel
      /**
       * True once the engine or a plugin compacted the main conversation
       * past the hand-off line: the hand-off stays due even though the
       * context is small again. Only a /compact the person typed or a /clear
       * sets it back to false.
       */
      carried: boolean
      /**
       * True from that compaction until the hand-off note is repeated once:
       * by the next main-loop tool call that has a figure, or by the next
       * prompt (whose own note covers it).
       */
      reissue: boolean
    }
  }
}
