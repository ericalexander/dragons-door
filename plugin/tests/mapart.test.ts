import { expect, test } from 'claude-code/testing'
import { base64, cellsFor, gridFromChart, gridFromSpaced, raster, svg, terminalShowsPictures } from '../hooks/mapart'

test('the pane map turns into a picture of the right size', () => {
  const g = gridFromSpaced(['? . %', '% @ O', '  ? n'])
  expect(g.length).toBe(3)
  expect(g[1]).toEqual(['%', '@', 'O'])
  const r = raster(g, 10)
  expect([r.width, r.height]).toEqual([30, 30])
  expect(r.rgba.length).toBe(Math.ceil((30 * 30 * 4) / 3) * 4)
  expect(cellsFor(g, 26)).toEqual({ columns: 6, rows: 3 })
})

test('the known-world chart marks where you stand', () => {
  const g = gridFromChart({ origin: [-1, -1], you: [0, 0], rows: ['.%', 'T.'], names: [], heard: [] })
  expect(g[1]![1]).toBe('@')
  expect(svg(g, 16, [{ x: 0, y: 1, name: 'Brightwater & co' }])).toContain('Brightwater &amp; co')
})

test('base64 by hand matches the standard encoding', () => {
  expect(base64(new Uint8Array([1, 2, 3, 250, 251]))).toBe('AQID+vs=')
})

test('pictures only where the terminal can show them, never inside tmux', () => {
  expect(terminalShowsPictures({ program: 'ghostty' })).toBe(true)
  expect(terminalShowsPictures({ term: 'xterm-kitty' })).toBe(true)
  expect(terminalShowsPictures({ program: 'Apple_Terminal' })).toBe(false)
  expect(terminalShowsPictures({ program: 'ghostty', tmux: '/tmp/tmux-1' })).toBe(false)
  expect(terminalShowsPictures({ program: 'Apple_Terminal', force: '1' })).toBe(true)
})
