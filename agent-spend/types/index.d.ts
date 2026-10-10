// agent-spend's type contract.
//
// Role: declares the values this mod keeps in `$.state`, the session-scoped
// store the host owns, so they survive a hot reload of the module.
// `claude plugin validate` holds every `$.state` key the module names to this
// file.

/** Token counts summed over an agent's turns, as the API reported them. */
export type AgentTokens = {
  /** Uncached input. */
  input: number
  output: number
  /** Input read from the prompt cache (cheap). */
  cacheRead: number
  /** Input written to the prompt cache (dearer than plain input). */
  cacheWrite: number
}

/** Where an agent's run stands, from the reason its last turn ended. */
export type AgentStatus = 'running' | 'done' | 'stopped' | 'failed'

/**
 * One subagent this session started.
 * - `order`: start order, for the pane's row order.
 * - `type`, `description`: what the Agent tool call named.
 * - `model`: the model of its last turn, or what the spawn resolved before
 *   any turn ended.
 * - `usd`: estimated cost of the turns that had a known price.
 * - `hasUnpriced`: some turn ran on a model missing from the price table, so
 *   `usd` is short by an unknown amount.
 */
export type AgentRow = {
  id: string
  order: number
  type: string
  description: string
  model: string
  status: AgentStatus
  tokens: AgentTokens
  usd: number
  hasUnpriced: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-spend': {
      /** Every subagent seen this conversation, keyed by agent id. */
      agents: Record<string, AgentRow>
      /** Claude Code's own running cost for the session ("every priced API response", so subagents too), or null before the first figure. */
      sessionUsd: number | null
    }
  }
}
