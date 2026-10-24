/**
 * Dragon's Door's side pane. Every game tool result already carries the whole state (the server's, never the
 * narrator's), so this reads it off each result and draws it: you, where you are, what's waiting, what you
 * can do, who's about. It opens on the first Dragon's Door result of a session and never in sessions that
 * aren't playing. It only reads: nothing here changes the game.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Character, Game } from '../types'

const PANE = 'dragons-door'
const TITLE = "Dragon's Door"
// Change the tag when Game's fields change: it declines what an earlier version stored.
const game = atom({ plugin: 'dragons-door', key: 'game' } as const,
  { isPlaying: false, isShown: false, character: null, actions: [], map: [], online: [], at: 0 } as Game, { shape: 'game-2' })

/** A Dragon's Door result, or null: every one starts with the game's label (the plugin's text() adds it). */
function parse(text: string | undefined): Record<string, unknown> | null {
  if (!text || !text.includes("Dragon's Door")) return null
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    return typeof v.game === 'string' && v.game.startsWith("Dragon's Door") ? v : null
  } catch { return null }
}

type Ev = { kind?: string; map?: unknown; players?: unknown }

/** What the menu's actions mean, in a word or two; the narrator gives the keys. */
const ACTION: Record<string, string> = {
  explore: 'Explore', forest: 'Hunt', move: 'Walk on', return: 'Return to town', map: 'Map', town: 'Town', tavern: 'Tavern',
  healer: 'Healer', shop: 'Smith', bank: 'Bank', auction: 'Auction house', workshop: 'Workshop', library: 'Library', chapel: 'Chapel',
  inn: 'Inn', bard: 'Listen to the bard', flirt: 'Flirt', challenge: 'Challenge', train: 'Train', dragon: 'The dragon', specialize: 'Specialize',
  perform: 'Play a set', instruments: "Dunstan's instruments", descend: 'Go down', deeper: 'Deeper', climb: 'Climb out', mine: 'Mine',
  take: 'Take it', event: 'Look closer', 'fight attack': 'Attack', 'fight special': 'Special', 'fight heal': 'Pray', 'fight staff': 'Staff', 'fight run': 'Run',
}
const SKIP = new Set(['status', 'news', 'rankings', 'mail', 'bag', 'equip ground'])

const bar = (have: number, max: number, width: number) => {
  const full = max > 0 ? Math.max(0, Math.min(width, Math.round((have / max) * width))) : 0
  return '█'.repeat(full) + '░'.repeat(width - full)
}
const n = (v: number) => v.toLocaleString('en-US')

const PANE_NOTE = "Dragon's Door: the player can see a side pane with their character, HP, mana or specials, gold, turns, place, map, what's waiting and what they can do, drawn from the game's own state. While it's showing, leave the status line out of your replies (the menu of hotkeys stays). Everything else in the narrator's rules still holds."

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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const g = await read($, game)
    const c = g.character
    const cols = e.viewport?.columns ?? 32
    const w = Math.max(8, Math.min(20, cols - 18))
    if (!c) return <Box><Text dimColor>Enter the realm to see your character here.</Text></Box>
    const heading = (t: string) => <Text bold color="claude">{t}</Text>
    const mana = c.mana_max !== undefined
    const waiting: string[] = []
    if (c.unread_mail) waiting.push(`${c.unread_mail} letter${c.unread_mail > 1 ? 's' : ''}`)
    if (c.gifts_waiting) waiting.push(`${c.gifts_waiting} gift${c.gifts_waiting > 1 ? 's' : ''} from the courier`)
    if (c.unread_news) waiting.push(`${c.unread_news} news`)
    const can = g.actions.filter(a => !SKIP.has(a)).map(a => ACTION[a] ?? a)
    const where = c.place
      ? `${c.place.name}${c.cave_depth ? `, ${c.cave_depth} down` : ''} · ${c.place.terrain}, level ${c.place.level}`
      : 'Brightwater'
    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="column">
          {heading(`${c.name}`)}
          <Text dimColor>{c.class}, level {c.level}{c.path ? ` · ${c.path}` : ''}</Text>
          <Text><Text mono color={c.hp * 4 < c.max_hp ? 'error' : 'success'}>{bar(c.hp, c.max_hp, w)}</Text> HP {c.hp}/{c.max_hp}</Text>
          {mana
            ? <Text><Text mono color="suggestion">{bar(c.mana ?? 0, c.mana_max ?? 0, w)}</Text> Mana {c.mana}/{c.mana_max}</Text>
            : <Text>Specials {c.specials}</Text>}
          {c.exp_next !== null && <Text dimColor>Exp {n(c.exp)} / {n(c.exp_next)}</Text>}
          <Text>Gold {n(c.gold)} · bank {n(c.bank)}{c.gems ? ` · gems ${c.gems}` : ''}</Text>
          <Text>Turns {c.forest_fights} · PvP {c.player_fights} · bag {c.bag_used}/{c.bag_capacity}</Text>
          <Text dimColor>{c.weapon} · {c.armor}</Text>
        </Box>
        <Box flexDirection="column">
          {heading('Where')}
          <Text>{where}</Text>
          {c.time_of_day && <Text dimColor>{c.time_of_day}</Text>}
          {g.map.length > 0 && g.map.map(line => <Text mono>{line}</Text>)}
        </Box>
        {!c.alive && <Text color="error">Dead until the new day.</Text>}
        {c.in_encounter && <Text color="warning" bold>In a fight</Text>}
        {waiting.length > 0 && <Box flexDirection="column">{heading('Waiting')}{waiting.map(t => <Text>{t}</Text>)}</Box>}
        {(c.quests?.length ?? 0) > 0 && (
          <Box flexDirection="column">
            {heading('Quests')}
            {c.quests!.map(q => <Text>{q.title}{q.days_left !== undefined ? <Text dimColor> · {q.days_left}d</Text> : null}</Text>)}
          </Box>
        )}
        {can.length > 0 && <Box flexDirection="column">{heading('You can')}<Text>{can.join(' · ')}</Text></Box>}
        {g.online.length > 0 && <Box flexDirection="column">{heading('In the realm now')}<Text>{g.online.map(x => `● ${x}`).join('  ')}</Text></Box>}
      </Box>
    )
  })
}
