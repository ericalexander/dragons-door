/**
 * The map as a picture. The realm sends maps as rows of symbols (the same ones the text map shows); this turns
 * them into pixels for terminals that can show pictures (kitty, Ghostty, iTerm2, WezTerm) and into an SVG for the
 * desktop app, which takes SVG and not pixels. Nothing here reads or sends anything: it only draws what it's given.
 */

/** One tile's symbol, as the realm's text map uses them. */
export type Sym = '@' | 'T' | '.' | '%' | '~' | 'n' | '^' | 'O' | '+' | '?' | ' '

type RGB = readonly [number, number, number]

/** Colours by symbol, on a dark ground. */
export const COLOURS: Record<string, RGB> = {
  '.': [120, 168, 72],   // meadow
  '%': [44, 110, 52],    // forest
  '~': [70, 112, 112],   // marsh
  'n': [150, 112, 76],   // hills
  '^': [118, 108, 104],  // crags
  'T': [214, 160, 46],   // town
  'O': [150, 112, 76],   // a cave sits in hills or crags
  '+': [120, 168, 72],   // the shrine
  '?': [52, 46, 40],     // not yet walked, next to somewhere you have
}
const GROUND: RGB = [30, 26, 22]
const GRID: RGB = [44, 39, 34]
const INK: RGB = [24, 20, 16]
const YOU: RGB = [226, 72, 58]
const GOLD: RGB = [242, 206, 120]

/** A grid of symbols: rows top to bottom, columns west to east. */
export type Grid = Sym[][]

/** The pane's map: the realm spaces its symbols out ("% . T"), so every other character is a tile. */
export function gridFromSpaced(lines: readonly string[]): Grid {
  const w = Math.max(0, ...lines.map(l => Math.ceil(l.length / 2)))
  return lines.map(l => Array.from({ length: w }, (_, i) => (l[i * 2] ?? ' ') as Sym))
}

/** The known-world chart: one character a tile, with where you stand marked on it. */
export function gridFromChart(c: Chart): Grid {
  const w = Math.max(0, ...c.rows.map(r => r.length))
  const g = c.rows.map(r => Array.from({ length: w }, (_, i) => (r[i] ?? ' ') as Sym))
  const yx = c.you[0] - c.origin[0], yy = c.you[1] - c.origin[1]
  if (g[yy] && yx >= 0 && yx < w) g[yy]![yx] = '@'
  return g
}

/** What the realm's map call sends for the whole known world. */
export type Chart = { origin: [number, number]; you: [number, number]; rows: string[]; names: [number, number, string][]; heard: [number, number, string][] }

/** Pixels: width x height RGBA, base64, `cell` pixels a tile. The terrain under you isn't sent, so you stand on meadow. */
export function raster(g: Grid, cell: number, under: Sym = '.'): { rgba: string; width: number; height: number } {
  const rows = g.length, cols = g[0]?.length ?? 0
  const width = Math.max(1, cols * cell), height = Math.max(1, rows * cell)
  const px = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, c: RGB) => { const i = (y * width + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255 }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, GROUND)
  const r = cell / 2
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const s = g[ty]![tx]!
    if (s === ' ') continue
    const base = COLOURS[s === '@' ? under : s] ?? COLOURS['.']!
    const x0 = tx * cell, y0 = ty * cell
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const edge = x === cell - 1 || y === cell - 1
      const dx = x + 0.5 - r, dy = y + 0.5 - r, d = Math.sqrt(dx * dx + dy * dy)
      let c: RGB = edge ? GRID : base
      if (!edge) {
        if (s === 'T' && (x < 1 || y < 1 || x > cell - 3 || y > cell - 3)) c = INK
        else if (s === 'O' && d < r * 0.55) c = INK
        else if (s === '+' && (Math.abs(dx) < cell * 0.09 || Math.abs(dy) < cell * 0.09) && d < r * 0.7) c = GOLD
        else if (s === '@' && d < r * 0.5) c = YOU
        else if (s === '@' && d < r * 0.7) c = [250, 240, 230]
      }
      put(x0 + x, y0 + y, c)
    }
  }
  return { rgba: base64(px), width, height }
}

/** How many terminal cells a picture of this grid takes: tiles are square and cells about twice as tall as wide. */
export function cellsFor(g: Grid, maxColumns: number): { columns: number; rows: number } {
  const tw = g[0]?.length ?? 1, th = g.length || 1
  const columns = Math.max(2, Math.min(255, maxColumns, tw * 2))
  return { columns, rows: Math.max(1, Math.min(255, Math.round(columns * th / tw / 2))) }
}

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const hex = (c: RGB) => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`

/** The same as an SVG, with place names under their tiles (the desktop app draws SVG, not pixels). */
export function svg(g: Grid, cell: number, labels: { x: number; y: number; name: string; heard?: boolean }[] = [], under: Sym = '.'): string {
  const rows = g.length, cols = g[0]?.length ?? 0
  const W = cols * cell, H = rows * cell + (labels.length ? cell : 0)
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Georgia, serif">`,
    `<rect width="${W}" height="${H}" fill="${hex(GROUND)}"/>`]
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const s = g[ty]![tx]!
    if (s === ' ') continue
    const x = tx * cell, y = ty * cell, m = cell / 2
    out.push(`<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="${hex(COLOURS[s === '@' ? under : s] ?? COLOURS['.']!)}"/>`)
    if (s === 'T') out.push(`<rect x="${x + 1.5}" y="${y + 1.5}" width="${cell - 4}" height="${cell - 4}" fill="none" stroke="${hex(INK)}" stroke-width="1.5"/>`)
    if (s === 'O') out.push(`<circle cx="${x + m}" cy="${y + m}" r="${cell * 0.28}" fill="${hex(INK)}"/>`)
    if (s === '+') out.push(`<path d="M${x + m} ${y + cell * 0.2}V${y + cell * 0.8}M${x + cell * 0.2} ${y + m}H${x + cell * 0.8}" stroke="${hex(GOLD)}" stroke-width="${cell * 0.16}"/>`)
    if (s === '@') out.push(`<circle cx="${x + m}" cy="${y + m}" r="${cell * 0.3}" fill="${hex(YOU)}" stroke="#faf0e6" stroke-width="1.5"/>`)
  }
  for (const l of labels) {
    const x = l.x * cell + cell / 2, y = (l.y + 1) * cell + cell * 0.45
    if (l.heard) out.push(`<rect x="${l.x * cell + 1}" y="${l.y * cell + 1}" width="${cell - 3}" height="${cell - 3}" fill="none" stroke="${hex(GOLD)}" stroke-dasharray="2 2"/>`)
    out.push(`<text x="${x}" y="${y}" font-size="${Math.max(8, cell * 0.42)}" text-anchor="middle" fill="#efe4c9" stroke="${hex(GROUND)}" stroke-width="2.5" paint-order="stroke">${esc(l.name)}${l.heard ? ' (heard of)' : ''}</text>`)
  }
  out.push('</svg>')
  return out.join('')
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64 by hand: the mod runs without Node or a DOM. */
export function base64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? B64[n & 63]! : '=')
  }
  return s
}

/** Whether this terminal shows pictures: kitty's graphics protocol (kitty, Ghostty, WezTerm) or iTerm2's, and not inside tmux. */
export function terminalShowsPictures(env: { term?: string; program?: string; tmux?: string; force?: string }): boolean {
  if (env.force === '1') return true
  if (env.force === '0') return false
  if (env.tmux) return false
  const p = (env.program ?? '').toLowerCase(), t = (env.term ?? '').toLowerCase()
  return ['ghostty', 'wezterm', 'iterm.app', 'kitty'].includes(p) || t.includes('kitty') || t.includes('ghostty')
}
