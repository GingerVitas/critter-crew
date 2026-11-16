import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'critter-crew',
  component: 'Pane',
  requestId: 'critter-crew',
  props: {
    title: 'Critter Crew',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a subagent hatches as a critter and counts its tools', async ($, on) => {
  on('command.register', () => ({ value: { command: 'crew' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 10_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Find the auth bug', type: 'Explore', status: 'running' as const }],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5[1m]', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'Find it',
    description: 'Find the auth bug',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'user' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts', agentId: 'a1' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Find the auth bug/ }))?.text).toBe('Find the auth bug')
    expect(await ui.find({ type: 'Text', text: /2 tools/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /fiddling with Read/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /♛ Opus 5\.5 · 1M/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Grep 1 · Read 1|Read 1 · Grep 1/ })).toBeTruthy()

    // Unfolding the tool log lists each call with what it touched.
    await ui.press({ key: 'tools-a1' })
    expect(await ui.find({ type: 'Text', text: /✓ Read auth\/login\.ts/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /✓ Grep x/ })).toBeTruthy()
    await ui.press({ key: 'tools-a1' })
    expect(await ui.find({ type: 'Text', text: /✓ Read auth\/login\.ts/ })).toBeFalsy()

    // Only the terminal has a main view to open a transcript in.
    expect(Boolean(await ui.find({ type: 'Button', key: 'peek-a1' }))).toBe(surface === 'terminal')
    await ui.unmount()
  }
})

test('an empty meadow shows the egg', async ($, on) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No critters yet/ }))?.text).toBe('No critters yet')
  await ui.unmount()
})
