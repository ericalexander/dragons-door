/**
 * The title screen as a picture: the same block art the enter skill prints, turned into pixels on a clear
 * background, so it sits on any terminal theme. Each character cell becomes 2 x 2 pixels (the half blocks
 * fill their halves; the shade blocks are see-through in steps).
 */
import { base64 } from './mapart'

const DRAGON = [
  '                                       ▄▄▄██',
  '               ▄▄                 ▄▄████▀▀ █▌',
  '              ▐██▄▄▄         ▄▄████▀▀ ▐█  ▐█',
  '          ▄▄▄▄████████▄  ▄▄███▀▀  ▐█  ▐█  █▌',
  '        ▄███▀▀ ● ▀█████▌▐█▀▀  ▐█  ▐█  █▌ ▄█▀',
  '       ▐██▀       ▐█████▐█▄▄▄▄██▄▄██▄▄██▄█▀',
  '░░▒▒▓▓▓▓█▀▀█▀█▀▄   ███████▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀           ▄',
  ' ░▒▒▓▓▓▓▓▀ ▀ ▀    ▄██████████▄                    ▄█▌',
  '    ░░▒▒         ▐██████████████▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄███▀',
  '                  ▀████████████████████████████████▀',
  '                   ▐████▀▀▀▀▀▀▀▀▀████▀▀▀▀▀▀▀▀▀▀▀▀',
  '                   ▐███▌         ▐███▌',
  '                  ▄████▄        ▄████▄',
]
const TITLE = [
  '░█▀▄░█▀▄░█▀█░█▀▀░█▀█░█▀█░▀░█▀▀░░░█▀▄░█▀█░█▀█░█▀▄',
  '░█░█░█▀▄░█▀█░█░█░█░█░█░█░░░▀▀█░░░█░█░█░█░█░█░█▀▄',
  '░▀▀░░▀░▀░▀░▀░▀▀▀░▀▀▀░▀░▀░░░▀▀▀░░░▀▀░░▀▀▀░▀▀▀░▀░▀',
]
/** Rows of art: the dragon, one blank row, the name. */
export const LOGO_ROWS = DRAGON.length + 1 + TITLE.length
export const LOGO_COLUMNS = Math.max(...DRAGON.map(r => [...r].length), ...TITLE.map(r => [...r].length))

type RGBA = readonly [number, number, number, number]
const RED: RGBA = [201, 70, 44, 255]
const EYE: RGBA = [255, 214, 122, 255]
const GOLD: RGBA = [214, 162, 58, 255]
const fire = (a: number): RGBA => [236, 120 + Math.round(a * 0.4), 40, a]

/** Which of a cell's four quarters (top-left, top-right, bottom-left, bottom-right) a character fills. */
const QUARTERS: Record<string, [number, number, number, number]> = {
  '█': [1, 1, 1, 1], '▀': [1, 1, 0, 0], '▄': [0, 0, 1, 1], '▌': [1, 0, 1, 0], '▐': [0, 1, 0, 1],
}

/** The logo as RGBA pixels, `scale` pixels to a quarter cell, transparent where there's no ink. */
export function logoRaster(scale = 4): { rgba: string; width: number; height: number } {
  const width = LOGO_COLUMNS * 2 * scale, height = LOGO_ROWS * 2 * scale
  const px = new Uint8Array(width * height * 4)
  const fill = (cx: number, cy: number, q: number, c: RGBA) => {
    const qx = cx * 2 + (q % 2), qy = cy * 2 + (q >> 1)
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = ((qy * scale + y) * width + qx * scale + x) * 4
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3]
    }
  }
  const draw = (rows: string[], top: number, title: boolean) => rows.forEach((row, ry) => [...row].forEach((ch, cx) => {
    const cy = top + ry
    const shade = ch === '░' ? 0.3 : ch === '▒' ? 0.55 : ch === '▓' ? 0.8 : 0
    // The dragon's breath is fire. In the name, the shade is the ground behind the letters: left clear, so it sits on any theme.
    if (shade) { if (!title) for (let q = 0; q < 4; q++) fill(cx, cy, q, fire(Math.round(255 * shade))); return }
    if (ch === '●') { fill(cx, cy, 1, EYE); return }
    const qs = QUARTERS[ch]
    if (!qs) return
    qs.forEach((on, q) => { if (on) fill(cx, cy, q, title ? GOLD : RED) })
  }))
  draw(DRAGON, 0, false)
  draw(TITLE, DRAGON.length + 1, true)
  return { rgba: base64(px), width, height }
}

/** The same as SVG rects (the desktop app takes SVG, not pixels). */
export function logoSvg(cell = 8): string {
  const W = LOGO_COLUMNS * cell, H = LOGO_ROWS * cell * 2
  const q = cell / 2, qh = cell
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">`]
  const rgba = (c: RGBA) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`
  const draw = (rows: string[], top: number, title: boolean) => rows.forEach((row, ry) => [...row].forEach((ch, cx) => {
    const x = cx * cell, y = (top + ry) * cell * 2
    const shade = ch === '░' ? 0.3 : ch === '▒' ? 0.55 : ch === '▓' ? 0.8 : 0
    if (shade) { if (!title) out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell * 2}" fill="${rgba(fire(Math.round(255 * shade)))}"/>`); return }
    if (ch === '●') { out.push(`<rect x="${x + q}" y="${y}" width="${q}" height="${qh}" fill="${rgba(EYE)}"/>`); return }
    const qs = QUARTERS[ch]
    if (!qs) return
    qs.forEach((on, i) => { if (on) out.push(`<rect x="${x + (i % 2) * q}" y="${y + (i >> 1) * qh}" width="${q}" height="${qh}" fill="${rgba(title ? GOLD : RED)}"/>`) })
  }))
  draw(DRAGON, 0, false)
  draw(TITLE, DRAGON.length + 1, true)
  out.push('</svg>')
  return out.join('')
}
