import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'dragons-door', component: 'Pane', requestId: 'dragons-door',
  props: { title: "Dragon's Door", isFocused: false, bodyColumns: 36, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const TOOL = 'mcp__plugin_dragons-door_dragons-door__status'
const LABEL = "Dragon's Door, a text RPG (game state for the narrator)"

const state = {
  name: 'Ossian Vale', class: 'bard', path: 'the gift', level: 5, exp: 7052, exp_next: 10000, hp: 56, max_hp: 92,
  gold: 6000, bank: 8056, gems: 2, forest_fights: 10, player_fights: 3, specials: 0, mana: 17, mana_max: 45,
  weapon: "Shepherd's Fiddle", armor: 'Iron Armor', alive: true, in_encounter: false, bag_used: 4, bag_capacity: 20,
  unread_mail: 2, unread_news: 0, gifts_waiting: 1, time_of_day: 'afternoon',
  place: { name: "the Wren's Wood", terrain: 'forest', level: 1 }, cave_depth: null,
  quests: [{ title: "Grimwald's Other Boot", days_left: 6 }],
}

/** Stands for the engine: answers every tool call with the given text, and counts the pane opening. */
function engine(on: Parameters<TestBody>[1], reply: () => string, opened: { n: number }) {
  on('command.register', () => ({ value: { command: 'door-pane' } }))
  on('ui.open', () => { opened.n++; return { value: { isPlaced: true } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: reply() }))
}

test("a session that isn't playing never sees the pane", async ($, on) => {
  const opened = { n: 0 }
  engine(on, () => 'total 0', opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(opened.n).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Enter the realm to see your character here.')
  await ui.unmount()
})

test('a game result opens the pane and draws the character, on every surface', async ($, on) => {
  const opened = { n: 0 }
  let reply = JSON.stringify({ game: LABEL, events: [], state, actions: ['forest', 'move', 'map', 'return', 'status', 'mail'] })
  engine(on, () => reply, opened)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  expect(opened.n).toBe(1)

  // A map and the rankings fill in the rest; the pane opens only once.
  reply = JSON.stringify({ game: LABEL, events: [{ kind: 'map', map: ['    ? T ?', '      ? @'] }], state, actions: ['forest'] })
  await $.tool.call({ tool: TOOL })
  reply = JSON.stringify({ game: LABEL, events: [{ kind: 'rankings', players: [{ name: 'Hilde', online: true }, { name: 'Pip', online: false }] }], state, actions: ['forest'] })
  await $.tool.call({ tool: TOOL })
  expect(opened.n).toBe(1)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Ossian Vale$/ }))?.text).toBe('Ossian Vale')
    expect((await ui.find({ type: 'Text', text: /^56\/92$/ }))?.text).toBe('56/92')
    expect((await ui.find({ type: 'Text', text: /^17\/45$/ }))?.text).toBe('17/45')
    expect((await ui.find({ type: 'Text', text: /Wren's Wood/ }))?.text).toBe("the Wren's Wood")
    expect((await ui.find({ type: 'Text', text: /forest, level 1/ }))?.text).toBe('forest, level 1 · afternoon')
    expect((await ui.find({ type: 'Text', text: /\? @/ }))?.text).toBe('      ? @')
    expect((await ui.find({ type: 'Text', text: /courier/ }))?.text).toBe('1 gift from the courier')
    expect((await ui.find({ type: 'Text', text: /Boot/ }))?.text).toContain("Grimwald's Other Boot")
    expect(await ui.find({ type: 'Text', text: /Hunt/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /Hilde/ }))?.text).toBe('● Hilde')
    await ui.unmount()
  }
})

test("another plugin's JSON that isn't the game's is left alone", async ($, on) => {
  const opened = { n: 0 }
  engine(on, () => JSON.stringify({ state: { name: 'x' } }), opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__other__thing' })
  expect(opened.n).toBe(0)
})

test('while the pane is up the narrator is told to leave the status line out, and not before', async ($, on) => {
  const opened = { n: 0 }
  engine(on, () => JSON.stringify({ game: LABEL, events: [], state, actions: [] }), opened)
  on('prompt.compose', () => ({ sections: [{ id: 'base', scope: 'session', text: 'base' }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [], sections: [] } as const
  const before = await $.prompt.compose(COMPOSE)
  expect(before.sections.some(s => s.id === 'dragons-door:pane')).toBe(false)
  await $.tool.call({ tool: TOOL })
  const during = await $.prompt.compose(COMPOSE)
  expect(during.sections.some(s => s.id === 'dragons-door:pane')).toBe(true)
})

test('each game result tells the narrator the pane has the numbers, once the pane is up', async ($, on) => {
  const opened = { n: 0 }
  let reply = JSON.stringify({ game: LABEL, events: [], state, actions: [] })
  engine(on, () => reply, opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: TOOL })
  reply = 'total 0'
  expect('context' in r && r.context?.some(t => t.includes('side pane'))).toBe(true)
  const other = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('context' in other && other.context?.some(t => t.includes('side pane'))).toBeFalsy()
})

test('after a move the pane fetches the map itself, once per place', async ($, on) => {
  const opened = { n: 0 }, maps = { n: 0 }
  let where = { ...state.place, x: 1, y: 1 }
  engine(on, () => JSON.stringify({ game: LABEL, events: [], state: { ...state, place: where }, actions: [] }), opened)
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:dragons-door:dragons-door' } }))
  on('mcp.call', (_, e) => {
    maps.n++
    expect(e.tool).toBe('map')
    expect(e.server).toBe('plugin_dragons-door_dragons-door')
    return { value: { content: [{ type: 'text', text: JSON.stringify({ game: LABEL, events: [{ kind: 'map', map: [`row ${maps.n}`, '  @'] }] }) }], isError: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  await $.tool.call({ tool: TOOL }) // same place: no second fetch
  expect(maps.n).toBe(1)
  where = { ...where, x: 2 }
  await $.tool.call({ tool: TOOL })
  expect(maps.n).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^row/ }))?.text).toBe('row 2')
  await ui.unmount()
})

test('a run of game calls draws one quiet line; anything else is the engine\'s', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const call = (tool: string) => ({ tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })
  const group = (calls: ReturnType<typeof call>[]) => ({ plugin: 'dragons-door', component: 'ToolGroup', requestId: 'g', props: { calls, isActive: false, isExpanded: false, isCallsOnly: true } }) as const
  for (const surface of ['terminal', 'desktop'] as const) {
    let ui = await $.ui.mount({ ...group([call(TOOL), call('mcp__plugin_dragons-door_dragons-door__map')]), surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('· the realm answers')
    await ui.unmount()
    ui = await $.ui.mount({ ...group([call(TOOL), call('Bash')]), surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
})
