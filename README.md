# claude-mods

Five small mods for [Claude Code](https://docs.claude.com/en/docs/claude-code), written as plugins of function hooks. Each one turns a working habit into something you can see: a line in the band above the prompt, a toast, a short note to the model, or a pane. None of them blocks anything. They watch, and they fail open.

| Mod | What you see | The habit it backs |
|---|---|---|
| [context-band](context-band) | Two lines above the prompt: context size (amber from 150k tokens, red from 200k), then session cost and the 5h/7d usage windows | Compact before the context gets expensive |
| [loose-ends](loose-ends) | "Still running: …": background shells, terminal tabs Claude opened, preview servers | Stop temporary services when their goal is met |
| [checkpoint-watch](checkpoint-watch) | How old the project vault's `Checkpoint.md` is and how many edits it is behind | Keep a resumable checkpoint current |
| [review-gate](review-gate) | Files edited since a reviewer agent last finished; database files wait for a database reviewer. The list is saved per project, so it survives restarts. `/review-gate`, `/review-gate clear` | Review each part before the next starts |
| [agent-spend](agent-spend) | `/agent-spend`: a pane with each subagent's model, tokens and estimated cost against the session total | Know which agents cost what |

The hooks API these use is early access (built against Claude Code 2.1.293), so expect to adjust them as it changes.

## Install

In a terminal session of Claude Code:

```
/plugin install context-band --marketplace Gat0rRex/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. Repeat with `loose-ends`, `checkpoint-watch`, `review-gate` or `agent-spend` for the others. To try one without installing it:

```
claude --plugin-dir path/to/claude-mods/context-band
```

## Configuration

Some mods read defaults you may want to change. They are constants at the top of each `hooks/register.tsx`.

- **context-band**: `WARN_AT` (150k) and `OVER_AT` (200k) tokens; toasts at 80% and 95% of a usage window (`LIMIT_LINES`).
- **checkpoint-watch** finds a project's notes vault in two ways:
  - the vault folder has the same name as the project folder, under `~/Documents/Obsidian Docs`;
  - an optional alias table at `~/.claude/scripts/claude_checkpoint_projects.json` maps project folders to vaults:
    ```json
    {
      "vault_root": "C:/Users/me/Documents/Obsidian Docs",
      "projects": {
        "my-app": { "vault": "MyApp" },
        "elsewhere": { "vault_path": "D:/notes/Elsewhere", "name": "Elsewhere" }
      }
    }
    ```
  It watches `<vault>/01 Overview/Checkpoint.md` and goes amber at 10 edits once the note is over an hour old.
- **review-gate**: `GENERAL_REVIEWERS` and `DB_REVIEWER` name the agent types whose finished answer counts as a review. Set them to your own agents. Database paths follow the globs in `DB_FOLDERS` and `isDbPath()`. Notes (`.md`, `.txt`), Obsidian vaults and the temp folder are not counted.
- **agent-spend**: `PRICES` holds API list prices per million tokens (as of 2026-09-25; Haiku 5.5 added 2026-10-10). Cache writes are priced as 1-hour writes. Haiku 5.5 is always priced at its rate for prompts up to 100K tokens, since a subagent's usage arrives summed over its requests, so a Haiku agent with a longer context is undercounted. A model missing from the table shows `?`.

## How they are built

Every module has a header block on its role and event flow, and each listener and job says what triggers it and what it dispatches. Shared conventions:

- **Band mods stack.** The band above the prompt is one slot. Each mod draws its lines above `await next(e)`, so it never hides another mod's.
- **Observers fail open.** Hooks on `tool.call`, `agent.spawn` and `prompt.submit` have no `.catch` on purpose. A hook that throws is skipped, and the work goes ahead.
- **Events, not polling.** Figures come from `session.measure`, `turn.complete` and tool results. State lives in `$.state` atoms, and a write redraws the readers.

## Tests

Each mod has tests for `claude plugin test`. Close stdin when running them from a script:

```
claude plugin validate context-band < /dev/null
claude plugin test context-band < /dev/null
```

## License

MIT
