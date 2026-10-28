/**
 * Dragon's Door's side pane. Every game tool result already carries the whole state (the server's, never the
 * narrator's), so this reads it off each result and draws it: you, where you are, what's waiting, what you
 * can do, who's about. It opens on the first Dragon's Door result of a session and never in sessions that
 * aren't playing. It only reads: nothing here changes the game.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Character, Chart, Chat, ChatLine, Game } from '../types'
import { cellsFor, gridFromChart, gridFromSpaced, raster, svg, terminalShowsPictures } from './mapart'
import { LOGO_COLUMNS, LOGO_ROWS, logoRaster, logoSvg } from './logo'

const PANE = 'dragons-door'
const TITLE = '⚔ Status'
const CHAT_PANE = 'dragons-door-chat'
const CHAT_TITLE = '✉ Player chat'
const chatTitle = (unread: number) => unread > 0 ? `${CHAT_TITLE} · ${unread} new` : CHAT_TITLE
// Change the tag when Game's fields change: it declines what an earlier version stored.
const game = atom({ plugin: 'dragons-door', key: 'game' } as const,
  { isPlaying: false, isShown: false, character: null, actions: [], map: [], places: [], online: [], at: 0, charts: [], logo: null } as Game, { shape: 'game-7' })

const chat = atom({ plugin: 'dragons-door', key: 'chat' } as const,
  { room: '', roomName: '', here: [], lines: [], lastId: 0, who: '', note: '', draft: '', isOpen: false, unread: 0, seen: { status: false, chat: false } } as Chat, { shape: 'chat-4' })
/** Whether this terminal shows pictures (worked out at the start of each session; DRAGONS_DOOR_PICTURES=0 or 1 overrides). */
let pictures = false
/** What the pane has seen of the conversation's game rows, for /door-pane debug: whether its row hook runs, and why not. */
const diag = { groups: 0, ours: 0, drawn: 0, lastTools: [] as string[], lastFlags: '', lastError: '' }
/** Which surface started the session (terminal, desktop, ...): the title picture is drawn where it can be. */
let startedOn = 'terminal'
const LOGO_NOTE = "The Dragon's Door title screen is drawn as a picture right above this reply, with the version under it. Don't print the title screen; start with anything that comes after it (an update notice, what's new, the game)."
/** The map tool, as the engine names it. */
const MAP_TOOL = /^mcp__plugin_dragons-door_.*__map$/
const MAP_NOTE = "The player's whole known map is drawn as a picture in the conversation, right under this call. Don't draw a map, make an image or list the tiles: say in a sentence or two what stands out (where they are, what's near, where they haven't been), then the menu."

/** How often the pane asks the realm for new chat while it's showing. */
const CHAT_EVERY_MS = 5000

/** The player's own game key and the realm's address, from the file the plugin keeps (the active character). */
async function credentials($: EngineInterface): Promise<{ key: string; url: string } | null> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const dir = (await $.env.get('DRAGONS_DOOR_CONFIG_DIR')) ?? (home ? `${home}/.config/dragons-door` : null)
  if (!dir) return null
  try {
    const cfg = JSON.parse(await $.fs.read(`${dir}/config.json`) as string) as { api_key?: string; api_url?: string }
    if (!cfg.api_key) return null
    const url = (await $.env.get('DRAGONS_DOOR_API_URL')) ?? (cfg.api_url && !/lord-ebon/.test(cfg.api_url) ? cfg.api_url : 'https://api.dragonsdoor.gg')
    return { key: cfg.api_key, url: url.replace(/\/$/, '') }
  } catch { return null }
}

const CHAT_NOTE: Record<string, string> = {
  too_new: 'You can chat from level 2.', slow_down: 'Easy: a line every couple of seconds.', no_such_player: 'Nobody here by that name.',
  whisper_self: "That's you.", bad_message: 'Say something shorter.', banned: 'The realm has barred you.', unauthorized: 'Enter the realm first.',
}

/** How long ago a line was said, once it's old enough to matter ("2h ago", "yesterday"), else "". */
function ago(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN
  if (Number.isNaN(t)) return ''
  const min = Math.floor((now - t) / 60000)
  if (min < 10) return ''
  if (min < 60) return `${min}m ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h ago`
  const d = Math.floor(hours / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

/** The realm's error word from a failed reply, if it said one. */
const errorOf = (text: string) => { try { return (JSON.parse(text || '{}') as { error?: string }).error ?? '' } catch { return '' } }

/** Ask the realm what's been said since the last line we have. */
async function pollChat($: EngineInterface) {
  const g = await read($, game)
  if (!g.isPlaying) return
  const cred = await credentials($)
  if (!cred) return
  const before = await read($, chat)
  const fresh = before.who !== cred.key.slice(-8)
  const res = await $.http.fetch(`${cred.url}/v1/chat?since=${fresh ? 0 : before.lastId}`, { headers: { authorization: `Bearer ${cred.key}` } })
  if (!res.ok) { await update($, chat, c => ({ ...c, note: CHAT_NOTE[errorOf(res.text)] ?? c.note })); return }
  const r = JSON.parse(res.text) as { room: string; room_name: string; here: string[]; online?: string[]; messages: ChatLine[]; last_id: number }
  // Who's in the realm rides along with chat, so the Status tab's list stays fresh without asking for the rankings.
  if (Array.isArray(r.online)) { const online = r.online.slice(0, 12); await update($, game, x => ({ ...x, online })) }
  // Lines from others that arrive while the chat tab is behind Status count as new, on its tab's title.
  const shown = await isShowing($, CHAT_PANE)
  const incoming = r.messages.filter(m => !m.mine && !before.lines.some(x => x.id === m.id)).length
  await update($, chat, c => {
    const moved = fresh || c.room !== r.room
    const lines = [...(moved ? [] : c.lines), ...r.messages.filter(m => moved || !c.lines.some(x => x.id === m.id))].slice(-40)
    return { ...c, room: r.room, roomName: r.room_name, here: r.here, lines, lastId: Math.max(r.last_id, moved ? 0 : c.lastId), who: cred.key.slice(-8),
      unread: shown || fresh ? 0 : c.unread + incoming }
  })
  const after = await read($, chat)
  if (after.unread !== before.unread) await $.ui.open({ id: CHAT_PANE, title: chatTitle(after.unread) })
}

/** Every few seconds: note which tab is in front (looked at; chat in front clears its count), then fetch chat. */
async function tick($: EngineInterface) {
  const g = await read($, game)
  if (!g.isPlaying) return
  let panes: readonly { id: string; isShown: boolean }[] = []
  try { panes = await $.ui.panes() } catch { /* fetch anyway */ }
  const front = panes.find(p => p.isShown)?.id
  if (front === PANE) await saw($, 'status')
  if (front === CHAT_PANE) {
    await saw($, 'chat')
    if ((await read($, chat)).unread > 0) { await update($, chat, x => ({ ...x, unread: 0 })); await $.ui.open({ id: CHAT_PANE, title: chatTitle(0) }) }
  }
  // Fetch while the chat tab is open, as Claude Code says it is now (a remembered flag can go stale across an update).
  if (panes.length === 0 || panes.some(p => p.id === CHAT_PANE)) await pollChat($)
}

/** Send a line: "@Name words" whispers to Name; anything else goes to the room. */
async function say($: EngineInterface, text: string) {
  const t = text.trim()
  if (!t) return
  const cred = await credentials($)
  if (!cred) { await update($, chat, c => ({ ...c, note: CHAT_NOTE.unauthorized! })); return }
  // "@Name words" for a one-word name, "@Two Words: words" for a longer one.
  const m = /^@([^:@]+?):\s*([\s\S]+)$/.exec(t) ?? /^@(\S+)\s+([\s\S]+)$/.exec(t)
  const body = m ? { to: m[1]!.trim(), body: m[2]! } : { body: t }
  const res = await $.http.fetch(`${cred.url}/v1/chat`, { method: 'POST', headers: { authorization: `Bearer ${cred.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) { await update($, chat, c => ({ ...c, note: CHAT_NOTE[errorOf(res.text)] ?? "That didn't go through." })); return }
  await update($, chat, c => ({ ...c, draft: '', note: '' }))
  await pollChat($)
}

/** Whether the surface is showing this pane now (not a tab behind another). */
const isShowing = async ($: EngineInterface, id: string) => {
  try { return (await $.ui.panes()).find(p => p.id === id)?.isShown ?? false } catch { return false }
}

/** Mark a tab as looked at; once both have been, ever, the hint at the top goes for good. */
async function saw($: EngineInterface, tab: 'status' | 'chat') {
  const c = await read($, chat)
  if (c.seen[tab]) return
  const kept = ((await $.store.get('tabs-seen').catch(() => null)) ?? {}) as { status?: boolean; chat?: boolean }
  const seen = { status: Boolean(kept.status || c.seen.status || tab === 'status'), chat: Boolean(kept.chat || c.seen.chat || tab === 'chat') }
  await $.store.set('tabs-seen', seen).catch(() => undefined)
  await update($, chat, x => ({ ...x, seen }))
}

/** A Dragon's Door result, or null: every one starts with the game's label (the plugin's text() adds it). */
function parse(text: string | undefined): Record<string, unknown> | null {
  if (!text || !text.includes("Dragon's Door")) return null
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    return typeof v.game === 'string' && v.game.startsWith("Dragon's Door") ? v : null
  } catch { return null }
}

type Ev = { kind?: string; map?: unknown; players?: unknown }

const bar = (have: number, max: number, width: number) => {
  const full = max > 0 ? Math.max(0, Math.min(width, Math.round((have / max) * width))) : 0
  return '█'.repeat(full) + '░'.repeat(width - full)
}
const n = (v: number) => v.toLocaleString('en-US')

const RESULT_NOTE = "The Dragon's Door side pane is showing the player's numbers right now. Don't print the status line in this reply; give the menu only."

/** The game's tools, as the engine names them: mcp__plugin_dragons-door_<server>__<tool>. */
const OURS = /^mcp__plugin_dragons-door_/

/** Open both panes (the surface draws them as tabs), and remember whether a surface is drawing each. */
async function show($: EngineInterface) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  await update($, game, g => ({ ...g, isShown: Boolean(r?.isPlaced) }))
  const c = await $.ui.open({ id: CHAT_PANE, title: CHAT_TITLE })
  await update($, chat, x => ({ ...x, isOpen: Boolean(c?.isPlaced) }))
  if (c?.isPlaced) void pollChat($).catch(() => undefined)
}

/** A hook failure in a few words, for /door-pane debug. */
function describeError(err: unknown): string {
  try { return (typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : JSON.stringify(err)).slice(0, 240) } catch { return 'unreadable' }
}

type Els = Pick<Elements['terminal'], 'Box' | 'Text'> & { Image?: Elements['terminal']['Image']; Svg?: Elements['desktop']['Svg'] }
/** The pane's map around you as a picture (pixels in a terminal that shows them, SVG in the desktop app), or null for the text map. */
function smallMap(els: Els, surface: string, lines: string[], maxColumns: number): RenderChildren | null {
  const grid = gridFromSpaced(lines)
  if (!grid.length) return null
  const Box = els.Box
  if (surface === 'terminal' && pictures && els.Image) {
    const Image = els.Image!
    const { columns, rows } = cellsFor(grid, Math.min(maxColumns, 26))
    return <Box marginTop={1}><Image key="pane-map" source={raster(grid, 12)} columns={columns} rows={rows} alt={lines.join(' / ')} /></Box>
  }
  if (surface !== 'terminal' && els.Svg) {
    const Svg = els.Svg!
    return <Box marginTop={1}><Svg source={svg(grid, 16)} alt="The map around you" width={grid[0]!.length * 16} /></Box>
  }
  return null
}

/** The title screen: the logo on a clear background, the version under its right end. Null where no picture can be drawn. */
function drawLogo(els: Els, surface: string, version: string): RenderChildren | null {
  const Box = els.Box
  const Text = els.Text
  const ver = <Box width={LOGO_COLUMNS} justifyContent="flex-end"><Text dimColor>v{version}</Text></Box>
  if (surface === 'terminal' && pictures && els.Image) {
    const Image = els.Image!
    return <Box flexDirection="column" marginBottom={1}><Image key="title" source={logoRaster(4)} columns={LOGO_COLUMNS} rows={LOGO_ROWS} alt="Dragon's Door" />{ver}</Box>
  }
  if (surface !== 'terminal' && els.Svg) {
    const Svg = els.Svg!
    return <Box flexDirection="column" marginBottom={1}><Svg source={logoSvg(8)} alt="Dragon's Door" width={LOGO_COLUMNS * 8} />{ver}</Box>
  }
  return null
}

/** The whole known world, drawn under the map call: a picture with names listed under it, an SVG with names on it, or the symbols. */
function drawChart(els: Els, surface: string, chart: Chart, width: number): RenderChildren {
  const Box = els.Box
  const Text = els.Text
  const grid = gridFromChart(chart)
  const [ox, oy] = chart.origin
  const inside = (x: number, y: number) => y - oy >= 0 && y - oy < grid.length && x - ox >= 0 && x - ox < (grid[0]?.length ?? 0)
  const names = chart.names.map(([x, y, name]) => ({ x: x - ox, y: y - oy, name }))
  const heard = chart.heard.filter(([x, y]) => inside(x, y)).map(([x, y, name]) => ({ x: x - ox, y: y - oy, name, heard: true }))
  const legend = <Text dimColor>{[...chart.names.map(([x, y, name]) => `${name} (${x}, ${y})`), ...chart.heard.map(([x, y, name]) => `${name} (${x}, ${y}), heard of`)].join(' · ')}</Text>
  if (surface === 'terminal' && pictures && els.Image) {
    const Image = els.Image!
    const { columns, rows } = cellsFor(grid, Math.min(width, 96))
    const cell = Math.max(4, Math.min(16, Math.floor(1400 / Math.max(grid.length, grid[0]?.length ?? 1))))
    return <Box flexDirection="column" marginTop={1}><Image key={`chart-${ox}-${oy}`} source={raster(grid, cell)} columns={columns} rows={rows} alt="Your map of the realm" />{legend}</Box>
  }
  if (surface !== 'terminal' && els.Svg) {
    const Svg = els.Svg!
    const cell = Math.max(10, Math.min(28, Math.floor(720 / Math.max(grid.length, grid[0]?.length ?? 1))))
    return <Box marginTop={1}><Svg source={svg(grid, cell, [...names, ...heard])} alt="Your map of the realm" /></Box>
  }
  return <Box flexDirection="column" marginTop={1}>{grid.map(r => <Text mono>{r.join(' ').trimEnd()}</Text>)}{legend}</Box>
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'door-pane', description: "Show the Dragon's Door pane" })
    // Each name written out: the engine lists what a mod reads from the environment.
    const quiet = (p: Promise<string | undefined>) => p.then(v => v ?? undefined, () => undefined)
    startedOn = typeof (e as { surface?: unknown }).surface === 'string' ? (e as { surface: string }).surface : 'terminal'
    pictures = terminalShowsPictures({ term: await quiet($.env.get('TERM')), program: await quiet($.env.get('TERM_PROGRAM')),
      tmux: await quiet($.env.get('TMUX')), force: await quiet($.env.get('DRAGONS_DOOR_PICTURES')) })
    // Tabs the player has already looked at, in any session: the hint stays gone.
    const kept = ((await $.store.get('tabs-seen').catch(() => null)) ?? {}) as { status?: boolean; chat?: boolean }
    await update($, chat, c => ({ ...c, seen: { status: Boolean(kept.status), chat: Boolean(kept.chat) } }))
    // The chat feed: only does anything while the player is in the realm and the pane is showing.
    $.clock.every(CHAT_EVERY_MS, () => { void tick($).catch(() => undefined) })
    return next(e)
  })

  on('command.run', { command: 'door-pane' }, async ($, e) => {
    if (/\bdebug\b/.test(e.args ?? '')) {
      const drawn = (await $.store.get('rows-drawn').catch(() => null)) === true
      return { text: [
        `pictures in this terminal: ${pictures} (started on ${startedOn})`,
        `game rows: ${diag.groups} groups seen, ${diag.ours} ours, ${diag.drawn} drawn; ever drawn: ${drawn}`,
        `last group: ${diag.lastTools.join(', ') || 'none'} (${diag.lastFlags || 'no flags'})`,
        `last error: ${diag.lastError || 'none'}`,
      ].join('\n') }
    }
    const g = await read($, game)
    if (!g.isPlaying) return { text: "The pane opens once you've entered the realm (/dragons-door:enter)." }
    await show($)
    return { text: "Dragon's Door pane opened." }
  })

  // Only this game's own tools: every other tool call goes past this hook untouched and unseen.
  on('tool.call', { tool: OURS }, async ($, e, next) => {
    const ran = await next(e)
    const r = parse(ran.text)
    if (!r) return ran
    const events = (Array.isArray(r.events) ? r.events : []) as Ev[]
    // The realm sends the map with every move and status (surroundings), and when they look at it (map).
    const map = (events.find(x => x.kind === 'map') ?? events.find(x => x.kind === 'surroundings'))?.map
    const places = (events.find(x => x.kind === 'surroundings') as { places?: Game['places'] } | undefined)?.places
    const ranks = events.find(x => x.kind === 'rankings')?.players
    const chart = (events.find(x => x.kind === 'map') as { chart?: Chart } | undefined)?.chart
    const hasChart = Boolean(chart && Array.isArray(chart.rows) && chart.rows.length > 0)
    const before = await read($, game)
    const first = !before.isPlaying
    // The session's first status with the client's version (what the enter skill calls first): the title screen goes here as a picture.
    const version = (r.client as { version?: unknown } | undefined)?.version
    const logo = !before.logo && /__status$/.test(e.tool) && typeof version === 'string' && (pictures || startedOn !== 'terminal')
    await update($, game, g => ({
      ...g,
      isPlaying: true,
      character: (r.state as Character | undefined) ?? g.character,
      actions: Array.isArray(r.actions) ? (r.actions as string[]) : g.actions,
      map: Array.isArray(map) ? (map as string[]).slice(0, 15) : g.map,
      places: Array.isArray(places) ? places.slice(0, 8) : g.places,
      online: Array.isArray(ranks) ? (ranks as { name: string; online?: boolean }[]).filter(p => p.online).map(p => p.name).slice(0, 12) : g.online,
      at: Date.now(),
      logo: logo ? { id: e.tool_use_id, version: version as string } : g.logo,
      charts: hasChart ? [...(g.charts ?? []).filter(x => x.id !== e.tool_use_id), { id: e.tool_use_id, chart: chart! }].slice(-4) : (g.charts ?? []),
    }))
    if (first) await show($)
    // Right beside the result, where the narrator reads it, not just in the system prompt: the pane has the numbers.
    // Only once this Claude Code has been seen drawing the game's rows is the narrator told a picture stands in for its own.
    const rowsDrawn = (await $.store.get('rows-drawn').catch(() => null)) === true
    const notes = [...(logo && rowsDrawn ? [LOGO_NOTE] : []), ...((await read($, game)).isShown ? [RESULT_NOTE] : []), ...(hasChart && rowsDrawn ? [MAP_NOTE] : [])]
    if (ran.deny === undefined && notes.length) return { ...ran, context: [...(ran.context ?? []), ...notes] }
    return ran
  }).catch(($, e, next) => next(e)) // the pane only watches: if drawing fails, the game call goes on as it was

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, game, g => ({ ...g, isShown: false }))
    if (e.id === CHAT_PANE) await update($, chat, c => ({ ...c, isOpen: false }))
    return next(e)
  })

  // A run of nothing but game calls draws one quiet line in place of "Called plugin:dragons-door…" (ctrl+o still shows them all).
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const p = e.props
    diag.groups++; diag.lastTools = p.calls.map(c => c.tool).slice(0, 4); diag.lastFlags = `expanded=${p.isExpanded} callsOnly=${p.isCallsOnly} surface=${e.surface}`
    // Our own notes for the narrator ride beside the results, so the engine doesn't call such a group calls-only: judge by the calls.
    if (p.isExpanded || p.calls.length === 0 || !p.calls.every(c => OURS.test(c.tool)) || p.calls.some(c => c.isErrored || c.isInterrupted)) return next(e)
    diag.ours++
    if (!p.calls.some(c => c.isRunning)) { diag.drawn++; void $.store.set('rows-drawn', true).catch(() => undefined) }
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const line = <Text dimColor>{p.calls.some(c => c.isRunning) ? '· the realm stirs…' : '· the realm answers'}</Text>
    // A map call's answer is drawn here as the whole known world: a picture where the screen can, the symbols where it can't.
    const g = await read($, game)
    const call = [...p.calls].reverse().find(c => MAP_TOOL.test(c.tool) && !c.isRunning && c.tool_use_id && (g.charts ?? []).some(x => x.id === c.tool_use_id))
    const chart = call ? g.charts.find(x => x.id === call.tool_use_id)!.chart : null
    const title = g.logo && p.calls.some(c => c.tool_use_id === g.logo!.id && !c.isRunning) ? drawLogo(els as unknown as Els, e.surface, g.logo.version) : null
    if (!chart && !title) return line
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 4)
    return <Box flexDirection="column">{title}{line}{chart ? drawChart(els as unknown as Els, e.surface, chart, width) : null}</Box>
  }).catch(($, e, next) => { diag.lastError = describeError(next.error); return next(e) })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const g = await read($, game)
    const hintStatus = !(await read($, chat)).seen.chat
    const c = g.character
    const cols = e.props?.bodyColumns ?? e.viewport?.columns ?? 36
    const w = Math.max(8, Math.min(14, cols - 20))
    if (!c) return <Box paddingX={1}><Text dimColor>Enter the realm to see your character here.</Text></Box>
    const label = (t: string) => <Text dimColor bold>{t.toUpperCase()}</Text>
    const section = (t: string, ...rows: RenderChildren[]) => <Box flexDirection="column" marginTop={1}>{label(t)}{rows}</Box>
    const meter = (name: string, have: number, max: number, color: string) => (
      <Box flexDirection="row" gap={1}>
        <Text>{name.padEnd(4)}</Text>
        <Text mono color={color}>{bar(have, max, w)}</Text>
        <Text>{have}/{max}</Text>
      </Box>
    )
    const mana = c.mana_max !== undefined
    const waiting: string[] = []
    if (c.unread_mail) waiting.push(`${c.unread_mail} letter${c.unread_mail > 1 ? 's' : ''}`)
    if (c.gifts_waiting) waiting.push(`${c.gifts_waiting} gift${c.gifts_waiting > 1 ? 's' : ''} from the courier`)
    if (c.unread_news) waiting.push(`news (${c.unread_news})`)
    const where = c.place ? `${c.place.name}${c.cave_depth ? `, ${c.cave_depth} down` : ''}` : 'Brightwater'
    const ground = c.place ? `${c.place.terrain}, level ${c.place.level}` : 'in town'
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {hintStatus && <Text dimColor>Tabs: ⚔ Status | ✉ Player chat · click one, or ctrl+x tab</Text>}
        <Text bold color="claude">{c.name}</Text>
        <Text dimColor>{c.class}, level {c.level}{c.path ? ` · ${c.path}` : ''}</Text>
        {!c.alive && <Text color="error" bold>Dead until the new day</Text>}
        {c.in_encounter && <Text color="warning" bold>In a fight</Text>}
        <Box flexDirection="column" marginTop={1}>
          {meter('HP', c.hp, c.max_hp, c.hp * 4 < c.max_hp ? 'error' : 'success')}
          {mana ? meter('Mana', c.mana ?? 0, c.mana_max ?? 0, 'suggestion') : <Text>{'Spec'.padEnd(4)} {c.specials} left</Text>}
          {c.exp_next !== null && <Text dimColor>{'Exp'.padEnd(4)} {n(c.exp)} / {n(c.exp_next)}</Text>}
        </Box>
        {section('Purse', <Text>Gold {n(c.gold)} · bank {n(c.bank)}{c.gems ? ` · gems ${c.gems}` : ''}</Text>)}
        {section('Today', <Text>Turns {c.forest_fights} · PvP {c.player_fights} · bag {c.bag_used}/{c.bag_capacity}</Text>)}
        {section('Gear', <Text>{c.weapon}</Text>, <Text>{c.armor}</Text>, c.jewelry ? <Text>{c.jewelry}</Text> : null)}
        {section('Where', <Text>{where}</Text>, <Text dimColor>{ground}{c.time_of_day ? ` · ${c.time_of_day}` : ''}</Text>,
          ...(g.map.length > 0 ? [smallMap($.ui.resolve(e) as unknown as Els, e.surface, g.map, cols - 2) ?? <Box flexDirection="column" marginTop={1}>{g.map.map(line => (
            // You (@) stand out in bold and the accent colour; towns (T) and caves (O) in bold.
            <Text mono>{line.split(/([@TO])/).filter(Boolean).map(part =>
              part === '@' ? <Text mono bold color="claude">@</Text> : part === 'T' || part === 'O' ? <Text mono bold>{part}</Text> : part)}</Text>
          ))}</Box>] : []),
          // One click to go back somewhere they've been: sent as if they'd typed it, so the narrator tells the journey.
          ...(g.places.length > 0 && c.alive && !c.in_encounter ? [<Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
            {g.places.map(pl => <Button key={`go-${pl.x}-${pl.y}`} label={`${pl.kind === 'cave' ? 'O' : 'T'} ${pl.name}`}
              onPress={() => { void $.prompt.submit({ text: `Travel to ${pl.name} (${pl.x}, ${pl.y})`, asUser: true }).catch(() => undefined) }} />)}
          </Box>] : []))}
        {waiting.length > 0 && section('Waiting', ...waiting.map(t => <Text>{t}</Text>))}
        {(c.quests?.length ?? 0) > 0 && section('Quests', ...c.quests!.map(q => <Text>{q.title}{q.days_left !== undefined ? <Text dimColor> · {q.days_left} days</Text> : null}</Text>))}
        {g.online.length > 0 && section('In the realm now', <Text>{g.online.map(x => `● ${x}`).join('  ')}</Text>)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CHAT_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    // Mobile draws no text field yet, whatever its table lists: there the chat is read-only.
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
    const g = await read($, game)
    const ch = await read($, chat)
    const hintChat = !ch.seen.status
    const now = await $.clock.now()
    const room = Math.max(4, (e.props?.scroll?.bodyRows ?? 24) - 6)
    if (!g.isPlaying) return <Box paddingX={1}><Text dimColor>Enter the realm to chat with whoever's there.</Text></Box>
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {hintChat && <Text dimColor>Tabs: ⚔ Status | ✉ Player chat · click one, or ctrl+x tab</Text>}
        <Text bold color="claude">{ch.roomName || 'Player chat'}</Text>
        <Text dimColor>{ch.here.length ? `here: ${ch.here.slice(0, 12).join(', ')}${ch.here.length > 12 ? ` +${ch.here.length - 12}` : ''}` : 'Nobody else here right now.'}</Text>
        <Box flexDirection="column" marginTop={1}>
          {ch.lines.length === 0 ? <Text dimColor>Quiet. Say something.</Text> : ch.lines.slice(-room).map(l => {
            const when = ago(l.at, now)
            return l.whisper
              ? <Text italic color="remember">{l.mine ? `→ ${l.to}` : `${l.from} whispers`}: {l.body}{when ? <Text dimColor> · {when}</Text> : null}</Text>
              : <Text><Text bold color={l.mine ? 'suggestion' : undefined}>{l.from}</Text>: {l.body}{when ? <Text dimColor> · {when}</Text> : null}</Text>
          })}
        </Box>
        {ch.note ? <Text color="warning">{ch.note}</Text> : null}
        <Box marginTop={1}>
          {Input
            ? <Input key="say" value={ch.draft} placeholder="Say something · @Name to whisper" submitLabel="send"
                onInput={v => { void update($, chat, c => ({ ...c, draft: v })) }}
                onSubmit={v => { void say($, v) }} />
            : <Text dimColor>Reading only on this device.</Text>}
        </Box>
      </Box>
    )
  })
}
