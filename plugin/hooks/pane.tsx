/**
 * Dragon's Door's side pane. Every game tool result already carries the whole state (the server's, never the
 * narrator's), so this reads it off each result and draws it: you, where you are, what's waiting, what you
 * can do, who's about. It opens on the first Dragon's Door result of a session and never in sessions that
 * aren't playing. It only reads: nothing here changes the game.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Character, Chat, ChatLine, Game } from '../types'

const PANE = 'dragons-door'
const TITLE = 'Status'
const CHAT_PANE = 'dragons-door-chat'
const CHAT_TITLE = 'Player chat'
// Change the tag when Game's fields change: it declines what an earlier version stored.
const game = atom({ plugin: 'dragons-door', key: 'game' } as const,
  { isPlaying: false, isShown: false, character: null, actions: [], map: [], online: [], at: 0 } as Game, { shape: 'game-4' })

const chat = atom({ plugin: 'dragons-door', key: 'chat' } as const,
  { room: '', roomName: '', here: [], lines: [], lastId: 0, who: '', note: '', draft: '', isOpen: false } as Chat, { shape: 'chat-3' })
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
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

/** The realm's error word from a failed reply, if it said one. */
const errorOf = (text: string) => { try { return (JSON.parse(text || '{}') as { error?: string }).error ?? '' } catch { return '' } }

/** Ask the realm what's been said since the last line we have. */
async function pollChat($: EngineInterface) {
  const g = await read($, game)
  if (!g.isPlaying || !(await read($, chat)).isOpen) return
  const cred = await credentials($)
  if (!cred) return
  const before = await read($, chat)
  const fresh = before.who !== cred.key.slice(-8)
  const res = await $.http.fetch(`${cred.url}/v1/chat?since=${fresh ? 0 : before.lastId}`, { headers: { authorization: `Bearer ${cred.key}` } })
  if (!res.ok) { await update($, chat, c => ({ ...c, note: CHAT_NOTE[errorOf(res.text)] ?? c.note })); return }
  const r = JSON.parse(res.text) as { room: string; room_name: string; here: string[]; messages: ChatLine[]; last_id: number }
  await update($, chat, c => {
    const moved = fresh || c.room !== r.room
    const lines = [...(moved ? [] : c.lines), ...r.messages.filter(m => moved || !c.lines.some(x => x.id === m.id))].slice(-40)
    return { ...c, room: r.room, roomName: r.room_name, here: r.here, lines, lastId: Math.max(r.last_id, moved ? 0 : c.lastId), who: cred.key.slice(-8) }
  })
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'door-pane', description: "Show the Dragon's Door pane" })
    // The chat feed: only does anything while the player is in the realm and the pane is showing.
    $.clock.every(CHAT_EVERY_MS, () => { void pollChat($).catch(() => undefined) })
    return next(e)
  })

  on('command.run', { command: 'door-pane' }, async $ => {
    const g = await read($, game)
    if (!g.isPlaying) return { text: "The pane opens once you've entered the realm (/dragons-door:enter)." }
    await show($)
    return { text: "Dragon's Door pane opened." }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const r = parse(ran.text)
    if (!r) return ran
    const events = (Array.isArray(r.events) ? r.events : []) as Ev[]
    // The realm sends the map with every move and status (surroundings), and when they look at it (map).
    const map = (events.find(x => x.kind === 'map') ?? events.find(x => x.kind === 'surroundings'))?.map
    const ranks = events.find(x => x.kind === 'rankings')?.players
    const first = !(await read($, game)).isPlaying
    await update($, game, g => ({
      ...g,
      isPlaying: true,
      character: (r.state as Character | undefined) ?? g.character,
      actions: Array.isArray(r.actions) ? (r.actions as string[]) : g.actions,
      map: Array.isArray(map) ? (map as string[]).slice(0, 15) : g.map,
      online: Array.isArray(ranks) ? (ranks as { name: string; online?: boolean }[]).filter(p => p.online).map(p => p.name).slice(0, 12) : g.online,
      at: Date.now(),
    }))
    if (first) await show($)
    // Right beside the result, where the narrator reads it, not just in the system prompt: the pane has the numbers.
    if (ran.deny === undefined && (await read($, game)).isShown) return { ...ran, context: [...(ran.context ?? []), RESULT_NOTE] }
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
    if (p.isExpanded || p.isCallsOnly !== true || p.calls.length === 0 || !p.calls.every(c => OURS.test(c.tool))) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{p.calls.some(c => c.isRunning) ? '· the realm stirs…' : '· the realm answers'}</Text>
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const g = await read($, game)
    // Drawing means a surface shows it: from here on the narrator leaves the status line out.
    if (g.isPlaying && !g.isShown) await update($, game, x => ({ ...x, isShown: true }))
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
      <Box flexDirection="column" paddingX={1}>
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
        {section('Gear', <Text>{c.weapon}</Text>, <Text>{c.armor}</Text>)}
        {section('Where', <Text>{where}</Text>, <Text dimColor>{ground}{c.time_of_day ? ` · ${c.time_of_day}` : ''}</Text>,
          ...(g.map.length > 0 ? [<Box flexDirection="column" marginTop={1}>{g.map.map(line => <Text mono>{line}</Text>)}</Box>] : []))}
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
    if (g.isPlaying && !ch.isOpen) await update($, chat, x => ({ ...x, isOpen: true }))
    const now = await $.clock.now()
    const room = Math.max(4, (e.props?.scroll?.bodyRows ?? 24) - 6)
    if (!g.isPlaying) return <Box paddingX={1}><Text dimColor>Enter the realm to chat with whoever's there.</Text></Box>
    return (
      <Box flexDirection="column" paddingX={1}>
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
