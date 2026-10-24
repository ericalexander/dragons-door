/** What the game pane remembers: the last state the realm sent, and a few things only some calls carry. */
export type Character = {
  name: string; class: string; path?: string; level: number; exp: number; exp_next: number | null;
  hp: number; max_hp: number; gold: number; bank: number; gems: number;
  forest_fights: number; player_fights: number; specials: number; mana?: number; mana_max?: number;
  weapon: string; armor: string; alive: boolean; in_encounter: boolean;
  bag_used: number; bag_capacity: number; unread_mail: number; unread_news: number; gifts_waiting?: number;
  time_of_day?: string; place: { name: string; terrain: string; level: number; x?: number; y?: number } | null; cave_depth?: number | null;
  quests?: { title: string; days_left?: number; doing?: string }[];
};
export type Game = {
  /** Set once a Dragon's Door result has been seen this session: the pane only exists for people playing. */
  isPlaying: boolean;
  /** Whether a surface is drawing the pane now (so the narrator can leave the status line out). */
  isShown: boolean;
  character: Character | null;
  actions: string[];
  /** The map around the player, as the realm draws it: it comes with every move and status. */
  map: string[];
  /** Who the last rankings said was in the realm now. */
  online: string[];
  /** When the state last changed, ms since the epoch. */
  at: number;
};

declare module 'claude-code' {
  interface PluginState {
    'dragons-door': { game: Shaped<Game> }
  }
}
