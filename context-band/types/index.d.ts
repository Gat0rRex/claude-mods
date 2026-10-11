// context-band's type contract.
//
// Role: declares the values this mod keeps in `$.state`, the session-scoped
// store the host owns. Values there survive a hot reload of the module (its
// own `let` variables do not), which is why the readings and the last
// warnings live here rather than in module variables.
//
// `claude plugin validate` holds every `$.state` key the module names to this
// file, so a typo in an atom's key is caught before the mod ever loads.

/**
 * Which side of the two cost lines the context sits on.
 * - calm: under 250k tokens
 * - warn: 250k to 350k, time to plan a /compact
 * - over: 350k and up, every model call now re-reads all of it
 */
export type ContextTier = 'calm' | 'warn' | 'over'

/**
 * One snapshot of the context window, taken after a model response.
 * `tokens` is what the last response was answered over (uncached, cache-write
 * and cache-read together); `window` is the model's maximum.
 */
export type ContextReading = { tokens: number; window: number }

/**
 * One plan usage window as the last response reported it: `kind` is the
 * engine's name (`five_hour`, `seven_day`, a gateway's `spend_limit`),
 * `percentUsed` 0-100 (past 100 on an exceeded spend limit).
 */
export type LimitReading = { kind: string; percentUsed: number }

/**
 * What the session has spent: `usd` is the engine's own running total (the
 * figure /cost shows), absent where the host keeps no ledger; `limits` are the
 * plan's usage windows, empty off a subscription or before the first reading.
 */
export type SpendReading = { usd?: number; limits: LimitReading[] }

declare module 'claude-code' {
  interface PluginState {
    'context-band': {
      /** The latest context snapshot, or null before the first response / after a compact or /clear. */
      reading: ContextReading | null
      /** The context tier we last told the person about, so each line toasts once. */
      warnedTier: ContextTier
      /** The latest cost and usage-limit figures, or null before the first measurement / after a /clear. */
      spend: SpendReading | null
      /**
       * Per usage window (by `kind`), the highest limit line already toasted
       * (0, 80 or 95), so each line toasts once per climb.
       */
      warnedLimits: Record<string, number>
    }
  }
}
