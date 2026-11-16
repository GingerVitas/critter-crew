import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Critter, Species, ToolCallLog } from '../types'

const PANE = 'critter-crew'
const TITLE = 'Critter Crew'

const crew = atom({ plugin: 'critter-crew', key: 'crew' } as const, [], {
  shape: 'crew-1',
})
const clockNow = atom({ plugin: 'critter-crew', key: 'now' } as const, 0)
/** Agent id → the model it was started on, as `agent.spawn` resolved it. */
const models = atom({ plugin: 'critter-crew', key: 'models' } as const, {})
/** Agent id → its recent tool calls, oldest first. */
const calls = atom({ plugin: 'critter-crew', key: 'calls' } as const, {}, { shape: 'calls-1' })
/** The critters whose tool log is unfolded. */
const opened = atom({ plugin: 'critter-crew', key: 'opened' } as const, [])

const MAX_LOG = 40
const SHOWN_LOG = 12

const CALL_LOOK: Record<ToolCallLog['status'], { glyph: string; color: 'claude' | 'success' | 'error' | 'warning' }> = {
  running: { glyph: '◌', color: 'claude' },
  ok: { glyph: '✓', color: 'success' },
  error: { glyph: '✗', color: 'error' },
  denied: { glyph: '⊘', color: 'warning' },
}

/** `Read 4 · Grep 2 · Bash 1`, busiest first, at most four tools. */
function toolTally(log: ToolCallLog[]): string {
  const counts = new Map<string, number>()
  for (const call of log) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1])
  const shown = top.slice(0, 4).map(([tool, n]) => `${shortTool(tool)} ${n}`)
  if (top.length > 4) shown.push(`+${top.length - 4} more`)
  return shown.join(' · ')
}

/** `mcp__github__create_issue` → `github·create_issue`. */
function shortTool(tool: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1]!.slice(0, 12)}·${m[2]}` : tool
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : elapsed(ms)
}

// ── Who hatches ─────────────────────────────────────────────────────────────

const NAMES = [
  'Pip', 'Mochi', 'Biscuit', 'Nori', 'Pickle', 'Tofu', 'Waffle', 'Bean',
  'Sprout', 'Noodle', 'Dumpling', 'Pebble', 'Clover', 'Fig', 'Juniper',
  'Toast', 'Maple', 'Kiwi', 'Sesame', 'Ziggy', 'Bao', 'Momo', 'Taro', 'Yuzu',
]

const EPITHET: Record<Species, string> = {
  blob: 'the Tinkerer',
  cat: 'the Curious',
  bunny: 'the Speedy',
  frog: 'the Scout',
  owl: 'the Wise',
  octo: 'the Multitasker',
}

const ENDED = new Set<Critter['status']>(['completed', 'failed', 'killed'])
const NAPPING = new Set<Critter['status']>(['pending', 'waiting', 'idle'])

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function speciesFor(type: string, seed: number): Species {
  const t = type.toLowerCase()
  if (t.includes('explore')) return 'frog'
  if (t.includes('plan')) return 'owl'
  if (t.includes('general')) return 'blob'
  const all: Species[] = ['cat', 'bunny', 'octo', 'blob', 'frog', 'owl']
  return all[seed % all.length]!
}

function hatch(a: AgentInfo, now: number, taken: Set<string>): Critter {
  const seed = hash(a.id)
  let name = NAMES[seed % NAMES.length]!
  for (let i = 1; taken.has(name) && i < NAMES.length; i++) {
    name = NAMES[(seed + i) % NAMES.length]!
  }
  return {
    id: a.id,
    name,
    species: speciesFor(a.type, seed),
    hue: (seed * 137) % 360,
    description: a.description,
    type: a.type,
    status: a.status,
    tools: 0,
    startedAt: now,
    endedAt: ENDED.has(a.status) ? now : undefined,
  }
}

function merge(prev: Critter[], list: AgentInfo[], now: number): Critter[] {
  const byId = new Map(prev.map(c => [c.id, c] as const))
  const taken = new Set(prev.map(c => c.name))
  const listed = new Set<string>()
  for (const a of list) {
    listed.add(a.id)
    const old = byId.get(a.id)
    const c: Critter = old
      ? { ...old, description: a.description || old.description, type: a.type, status: a.status }
      : hatch(a, now, taken)
    taken.add(c.name)
    if (ENDED.has(c.status)) c.endedAt = c.endedAt ?? now
    else c.endedAt = undefined
    byId.set(a.id, c)
  }
  // An agent the engine stopped listing while we thought it busy has wandered off.
  for (const [id, c] of byId) {
    if (!listed.has(id) && !ENDED.has(c.status)) {
      byId.set(id, { ...c, status: 'completed', endedAt: c.endedAt ?? now })
    }
  }
  return [...byId.values()].slice(-40)
}

// ── Keeping the crew current ────────────────────────────────────────────────

async function refresh($: EngineInterface): Promise<void> {
  const [list, now] = await Promise.all([$.agent.list(), $.clock.now()])
  const prev = await read($, crew)
  const next = merge(prev, list, now)
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    await update($, crew, old => merge(old, list, now))
  }
  if (next.some(c => !ENDED.has(c.status))) await update($, clockNow, () => now)
}

/** The few words that say what a call was about: a file, a pattern, a command. */
function callDetail(e: object): string {
  const input = e as Record<string, unknown>
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const path = pick('file_path') ?? pick('notebook_path') ?? pick('path')
  const short = (s: string, n = 60) => {
    const one = s.split(/\r?\n/)[0]!.trim()
    return one.length > n ? `${one.slice(0, n - 1)}…` : one
  }
  if (path) return short(path.split(/[\\/]/).slice(-2).join('/'))
  const text = pick('command') ?? pick('pattern') ?? pick('query') ?? pick('url') ??
    pick('description') ?? pick('skill') ?? pick('prompt')
  return text ? short(text) : ''
}

async function logCall($: EngineInterface, agentId: string, entry: ToolCallLog): Promise<void> {
  await update($, calls, all => ({ ...all, [agentId]: [...(all[agentId] ?? []), entry].slice(-MAX_LOG) }))
}

async function settleCall(
  $: EngineInterface,
  agentId: string,
  id: string,
  status: ToolCallLog['status'],
): Promise<void> {
  const now = await $.clock.now()
  await update($, calls, all => ({
    ...all,
    [agentId]: (all[agentId] ?? []).map(c => (c.id === id ? { ...c, status, ms: now - c.at } : c)),
  }))
}

async function bump($: EngineInterface, agentId: string, tool: string): Promise<void> {
  const known = (await read($, crew)).some(c => c.id === agentId)
  if (!known) await refresh($)
  await update($, crew, list =>
    list.map(c => (c.id === agentId ? { ...c, tools: c.tools + 1, lastTool: tool } : c)),
  )
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

function hslHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function mood(c: Critter): { label: string; theme: 'claude' | 'warning' | 'success' | 'error' | 'subtle' } {
  switch (c.status) {
    case 'running': return { label: 'hard at work', theme: 'claude' }
    case 'pending': return { label: 'hatching…', theme: 'warning' }
    case 'waiting':
    case 'idle': return { label: 'napping', theme: 'subtle' }
    case 'completed': return { label: 'all done!', theme: 'success' }
    case 'failed': return { label: 'took a tumble', theme: 'error' }
    case 'killed': return { label: 'sent home', theme: 'subtle' }
  }
}

/** A terminal face, two frames for the busy ones. */
function face(c: Critter, frame: number): string {
  if (c.status === 'running') return frame % 2 ? '(•ᴗ•)و' : '٩(•ᴗ•)'
  if (NAPPING.has(c.status)) return frame % 2 ? '(-ᴗ-) z' : '(-ᴗ-)zZ'
  if (c.status === 'completed') return '(^ᴗ^)✧'
  return '(×_×)'
}

// ── Which brain each critter runs on ────────────────────────────────────────

type Family = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

type ModelBadge = { label: string; family: Family; color: string; glyph: string }

const FAMILY_LOOK: Record<Family, { color: string; glyph: string }> = {
  opus: { color: '#9b6dff', glyph: '♛' },
  sonnet: { color: '#4f8ff7', glyph: '♪' },
  haiku: { color: '#3fae6a', glyph: '❦' },
  fable: { color: '#f08a3c', glyph: '✦' },
  other: { color: '#8a8f98', glyph: '◆' },
}

/** `us.anthropic.claude-opus-5-5-20260101-v1:0[1m]` → `Opus 5.5 · 1M`. */
function modelBadge(id: string): ModelBadge {
  const raw = id.toLowerCase()
  const isLong = raw.includes('[1m]')
  const m = /(opus|sonnet|haiku|fable)[-_]?(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(raw)
  const family: Family = (m?.[1] as Family | undefined) ?? 'other'
  let label: string
  if (m) {
    const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
    label = m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
  } else if (/^(opus|sonnet|haiku|fable)$/.test(raw)) {
    label = raw.charAt(0).toUpperCase() + raw.slice(1)
  } else {
    label = id.replace(/^.*\//, '').replace(/\[1m\]$/i, '')
  }
  if (isLong) label += ' · 1M'
  return { label, family, ...FAMILY_LOOK[family] }
}

/** A round badge in the corner of the critter, wearing its model's glyph. */
function badgeSvg(b: ModelBadge): string {
  return `<g><circle cx="54" cy="54" r="8.5" fill="${b.color}" stroke="#fff" stroke-width="2"/>` +
    `<text x="54" y="58.2" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="11" fill="#fff">${b.glyph}</text>` +
    `<title>${b.label}</title></g>`
}

// ── The critter itself, an animated SVG ─────────────────────────────────────

function critterSvg(c: Critter, badge?: ModelBadge): string {
  const isDown = c.status === 'failed' || c.status === 'killed'
  const sat = isDown ? 8 : 68
  const body = `hsl(${c.hue} ${sat}% 64%)`
  const belly = `hsl(${c.hue} ${sat}% 84%)`
  const ink = `hsl(${c.hue} ${isDown ? 5 : 40}% 22%)`
  const busy = c.status === 'running'
  const nap = NAPPING.has(c.status)
  const done = c.status === 'completed'

  const ears: Record<Species, string> = {
    blob: `<line x1="32" y1="22" x2="32" y2="10" stroke="${ink}" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="9" r="3.5" fill="${belly}" stroke="${ink}" stroke-width="1.5">${busy ? '<animate attributeName="r" values="3.5;4.5;3.5" dur="0.8s" repeatCount="indefinite"/>' : ''}</circle>`,
    cat: `<path d="M15 30 L18 12 L29 23 Z M49 30 L46 12 L35 23 Z" fill="${body}" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 24 L20 17 L25 22 Z M45 24 L44 17 L39 22 Z" fill="#f7a9c0"/>`,
    bunny: `<ellipse cx="24" cy="14" rx="4.5" ry="11" fill="${body}" stroke="${ink}" stroke-width="1.5"/><ellipse cx="40" cy="14" rx="4.5" ry="11" fill="${body}" stroke="${ink}" stroke-width="1.5"><animateTransform attributeName="transform" type="rotate" values="0 40 24;${busy ? '12' : '4'} 40 24;0 40 24" dur="${busy ? '0.7s' : '3s'}" repeatCount="indefinite"/></ellipse><ellipse cx="24" cy="15" rx="2" ry="7" fill="#f7a9c0"/>`,
    frog: `<circle cx="22" cy="24" r="8" fill="${body}" stroke="${ink}" stroke-width="1.5"/><circle cx="42" cy="24" r="8" fill="${body}" stroke="${ink}" stroke-width="1.5"/>`,
    owl: `<path d="M14 28 L16 14 L26 22 Z M50 28 L48 14 L38 22 Z" fill="${ink}" opacity="0.75"/>`,
    octo: '',
  }

  const eyeY = c.species === 'frog' ? 24 : 34
  let eyes: string
  if (busy) {
    eyes = [22, 42].map(x =>
      `<circle cx="${x}" cy="${eyeY}" r="4.6" fill="#fff" stroke="${ink}" stroke-width="1"/>` +
      `<circle cx="${x}" cy="${eyeY}" r="2.3" fill="${ink}"><animate attributeName="cx" values="${x - 1.5};${x + 1.5};${x - 1.5}" dur="1.6s" repeatCount="indefinite"/></circle>`,
    ).join('')
  } else if (nap) {
    eyes = [22, 42].map(x => `<path d="M${x - 4} ${eyeY} q4 3 8 0" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`).join('')
  } else if (done) {
    eyes = [22, 42].map(x => `<path d="M${x - 4} ${eyeY + 1} q4 -5 8 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`).join('')
  } else {
    eyes = [22, 42].map(x => `<path d="M${x - 3} ${eyeY - 3} l6 6 M${x + 3} ${eyeY - 3} l-6 6" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`).join('')
  }

  const mouth = done
    ? `<path d="M27 41 q5 6 10 0 Z" fill="${ink}"/>`
    : busy
      ? `<ellipse cx="32" cy="42" rx="2.4" ry="2" fill="${ink}"><animate attributeName="ry" values="2;1;2" dur="0.6s" repeatCount="indefinite"/></ellipse>`
      : isDown
        ? `<path d="M27 43 q2.5 -2 5 0 t5 0" stroke="${ink}" stroke-width="1.6" fill="none"/>`
        : `<path d="M29 41 q3 2 6 0" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`

  const cheeks = isDown ? '' : `<ellipse cx="16" cy="40" rx="3.5" ry="2" fill="#ff8fab" opacity="0.55"/><ellipse cx="48" cy="40" rx="3.5" ry="2" fill="#ff8fab" opacity="0.55"/>`

  const feet = c.species === 'octo'
    ? [18, 26, 38, 46].map((x, i) => `<path d="M${x} 50 q${i % 2 ? 3 : -3} 6 0 9" stroke="${body}" stroke-width="4.5" fill="none" stroke-linecap="round">${busy ? `<animateTransform attributeName="transform" type="rotate" values="0 ${x} 50;${i % 2 ? 14 : -14} ${x} 50;0 ${x} 50" dur="0.5s" begin="${i * 0.12}s" repeatCount="indefinite"/>` : ''}</path>`).join('')
    : [24, 40].map((x, i) => `<ellipse cx="${x}" cy="54" rx="5.5" ry="3.2" fill="${body}" stroke="${ink}" stroke-width="1.4">${busy ? `<animate attributeName="cy" values="54;52;54" dur="0.4s" begin="${i * 0.2}s" repeatCount="indefinite"/>` : ''}</ellipse>`).join('')

  const owlWings = c.species === 'owl'
    ? `<path d="M12 38 q-4 8 4 14 M52 38 q4 8 -4 14" stroke="${ink}" stroke-width="2" fill="none" opacity="0.5"/>`
    : ''

  const bob = busy
    ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur="0.6s" repeatCount="indefinite"/>'
    : nap
      ? '<animateTransform attributeName="transform" type="scale" values="1 1;1.015 0.985;1 1" dur="3s" repeatCount="indefinite" additive="sum"/>'
      : isDown
        ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.5;0 0" dur="2.4s" repeatCount="indefinite"/>'
        : ''

  const extras: string[] = []
  if (busy) {
    // A spark of effort orbiting the head.
    extras.push(`<g><animateTransform attributeName="transform" type="rotate" from="0 32 30" to="360 32 30" dur="2.2s" repeatCount="indefinite"/><path d="M58 22 l1.6 3.4 3.4 1.6 -3.4 1.6 -1.6 3.4 -1.6 -3.4 -3.4 -1.6 3.4 -1.6 Z" fill="hsl(${(c.hue + 50) % 360} 90% 60%)"/></g>`)
  }
  if (nap) {
    extras.push(['z', 'Z'].map((z, i) => `<text x="${50 + i * 5}" y="${18 - i * 6}" font-family="sans-serif" font-weight="700" font-size="${8 + i * 3}" fill="${ink}" opacity="0"><animate attributeName="opacity" values="0;0.8;0" dur="2.4s" begin="${i * 0.8}s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 4;3 -4" dur="2.4s" begin="${i * 0.8}s" repeatCount="indefinite"/>${z}</text>`).join(''))
  }
  if (done) {
    const bits: [number, number, number][] = [[8, 14, 50], [56, 10, 160], [6, 46, 280], [58, 44, 20], [32, 2, 210]]
    extras.push(bits.map(([x, y, h], i) => `<rect x="${x}" y="${y}" width="4" height="4" rx="1" fill="hsl(${h} 85% 62%)"><animate attributeName="opacity" values="1;0.2;1" dur="${1.2 + i * 0.2}s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="rotate" values="0 ${x + 2} ${y + 2};180 ${x + 2} ${y + 2};360 ${x + 2} ${y + 2}" dur="${2 + i * 0.3}s" repeatCount="indefinite"/></rect>`).join(''))
  }
  if (isDown) {
    extras.push(`<ellipse cx="32" cy="6" rx="10" ry="2.8" fill="none" stroke="#f5c542" stroke-width="2"><animate attributeName="cy" values="6;4;6" dur="2.4s" repeatCount="indefinite"/></ellipse>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56">
<ellipse cx="32" cy="60" rx="17" ry="2.6" fill="#000" opacity="0.13">${busy ? '<animate attributeName="rx" values="17;14;17" dur="0.6s" repeatCount="indefinite"/>' : ''}</ellipse>
<g>${bob}
${feet}
${ears[c.species]}
<ellipse cx="32" cy="38" rx="21" ry="17" fill="${body}" stroke="${ink}" stroke-width="1.6"/>
<ellipse cx="32" cy="45" rx="11" ry="7.5" fill="${belly}"/>
${owlWings}
${eyes}${cheeks}${mouth}
</g>
${extras.join('')}
${badge ? badgeSvg(badge) : ''}
</svg>`
}

function meadowSvg(busy: number, done: number): string {
  const sprouts = Array.from({ length: Math.min(done, 12) }, (_, i) =>
    `<g transform="translate(${18 + i * 17} ${44 - (i % 3)})"><path d="M0 0 q-1 -6 0 -9" stroke="#3a9d5d" stroke-width="1.5" fill="none"/><circle cx="0" cy="-10" r="2.6" fill="hsl(${(i * 67) % 360} 85% 68%)"/></g>`,
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 56" width="260" height="56">
<style>
.sky{fill:url(#day)} .sun{fill:#ffd166} .star{opacity:0} .hill1{fill:#9be3a1} .hill2{fill:#6cc785} .cloud{fill:#fff;opacity:.9}
@media (prefers-color-scheme: dark){ .sky{fill:url(#night)} .sun{fill:#f1f0e8} .star{opacity:.85} .hill1{fill:#2f5d4a} .hill2{fill:#24493a} .cloud{fill:#9aa7c7;opacity:.35} }
</style>
<defs>
<linearGradient id="day" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#fdf1d6"/></linearGradient>
<linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2140"/><stop offset="1" stop-color="#3b3463"/></linearGradient>
<clipPath id="r"><rect width="260" height="56" rx="10"/></clipPath>
</defs>
<g clip-path="url(#r)">
<rect class="sky" width="260" height="56"/>
<circle class="star" cx="40" cy="10" r="1"/><circle class="star" cx="120" cy="7" r="1.2"/><circle class="star" cx="170" cy="16" r="0.9"/><circle class="star" cx="80" cy="20" r="0.8"/><circle class="star" cx="200" cy="8" r="1"/>
<circle class="sun" cx="228" cy="16" r="9"><animate attributeName="r" values="9;10;9" dur="4s" repeatCount="indefinite"/></circle>
<g class="cloud"><animateTransform attributeName="transform" type="translate" values="-60 0;280 0" dur="38s" repeatCount="indefinite"/><ellipse cx="0" cy="14" rx="14" ry="5"/><ellipse cx="9" cy="11" rx="8" ry="5"/></g>
<g class="cloud"><animateTransform attributeName="transform" type="translate" values="-140 0;220 0" dur="52s" repeatCount="indefinite"/><ellipse cx="0" cy="24" rx="11" ry="4"/><ellipse cx="7" cy="21" rx="6" ry="4"/></g>
<path class="hill2" d="M0 44 Q50 30 110 42 T260 38 V56 H0 Z"/>
<path class="hill1" d="M0 50 Q70 38 140 48 T260 46 V56 H0 Z"/>
${sprouts}
${busy > 0 ? `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur="0.5s" repeatCount="indefinite"/><circle cx="${30 + (busy % 5) * 40}" cy="46" r="3" fill="#ffb4a2"/></g>` : ''}
</g>
</svg>`
}

const EGG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="72" height="72">
<ellipse cx="32" cy="58" rx="14" ry="2.5" fill="#000" opacity="0.12"/>
<g><animateTransform attributeName="transform" type="rotate" values="0 32 56;-7 32 56;0 32 56;7 32 56;0 32 56;0 32 56" dur="2.6s" repeatCount="indefinite"/>
<path d="M32 8 C46 8 52 30 52 40 C52 51 43 57 32 57 C21 57 12 51 12 40 C12 30 18 8 32 8 Z" fill="#fff6e3" stroke="#d9b98a" stroke-width="1.6"/>
<circle cx="24" cy="30" r="3" fill="#f7c6d9"/><circle cx="40" cy="22" r="2.4" fill="#bde0fe"/><circle cx="38" cy="42" r="3.4" fill="#caffbf"/>
</g></svg>`

// ── Wiring ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'crew',
      description: 'Open the Critter Crew sidebar of subagents',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await refresh($).catch(() => undefined)
    $.clock.every(1000, () => {
      void refresh($).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Critter Crew is out in the meadow.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) void refresh($).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) void refresh($).catch(() => undefined)

    return next(e)
  })

  // The spawn is the one place the engine says which model a subagent got.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const { agentId, model } = started
    if (agentId !== undefined && model) {
      await update($, models, all => ({ ...all, [agentId]: model })).catch(() => undefined)
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)

    const id = e.tool_use_id ?? `${String(e.tool)}-${Math.random().toString(36).slice(2)}`
    await bump($, agentId, String(e.tool)).catch(() => undefined)
    const at = await $.clock.now().catch(() => 0)
    await logCall($, agentId, {
      id,
      tool: String(e.tool),
      detail: callDetail(e),
      status: 'running',
      at,
    }).catch(() => undefined)

    const ran = await next(e)
    const status: ToolCallLog['status'] = ran.deny ? 'denied' : ran.isError ? 'error' : 'ok'
    await settleCall($, agentId, id, status).catch(() => undefined)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const list = await read($, crew)
    const now = await read($, clockNow)
    const modelOf = await read($, models)
    const callsOf = await read($, calls)
    const openIds = new Set(await read($, opened))
    const canView = e.surface === 'terminal'
    const frame = Math.floor(now / 1000)

    const order = (c: Critter) => (c.status === 'running' ? 0 : NAPPING.has(c.status) ? 1 : 2)
    const sorted = [...list].sort((a, b) => order(a) - order(b) || b.startedAt - a.startedAt)
    const busy = list.filter(c => c.status === 'running').length
    const napping = list.filter(c => NAPPING.has(c.status)).length
    const done = list.filter(c => c.status === 'completed').length
    const oops = list.filter(c => c.status === 'failed' || c.status === 'killed').length
    const toolsTotal = list.reduce((n, c) => n + c.tools, 0)

    const toggle = (c: Critter) =>
      update($, opened, ids => (ids.includes(c.id) ? ids.filter(id => id !== c.id) : [...ids, c.id]))
    const transcript = async (c: Critter) => {
      const r = await $.ui.view({ agentId: c.id })
      if (r && 'deny' in r && r.deny) $.ui.toast(`Can't open ${c.name}'s transcript here (${r.deny}).`)
    }
    const shoo = async () => {
      const gone = new Set(list.filter(c => ENDED.has(c.status)).map(c => c.id))
      const keep = <T,>(all: Record<string, T>) =>
        Object.fromEntries(Object.entries(all).filter(([id]) => !gone.has(id)))
      await update($, crew, all => all.filter(c => !ENDED.has(c.status)))
      await update($, models, keep)
      await update($, calls, keep)
      await update($, opened, ids => ids.filter(id => !gone.has(id)))
    }

    const summary = [
      busy && `🛠 ${busy} busy`,
      napping && `💤 ${napping} napping`,
      done && `✨ ${done} done`,
      oops && `🩹 ${oops} oops`,
    ].filter(Boolean).join('  ·  ')

    return (
      <Box flexDirection="column" gap="sm">
        {Svg ? (
          <Svg source={meadowSvg(busy, done)} alt={`Meadow: ${busy} busy, ${done} done`} isInteractive />
        ) : (
          <Text color="claude" weight="bold">✿ Critter Crew ✿</Text>
        )}

        {list.length === 0 ? (
          <Box flexDirection="column" alignItems="center" gap="xs" padding="md">
            {Svg ? <Svg source={EGG_SVG} alt="A wobbling egg" isInteractive /> : <Text>  ( ° )  </Text>}
            <Text weight="semibold">No critters yet</Text>
            <Text dimColor size="footnote">Spawn a subagent and one will hatch here.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" gap="sm">
            <Text dimColor size="footnote">
              {summary}
              {toolsTotal > 0 ? `  ·  ${toolsTotal} tool${toolsTotal === 1 ? '' : 's'} swung` : ''}
            </Text>

            {sorted.map(c => {
              const m = mood(c)
              const accent = hslHex(c.hue, 62, 52)
              const isEnded = ENDED.has(c.status)
              const modelId = modelOf[c.id]
              const badge = modelId ? modelBadge(modelId) : undefined
              const log = callsOf[c.id] ?? []
              const isOpen = openIds.has(c.id)
              const tally = toolTally(log)
              return (
                <Box
                  key={`card-${c.id}`}
                  flexDirection="column"
                  gap="xs"
                  borderStyle="round"
                  borderColor={c.status === 'running' ? accent : m.theme}
                  borderDimColor={isEnded}
                  paddingX={1}
                >
                <Box flexDirection="row" gap="sm" alignItems="center">
                  {Svg ? (
                    <Svg source={critterSvg(c, badge)} alt={`${c.name} the ${c.species}, ${m.label}${badge ? `, on ${badge.label}` : ''}`} width={56} height={56} isInteractive />
                  ) : (
                    <Text color={accent}>{face(c, frame)}</Text>
                  )}
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text>
                      <Text color={accent} weight="bold">{c.name}</Text>
                      <Text dimColor> {EPITHET[c.species]}</Text>
                      {badge && (
                        <Text color={badge.color} weight="semibold" size="footnote">
                          {'  '}{badge.glyph} {badge.label}
                        </Text>
                      )}
                    </Text>
                    <Text dimColor={isEnded}>{c.description || 'mysterious errand'}</Text>
                    <Text size="footnote">
                      <Text color={m.theme}>● {m.label}</Text>
                      <Text dimColor tabular>
                        {'  '}{c.type} · {c.tools} tool{c.tools === 1 ? '' : 's'} · {elapsed((c.endedAt ?? (now || c.startedAt)) - c.startedAt)}
                      </Text>
                    </Text>
                    {c.status === 'running' && c.lastTool && (
                      <Text size="footnote" color="suggestion">↳ fiddling with {c.lastTool}</Text>
                    )}
                    {tally && <Text size="footnote" dimColor>🧰 {tally}</Text>}
                  </Box>
                  <Box flexDirection="column" alignItems="flex-end">
                    <Button key={`tools-${c.id}`} plain onPress={() => toggle(c)}>
                      <Text dimColor>{isOpen ? 'tools ▴' : 'tools ▾'}</Text>
                    </Button>
                    {canView && (
                      <Button key={`peek-${c.id}`} plain onPress={() => transcript(c)}>
                        <Text dimColor>peek ›</Text>
                      </Button>
                    )}
                  </Box>
                </Box>
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={1}>
                    {log.length === 0 ? (
                      <Text size="footnote" dimColor>No tool calls seen yet.</Text>
                    ) : (
                      [...log].reverse().slice(0, SHOWN_LOG).map(call => {
                        const s = CALL_LOOK[call.status]
                        return (
                          <Text size="footnote">
                            <Text color={s.color}>{s.glyph}</Text>
                            <Text weight="semibold"> {call.tool}</Text>
                            {call.detail ? <Text dimColor> {call.detail}</Text> : ''}
                            <Text dimColor tabular>
                              {'  '}{call.status === 'running' ? `${elapsed((now || call.at) - call.at)}…` : call.ms !== undefined ? fmtMs(call.ms) : ''}
                            </Text>
                          </Text>
                        )
                      })
                    )}
                    {log.length > SHOWN_LOG && (
                      <Text size="footnote" dimColor>+{log.length - SHOWN_LOG} earlier</Text>
                    )}
                  </Box>
                )}
                </Box>
              )
            })}

            {done + oops > 0 && (
              <Button key="shoo" onPress={shoo}>Wave goodbye to finished critters</Button>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
