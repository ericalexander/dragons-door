/**
 * Dragon's Door's side pane. Every game tool result already carries the whole state (the server's, never the
 * narrator's), so this reads it off each result and draws it: you, where you are, what's waiting, what you
 * can do, who's about. It opens on the first Dragon's Door result of a session and never in sessions that
 * aren't playing. It only reads: nothing here changes the game.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Character, Game } from '../types'

const PANE = 'dragons-door'
const TITLE = "Dragon's Door"
// Change the tag when Game's fields change: it declines what an earlier version stored.
const game = atom({ plugin: 'dragons-door', key: 'game' } as const,
  { isPlaying: false, isShown: false, character: null, actions: [], map: [], mapAt: '', online: [], at: 0 } as Game, { shape: 'game-3' })

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

const PANE_NOTE = "Dragon's Door: the player can see a side pane with their character, HP, mana or specials, gold, turns, place, map, what's waiting and what they can do, drawn from the game's own state. While it's showing, leave the status line out of your replies (the menu of hotkeys stays). Everything else in the narrator's rules still holds."

const RESULT_NOTE = "The Dragon's Door side pane is showing the player's numbers right now. Don't print the status line in this reply; give the menu only."

/** The game's tools, as the engine names them: mcp__plugin_dragons-door_<server>__<tool>. */
const OURS = /^mcp__plugin_dragons-door_/

/** Ask the realm for the map where the player stands, through the plugin's own MCP server. */
async function refreshMap($: EngineInterface, at: string, server: string) {
  // The server's name as the tool call spelled it (plugin_dragons-door_dragons-door), which $.mcp.call takes;
  // failing that, whatever the session runs this plugin's server under.
  const names = [server, 'plugin:dragons-door:dragons-door']
  try { const c = await $.mcp.connect('dragons-door'); if (c.isConnected && !names.includes(c.server)) names.push(c.server) } catch { /* use the first */ }
  for (const name of names) {
    try {
      const res = await $.mcp.call(name, 'map', {})
      const block = res.content?.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined
      const r = parse(block?.text)
      const m = (Array.isArray(r?.events) ? (r!.events as Ev[]) : []).find(x => x.kind === 'map')?.map
      if (Array.isArray(m)) { await update($, game, g => ({ ...g, map: (m as string[]).slice(0, 15), mapAt: at })); return }
      $.ui.log(`dragons-door pane: map from ${name} had no map (${(block?.text ?? '').slice(0, 120)})`, { to: 'debug' })
    } catch (err) {
      $.ui.log(`dragons-door pane: map from ${name} failed: ${(err as Error)?.message ?? err}`, { to: 'debug' })
    }
  }
}

/** Open the pane, and remember whether a surface is drawing it. */
async function show($: EngineInterface) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  await update($, game, g => ({ ...g, isShown: Boolean(r?.isPlaced) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'door-pane', description: "Show the Dragon's Door pane" })
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
    const map = events.find(x => x.kind === 'map')?.map
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
    // Moved? Fetch the map around them (a read, straight from the plugin's own server; the narrator never sees it).
    const here = (r.state as Character | undefined)?.place
    const at = here ? `${here.x},${here.y}` : 'town'
    if (r.state && !Array.isArray(map) && at !== (await read($, game)).mapAt) await refreshMap($, at, e.tool.replace(/^mcp__/, '').replace(/__[^_].*$/, ''))
    else if (Array.isArray(map)) await update($, game, g => ({ ...g, mapAt: at }))
    // Right beside the result, where the narrator reads it, not just in the system prompt: the pane has the numbers.
    if (ran.deny === undefined && (await read($, game)).isShown) return { ...ran, context: [...(ran.context ?? []), RESULT_NOTE] }
    return ran
  }).catch(($, e, next) => next(e)) // the pane only watches: if drawing fails, the game call goes on as it was

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, game, g => ({ ...g, isShown: false }))
    return next(e)
  })

  // While the pane is up it carries the numbers, so the narrator can leave the status line out of its replies.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const g = await read($, game)
    if (!g.isPlaying || !g.isShown) return r
    return { sections: [...r.sections, { id: 'dragons-door:pane', scope: 'session', text: PANE_NOTE }] }
  }).catch(($, e, next) => next(e))

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
}
