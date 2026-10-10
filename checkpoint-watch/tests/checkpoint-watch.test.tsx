// checkpoint-watch's tests, run with `claude plugin test <mod folder>`.
//
// The test's `on` sits beneath the mod and stands in for Claude Code and the
// disk: the home folder, the alias table, the vault folders, the note's
// modification time, the clock, and the Write tool. The tests raise the
// session's events through `$`.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { resolveVault } from '../hooks/register'

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const HOUR = 60 * 60 * 1000
const VAULTS = 'C:/Users/me/Documents/Obsidian Docs'
const NOTE = `${VAULTS}/MyApp/01 Overview/Checkpoint.md`

/**
 * Stands in for the engine and the disk. `disk.root` is the session's project
 * root, `disk.noteMtime` the note's modification time (undefined: missing),
 * `clock.now` the time. `toasts` records every toast.
 */
function stubEngine(on: On) {
  const disk: { root: string; noteMtime: number | undefined } = {
    root: 'C:/Users/me/Desktop/my-app',
    noteMtime: 0,
  }
  const clock = { now: 0 }
  const toasts: string[] = []

  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.read', () => ({
    value: JSON.stringify({ vault_root: VAULTS, projects: { 'my-app': { vault: 'MyApp' } } }),
  }))
  on('fs.list', () => ({
    value: ['MyApp', 'Notes'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.stat', ($, e) => {
    // The engine may hand the path on in its own spelling (backslashes on
    // Windows), so compare normalised.
    if (disk.noteMtime === undefined || e.path.replace(/\\/g, '/') !== NOTE) {
      return { deny: 'ENOENT' }
    }
    return { value: { kind: 'file', size: 10, mtimeMs: disk.noteMtime, isLink: false } }
  })
  on('session.root', () => ({ value: disk.root }))
  on('clock.now', () => ({ value: clock.now }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // Writing the note moves its mtime to the clock, as the disk would. A
  // write whose content is 'staged' is held for review: the file is unchanged.
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const staged = e.content === 'staged'
    if (!staged && e.file_path.replace(/\\/g, '/') === NOTE) {
      disk.noteMtime = clock.now
    }
    return {
      result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: '', staged },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })

  return { disk, clock, toasts }
}

async function start($: Engine) {
  await $.session.start({ cwd: 'C:/Users/me/Desktop/my-app', surface: 'terminal', isInteractive: true })
}

async function edits($: Engine, count: number, path = 'C:/Users/me/Desktop/my-app/app.py') {
  for (let i = 0; i < count; i += 1) {
    await $.tool.call({ tool: 'Write', file_path: path, content: 'x' })
  }
}

async function endTurn($: Engine) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}

async function drawBand($: Engine) {
  const ui = await $.ui.mount({ plugin: 'checkpoint-watch', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const line = await ui.find({ type: 'Text', text: /checkpoint/i })
  const beneath = await ui.find({ type: 'Box', key: 'engine-band' })
  await ui.unmount()
  return { line, beneath }
}

test('resolves vaults the way the companion settings hook does', () => {
  const aliases = { 'my-app': { vault: 'MyApp' }, elsewhere: { vault_path: 'E:/ext/Vault', name: 'Ext' } }
  const dirs = ['MyApp', 'Notes']
  expect(resolveVault('C:/Users/me/Desktop/my-app', VAULTS, aliases, dirs)?.project).toBe('MyApp')
  expect(resolveVault('C:\\Users\\me\\Desktop\\my-app\\.claude\\worktrees\\wf_1', VAULTS, aliases, dirs)?.project).toBe('MyApp')
  expect(resolveVault('D:/code/notes', VAULTS, aliases, dirs)?.vault).toBe(`${VAULTS}/Notes`)
  expect(resolveVault('E:/elsewhere/src', VAULTS, aliases, dirs)?.project).toBe('Ext')
  expect(resolveVault('C:/Users/me/Documents', VAULTS, aliases, dirs)).toBeNull()
})

test('draws nothing until there are edits since the note', async ($, on) => {
  stubEngine(on)
  await start($)

  const { line, beneath } = await drawBand($)
  expect(line).toBeUndefined()
  expect(beneath).toBeDefined()
})

test('counts edits dim, then amber with one toast once behind', async ($, on) => {
  const engine = stubEngine(on)
  await start($)

  engine.clock.now = 3 * HOUR
  await edits($, 3)
  const early = (await drawBand($)).line
  expect(early?.text).toBe('Checkpoint (MyApp) updated 3h ago · 3 edits since')
  expect(early?.props).toMatchObject({ dimColor: true })
  expect(engine.toasts).toHaveLength(0)

  await edits($, 7)
  const behind = (await drawBand($)).line
  expect(behind?.props).toMatchObject({ color: 'warning' })
  expect(engine.toasts).toEqual(['MyApp checkpoint is 3h old, 10 edits behind. Update it at the next milestone.'])

  await edits($, 5)
  expect(engine.toasts).toHaveLength(1)
})

test('many edits to a fresh note are not "behind"', async ($, on) => {
  const engine = stubEngine(on)
  await start($)
  engine.clock.now = 10 * 60 * 1000

  await edits($, 20)
  expect((await drawBand($)).line?.props).toMatchObject({ dimColor: true })
  expect(engine.toasts).toHaveLength(0)
})

test('writing the note through a tool resets the count and re-arms the toast', async ($, on) => {
  const engine = stubEngine(on)
  await start($)
  engine.clock.now = 2 * HOUR
  await edits($, 12)
  expect(engine.toasts).toHaveLength(1)

  await edits($, 1, NOTE.replace(/\//g, '\\'))
  expect((await drawBand($)).line).toBeUndefined()

  engine.clock.now = 4 * HOUR
  await edits($, 10)
  expect(engine.toasts).toHaveLength(2)
})

test('editing the note by hand is seen at the end of the turn', async ($, on) => {
  const engine = stubEngine(on)
  await start($)
  engine.clock.now = HOUR
  await edits($, 4)

  engine.disk.noteMtime = HOUR + 1
  await endTurn($)
  expect((await drawBand($)).line).toBeUndefined()
})

test('a project with no note yet says so', async ($, on) => {
  const engine = stubEngine(on)
  engine.disk.noteMtime = undefined
  await start($)

  await edits($, 2)
  expect((await drawBand($)).line?.text).toBe('No checkpoint yet for MyApp · 2 edits so far')
})

test('a session in no project draws nothing', async ($, on) => {
  const engine = stubEngine(on)
  engine.disk.root = 'C:/Users/me/Documents'
  await start($)

  await edits($, 12)
  expect((await drawBand($)).line).toBeUndefined()
  expect(engine.toasts).toHaveLength(0)
})

test('a held (staged) write counts for nothing, the note included', async ($, on) => {
  const engine = stubEngine(on)
  await start($)
  engine.clock.now = 2 * HOUR
  await edits($, 3)

  await $.tool.call({ tool: 'Write', file_path: 'C:/Users/me/Desktop/my-app/b.py', content: 'staged' })
  await $.tool.call({ tool: 'Write', file_path: NOTE, content: 'staged' })
  expect((await drawBand($)).line?.text).toBe('Checkpoint (MyApp) updated 2h ago · 3 edits since')
})

test('the note written through a tool is not reset again at the turn end', async ($, on) => {
  const engine = stubEngine(on)
  await start($)
  engine.clock.now = 2 * HOUR
  await edits($, 1, NOTE)
  await edits($, 2)
  await endTurn($)

  expect((await drawBand($)).line?.text).toBe('Checkpoint (MyApp) updated just now · 2 edits since')
})
