import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'dragons-door', component: 'Pane', requestId: 'dragons-door',
  props: { title: "Dragon's Door", isFocused: false, bodyColumns: 36, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const TOOL = 'mcp__plugin_dragons-door_dragons-door__status'
const CHAT = { ...PANE, requestId: 'dragons-door-chat', props: { ...PANE.props, title: 'Player chat' } } as const
const LABEL = "Dragon's Door, a text RPG (game state for the narrator)"

const state = {
  name: 'Ossian Vale', class: 'bard', path: 'the gift', level: 5, exp: 7052, exp_next: 10000, hp: 56, max_hp: 92,
  gold: 6000, bank: 8056, gems: 2, forest_fights: 10, player_fights: 3, specials: 0, mana: 17, mana_max: 45,
  weapon: "Shepherd's Fiddle", armor: 'Iron Armor', jewelry: 'Copper Band (+3 Strength)', alive: true, in_encounter: false, bag_used: 4, bag_capacity: 20,
  unread_mail: 2, unread_news: 0, gifts_waiting: 1, time_of_day: 'afternoon',
  place: { name: "the Wren's Wood", terrain: 'forest', level: 1 }, cave_depth: null,
  quests: [{ title: "Grimwald's Other Boot", days_left: 6 }],
}

/** Which pane the stand-in engine says it's showing, and every title the mod has opened a pane with. */
const showing = { id: 'dragons-door' }
const opens: { id: string; title: string }[] = []

/** Stands for the engine: answers every tool call with the given text, and counts the pane opening. */
function engine(on: Parameters<TestBody>[1], reply: () => string, opened: { n: number }) {
  showing.id = 'dragons-door'
  on('ui.panes', () => ({ value: ['dragons-door', 'dragons-door-chat'].map(id => ({ id, title: id, isShown: id === showing.id, isFocused: false, isPlaced: true })) }))
  mock.store(on)
  on('command.register', () => ({ value: { command: 'door-pane' } }))
  opens.length = 0
  on('ui.open', (_, e) => { if (e.id === 'dragons-door') opened.n++; opens.push({ id: e.id, title: e.title ?? '' }); return { value: { isPlaced: true } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: reply() }))
  return mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
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
    expect((await ui.find({ type: 'Text', text: /^Copper Band/ }))?.text).toBe('Copper Band (+3 Strength)')
    expect((await ui.find({ type: 'Text', text: /forest, level 1/ }))?.text).toBe('forest, level 1 · afternoon')
    // The map: text in a terminal that shows no pictures, an SVG where the surface draws SVG.
    if (surface === 'terminal') expect((await ui.find({ type: 'Text', text: /\? @/ }))?.text).toBe('      ? @')
    else expect(await ui.find({ type: 'Svg' })).toBeDefined()
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

test('a run of game calls draws one quiet line; anything else is the engine\'s', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const call = (tool: string) => ({ tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })
  const group = (calls: ReturnType<typeof call>[]) => ({ plugin: 'dragons-door', component: 'ToolGroup', requestId: 'g', props: { calls, isActive: false, isExpanded: false, isCallsOnly: true } }) as const
  for (const surface of ['terminal', 'desktop'] as const) {
    let ui = await $.ui.mount({ ...group([call(TOOL), call('mcp__plugin_dragons-door_dragons-door__map')]), surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('· the realm answers')
    await ui.unmount()
    // The pane's own notes beside the results make the engine say the group isn't calls-only; it's still ours to draw.
    ui = await $.ui.mount({ ...group([call(TOOL)]), props: { ...group([call(TOOL)]).props, isCallsOnly: false }, surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('· the realm answers')
    await ui.unmount()
    ui = await $.ui.mount({ ...group([call(TOOL), call('Bash')]), surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('the map comes with a move, and a map the player asks for replaces it', async ($, on) => {
  const opened = { n: 0 }
  let reply = JSON.stringify({ game: LABEL, events: [{ kind: 'arrived' }, { kind: 'surroundings', map: ['  ?', '? @ ?'] }], state, actions: [] })
  engine(on, () => reply, opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /\? @ \?/ }))?.text).toBe('? @ ?')
  await ui.unmount()
  reply = JSON.stringify({ game: LABEL, events: [{ kind: 'map', map: ['T @'] }], state, actions: [] })
  await $.tool.call({ tool: TOOL })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /T @/ }))?.text).toBe('T @')
  await ui.unmount()
})

/** Stands for the player's machine and the realm's chat: their key on disk, and the chat endpoints. */
function realm(on: Parameters<TestBody>[1], sent: { body: unknown }[]) {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/eric' : undefined }))
  on('fs.read', (_, e) => {
    expect(e.path).toBe('/home/eric/.config/dragons-door/config.json')
    return { value: JSON.stringify({ api_key: 'door_test_key_1234', name: 'Ossian Vale' }) }
  })
  on('http.fetch', (_, e) => {
    expect(e.url.startsWith('https://api.dragonsdoor.gg/v1/chat')).toBe(true)
    expect(e.init?.headers?.authorization).toBe('Bearer door_test_key_1234')
    if (e.init?.method === 'POST') { sent.push({ body: JSON.parse(e.init.body ?? '{}') }); return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true,"id":9}' } } }
    const lines = sent.map((s, i) => ({ id: i + 1, from: 'Ossian Vale', body: (s.body as { body: string }).body, mine: true, ...((s.body as { to?: string }).to ? { whisper: true, to: (s.body as { to: string }).to } : {}) }))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ room: 'brightwater', room_name: 'Brightwater', here: ['Hilde'], online: ['Hilde', 'Rowan'], messages: [{ id: 0, from: 'Hilde', body: 'Keep it in the bank.', mine: false, at: '2000-01-01T00:00:00Z' }, ...lines], last_id: lines.length }) } }
  })
}

test('chat: say a line and whisper one, straight to the realm, and see them in the pane', async ($, on) => {
  const opened = { n: 0 }, sent: { body: unknown }[] = []
  engine(on, () => JSON.stringify({ game: LABEL, events: [], state, actions: [] }), opened)
  realm(on, sent)
  showing.id = 'dragons-door-chat'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  const ui = await $.ui.mount({ ...CHAT, surface: 'terminal' })
  await ui.input({ key: 'say', text: 'Anyone seen the boot?' })
  await ui.input({ key: 'say', text: '@Old Tam: the locket?' })
  expect(sent.map(s => s.body)).toEqual([{ body: 'Anyone seen the boot?' }, { to: 'Old Tam', body: 'the locket?' }])
  expect((await ui.find({ type: 'Text', text: /Keep it in the bank/ }))?.text).toMatch(/^Hilde: Keep it in the bank\. · \d+d ago$/)
  expect((await ui.find({ type: 'Text', text: /locket/ }))?.text).toBe('→ Old Tam: the locket?')
  expect((await ui.find({ type: 'Text', text: /^here:/ }))?.text).toBe('here: Hilde')
  await ui.unmount()
})

test("who's in the realm comes with the chat poll, no rankings needed", async ($, on) => {
  const opened = { n: 0 }, sent: { body: unknown }[] = []
  engine(on, () => JSON.stringify({ game: LABEL, events: [], state, actions: [] }), opened)
  realm(on, sent)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  const chatUi = await $.ui.mount({ ...CHAT, surface: 'terminal' })
  await chatUi.input({ key: 'say', text: 'evening' })
  await chatUi.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Rowan/ }))?.text).toBe('● Hilde  ● Rowan')
  await ui.unmount()
})

test('chat on mobile reads but has no field to type in', async ($, on) => {
  const opened = { n: 0 }
  engine(on, () => JSON.stringify({ game: LABEL, events: [], state, actions: [] }), opened)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  const ui = await $.ui.mount({ ...CHAT, surface: 'mobile' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.filter(t => /Reading|Quiet/.test(t ?? ''))).toEqual(['Quiet. Say something.', 'Reading only on this device.'])
  await ui.unmount()
})

test('two panes, Status and Player chat, open together; the status pane has no chat in it', async ($, on) => {
  const titles: string[] = []
  on('command.register', () => ({ value: { command: 'door-pane' } }))
  on('ui.open', (_, e) => { titles.push(e.title ?? e.id); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: [] }))
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ game: LABEL, events: [], state, actions: [] }) }))
  mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  expect(titles).toEqual(['⚔ Status', '✉ Player chat'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Quiet|whisper/ })).toBeUndefined()
  await ui.unmount()
})

test('new lines while the chat tab is behind Status show on its title; bringing it to the front clears them; the hint goes once both are seen', async ($, on) => {
  const opened = { n: 0 }
  const clock = engine(on, () => JSON.stringify({ game: LABEL, events: [], state, actions: [] }), opened)
  let next: { id: number; from: string; body: string; mine: boolean }[] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/eric' : undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ api_key: 'door_test_key_1234' }) }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ room: 'brightwater', room_name: 'Brightwater', here: [], messages: next, last_id: next.at(-1)?.id ?? 0 }) } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL }) // opens both tabs, Status in front
  await clock.advance(5000)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Tabs:/ }))?.text).toContain('ctrl+x tab')
  await ui.unmount()
  next = [{ id: 50, from: 'Pip', body: 'Race you to the gate', mine: false }]
  await clock.advance(5000)
  expect(opens.filter(o => o.id === 'dragons-door-chat').at(-1)?.title).toBe('✉ Player chat · 1 new')
  showing.id = 'dragons-door-chat'
  next = []
  await clock.advance(5000)
  expect(opens.filter(o => o.id === 'dragons-door-chat').at(-1)?.title).toBe('✉ Player chat')
  ui = await $.ui.mount({ ...CHAT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Tabs:/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Race you/ }))?.text).toBe('Pip: Race you to the gate')
  await ui.unmount()
})

test('chat keeps arriving when the mod thinks the tab is closed but it is on screen', async ($, on) => {
  // ui.open says "not placed" (what the mod would remember after a reset), while ui.panes shows the chat tab in front.
  on('command.register', () => ({ value: { command: 'door-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  on('ui.panes', () => ({ value: [{ id: 'dragons-door-chat', title: 'chat', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: JSON.stringify({ game: LABEL, events: [], state, actions: [] }) }))
  mock.store(on)
  const clock = mock.clock(on, { now: Date.parse('2026-10-24T12:00:00Z') })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/eric' : undefined }))
  on('fs.read', () => ({ value: JSON.stringify({ api_key: 'door_test_key_1234' }) }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ room: 'brightwater', room_name: 'Brightwater', here: [], messages: [{ id: 3, from: 'Eric', body: 'Yawn', mine: true }], last_id: 3 }) } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  await clock.advance(5000)
  const ui = await $.ui.mount({ ...CHAT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Yawn/ }))?.text).toBe('Eric: Yawn')
  await ui.unmount()
})

test('on the map, you and the towns and caves are drawn bold', async ($, on) => {
  const opened = { n: 0 }
  engine(on, () => JSON.stringify({ game: LABEL, events: [{ kind: 'surroundings', map: ['% T %', '. @ O'] }], state, actions: [] }), opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /^\. @ O$/ })
  expect(row?.text).toBe('. @ O')
  const marks = (await ui.findAll({ type: 'Text' })).filter(t => t.props?.bold && /^[@TO]$/.test(t.text ?? '')).map(t => t.text)
  expect(marks).toEqual(['T', '@', 'O'])
  await ui.unmount()
})

test('a known place under the map is one click away: it asks the narrator to travel there, as if typed; not mid-fight', async ($, on) => {
  const opened = { n: 0 }, prompts: { text: string; asUser?: boolean }[] = []
  let fighting = false
  engine(on, () => JSON.stringify({ game: LABEL, events: [{ kind: 'surroundings', map: ['T @'], places: [{ name: 'Ironhold', x: -4, y: -11, kind: 'town' }, { name: 'the Old Seam', x: 3, y: -2, kind: 'cave' }] }], state: { ...state, in_encounter: fighting }, actions: [] }), opened)
  on('prompt.submit', (_, e) => { prompts.push({ text: e.text, asUser: (e.origin as { asUser?: boolean }).asUser }); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'go--4--11' })
  expect(prompts).toEqual([{ text: 'Travel to Ironhold (-4, -11)', asUser: true }])
  await ui.unmount()
  fighting = true
  await $.tool.call({ tool: TOOL })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await expect(ui.press({ key: 'go--4--11' })).rejects.toBeDefined()
  await ui.unmount()
})

test('in a terminal that shows pictures, the pane map is a picture, and a map call draws the known world under it', async ($, on) => {
  const opened = { n: 0 }
  const chart = { origin: [-1, -1], you: [0, 0], rows: ['.%', 'T.'], names: [[0, 0, 'Brightwater']], heard: [] }
  const reply = JSON.stringify({ game: LABEL, events: [{ kind: 'map', map: ['    ? T ?', '      ? @'], chart }], state, actions: ['forest'] })
  engine(on, () => reply, opened)
  on('env.get', async (_$, e) => ({ value: e.name === 'TERM_PROGRAM' ? 'ghostty' : undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const MAP = 'mcp__plugin_dragons-door_dragons-door__map'
  const ran = await $.tool.call({ tool: MAP, tool_use_id: 'call-1' })
  expect(ran.context?.some(c => /drawn as a picture/.test(c))).toBe(true)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Image' })).toBeDefined()
  await pane.unmount()
  const group = await $.ui.mount({ plugin: 'dragons-door', component: 'ToolGroup', surface: 'terminal', requestId: 'g1',
    props: { calls: [{ tool: MAP, tool_use_id: 'call-1', input: {}, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: false, isCallsOnly: true } })
  expect(await group.find({ type: 'Image' })).toBeDefined()
  expect((await group.find({ type: 'Text', text: /Brightwater \(0, 0\)/ }))?.text).toContain('Brightwater (0, 0)')
  await group.unmount()
})

test('the title screen is a picture above the first status in a terminal that shows pictures, and the narrator is told to skip it', async ($, on) => {
  const opened = { n: 0 }
  const reply = JSON.stringify({ game: LABEL, events: [], state, actions: [], client: { version: '0.33.0' } })
  engine(on, () => reply, opened)
  on('env.get', async (_$, e) => ({ value: e.name === 'TERM_PROGRAM' ? 'ghostty' : undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const first = await $.tool.call({ tool: TOOL, tool_use_id: 's1' })
  expect(first.context?.some(c => /title screen is drawn as a picture/.test(c))).toBe(true)
  const again = await $.tool.call({ tool: TOOL, tool_use_id: 's2' })
  expect(again.context?.some(c => /title screen/.test(c)) ?? false).toBe(false)
  const ui = await $.ui.mount({ plugin: 'dragons-door', component: 'ToolGroup', surface: 'terminal', requestId: 'g2',
    props: { calls: [{ tool: TOOL, tool_use_id: 's1', input: {}, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded: false, isCallsOnly: false } })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^v0\.33\.0$/ }))?.text).toBe('v0.33.0')
  await ui.unmount()
})

test('no title picture in a terminal that shows none: the narrator prints the text one', async ($, on) => {
  const opened = { n: 0 }
  engine(on, () => JSON.stringify({ game: LABEL, events: [], state, actions: [], client: { version: '0.33.0' } }), opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: TOOL, tool_use_id: 's1' })
  expect(r.context?.some(c => /title screen/.test(c)) ?? false).toBe(false)
})
