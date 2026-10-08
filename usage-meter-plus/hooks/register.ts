// Usage Meter Plus: 週間使用量と5時間使用量に加え、このセッションでの消費をプロンプトの上に表示する。
// aikworks さんの usage-meter（MIT, https://github.com/aikworks/claude-code-usage-meter）をもとに改良。
//
//   週間  ████░░░░░░░░  41%  経過 56%  リセットまで 3日10時間   文脈 34%   今回 +1.2%
//   5時間 ██████░░░░░░  83%  経過 40%  リセットまで 3時間0分   今回 +12.5%   累計 約386円（158円/ドル）
//
// 「今回」＝このセッションを開いてから使用率が何ポイント増えたか。
//   使用率はアカウント全体の値なので、同時に動かしている別セッションの分も混ざる。
//   途中でリセットをまたいだら、リセット前の増加分を足して合算する。
// 「累計 約◯円」＝このセッション全体の API 換算コスト（ドル）を円にした目安。実際の請求額ではない。
//   「今回 %」とは測り始めが違う別の数字なので、並べるが括弧ではつながない。
//   為替は1日1回 open.er-api.com から取得し、失敗したら前回の値、それもなければ 150円（「・仮」を付ける）。
// 幅が足りないときは 文脈 → 「リセットまで」を「残り」 → レート注記 → 累計 → 今回 の順に削る。

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Track, Tracks } from '../types'

const REFRESH_MS = 60_000
const FX_MAX_AGE_MS = 24 * 3600_000
const FX_URL = 'https://open.er-api.com/v6/latest/USD'
const FX_FALLBACK = 150
const WINDOW_MS: Record<string, number> = { seven_day: 7 * 24 * 3600_000, five_hour: 5 * 3600_000 }
const BAR_MAX: Record<string, number> = { seven_day: 24, five_hour: 14 }
const BAR_MIN = 6

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
type Context = { percent?: number | null; tokens?: number | null; window?: number | null }

const tracks = atom({ plugin: 'usage-meter-plus', key: 'tracks' } as const, {} as Tracks)

let limits: Limit[] = []
let context: Context | null = null
let usd: number | null = null
let fxRate = FX_FALLBACK
// 取得済み（保存済み）のレートか。false なら既定値の仮レート。
let fxFetched = false
let nowMs = 0
let started = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await loadFx($)
    await refresh($)
    if (!started) {
      started = true
      $.clock.every(REFRESH_MS, () => refresh($))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      return result
    }
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const seen = await read($, tracks)
    const avail = (e.props.bodyColumns ?? 80) - 2
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        row(Box, Text, '週間  ', 'seven_day', avail, true, seen),
        row(Box, Text, '5時間 ', 'five_hour', avail, false, seen),
      ],
    })
  })
}

async function refresh($: any) {
  try {
    const u = await $.session.usage()
    limits = u.rateLimits ?? []
    context = u.context ?? null
    usd = u.cost?.usd ?? null
    nowMs = await $.clock.now()
    if (limits.length > 0) {
      await update($, tracks, (prev: Tracks | undefined) => advance(prev ?? {}, limits))
    }
    await maybeRefetchFx($)
    $.ui.invalidate('ui.render')
  } catch {
    // 今回は更新なし。前の値のまま表示を続ける。
  }
}

// 使用率の読み取りごとに、枠ごとの増加分の記録を進める。
export function advance(prev: Tracks, read: Limit[]): Tracks {
  const next: Tracks = { ...prev }
  for (const l of read) {
    const cur = l.percentUsed
    const t: Track | undefined = next[l.kind]
    if (!t) {
      // 初めて読んだ値を起点にする。
      next[l.kind] = { from: cur, last: cur, carried: 0 }
    } else if (cur + 0.05 < t.last) {
      // 下がった＝リセットをまたいだ。リセット前の増加分を積み、0 から測り直す。
      next[l.kind] = { from: 0, last: cur, carried: t.carried + (t.last - t.from) }
    } else {
      next[l.kind] = { ...t, last: cur }
    }
  }
  return next
}

export function deltaOf(t: Track | undefined): number | null {
  if (!t) return null
  return Math.max(0, t.carried + (t.last - t.from))
}

// 為替レート：保存済みの値を読み込む。
async function loadFx($: any) {
  try {
    const saved = (await $.store.get('fx')) as { rate?: number } | undefined
    if (saved?.rate && saved.rate > 0) {
      fxRate = saved.rate
      fxFetched = true
    }
  } catch {
    // 読めなければ既定値のまま。
  }
}

// 為替レート：1日以上たっていれば取り直す。失敗したら前の値を使い続ける。
let fxFetching = false
async function maybeRefetchFx($: any) {
  if (fxFetching) return
  fxFetching = true
  try {
    const saved = (await $.store.get('fx')) as { rate?: number; fetchedAt?: number } | undefined
    if (saved?.fetchedAt && nowMs - saved.fetchedAt < FX_MAX_AGE_MS) return
    const res = await $.http.fetch(FX_URL)
    if (!res.ok) return
    const rate = Number(JSON.parse(res.text)?.rates?.JPY)
    if (!(rate > 0)) return
    fxRate = rate
    fxFetched = true
    await $.store.set('fx', { rate, fetchedAt: nowMs })
  } catch {
    // 通信できなくても表示は続ける。
  } finally {
    fxFetching = false
  }
}

export function yen(dollars: number, rate: number): string {
  const v = Math.round(dollars * rate)
  return `約${v.toLocaleString('ja-JP')}円`
}

export function rateNote(rate: number, fetched: boolean): string {
  return `（${Math.round(rate)}円/ドル${fetched ? '' : '・仮'}）`
}

// 表示幅：全角・かな・漢字は2、それ以外は1。
function width(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xff60)) ? 2 : 1
  }
  return w
}

function row(Box: any, Text: any, label: string, kind: string, avail: number, main: boolean, seen: Tracks) {
  // 円は5時間の行にだけ付ける（セッション全体で1つの値なので）。
  const yenText = !main && usd != null ? yen(usd, fxRate) : null
  const noteText = rateNote(fxRate, fxFetched)
  const limit = limits.find(l => l.kind === kind)
  if (!limit) {
    const children = [
      Text({ bold: main, children: label }),
      Text({ dimColor: true, children: '取得待ち' }),
    ]
    if (yenText) {
      children.push(Text({ dimColor: true, children: '   累計 ' }))
      children.push(Text({ children: yenText }))
      children.push(Text({ dimColor: true, children: noteText }))
    }
    return Box({ flexDirection: 'row', children })
  }
  const pct = Math.max(0, Math.min(100, limit.percentUsed))
  const color = colorFor(pct)
  const pctText = ` ${String(Math.round(pct)).padStart(3)}%`
  const elapsed = elapsedPct(limit, kind)
  const left = remaining(limit.resetsAt)
  const ctxPct = main && context && context.window
    ? Math.round(context.percent ?? ((context.tokens ?? 0) / context.window) * 100)
    : null
  const d = deltaOf(seen[kind])
  const deltaText = d != null ? `+${d.toFixed(1)}%` : null

  // 幅が足りなければ、文脈 → 「残り」表記 → レート注記 → 累計 → 今回 の順に削る。
  const variants = [
    { ctx: true, note: true, yen: true, word: 'リセットまで', delta: true },
    { ctx: false, note: true, yen: true, word: 'リセットまで', delta: true },
    { ctx: false, note: true, yen: true, word: '残り', delta: true },
    { ctx: false, note: false, yen: true, word: '残り', delta: true },
    { ctx: false, note: false, yen: false, word: '残り', delta: true },
    { ctx: false, note: false, yen: false, word: '残り', delta: false },
  ]
  let pick = variants[variants.length - 1]
  let barWidth = BAR_MIN
  for (const v of variants) {
    const tail = tailText(
      elapsed,
      v.word,
      left,
      v.ctx ? ctxPct : null,
      v.delta ? deltaText : null,
      v.yen ? yenText : null,
      v.yen && v.note ? noteText : null,
    )
    const room = avail - width(label) - width(pctText) - width(tail)
    if (room >= BAR_MIN + 2 || v === variants[variants.length - 1]) {
      pick = v
      barWidth = Math.max(BAR_MIN, Math.min(BAR_MAX[kind] ?? 14, room))
      break
    }
  }
  const filled = Math.round((pct / 100) * barWidth)
  const children = [
    Text({ bold: main, children: label }),
    Text({ color, bold: main, children: '█'.repeat(filled) }),
    Text({ dimColor: true, children: '░'.repeat(barWidth - filled) }),
    Text({ color, bold: true, children: pctText }),
  ]
  if (elapsed != null) {
    children.push(Text({ dimColor: true, children: '  経過 ' }))
    children.push(Text({ children: `${elapsed}%` }))
  }
  children.push(Text({ dimColor: true, children: `  ${pick.word} ${left}` }))
  if (pick.ctx && ctxPct != null) {
    children.push(Text({ dimColor: true, children: `   文脈 ${ctxPct}%` }))
  }
  if (pick.delta && deltaText) {
    children.push(Text({ dimColor: true, children: '   今回 ' }))
    children.push(Text({ children: deltaText }))
  }
  if (pick.yen && yenText) {
    children.push(Text({ dimColor: true, children: '   累計 ' }))
    children.push(Text({ children: yenText }))
    if (pick.note) {
      children.push(Text({ dimColor: true, children: noteText }))
    }
  }
  return Box({ flexDirection: 'row', children })
}

// バーの右側に並ぶ文字列（幅の見積り用）。
function tailText(elapsed: number | null, word: string, left: string, ctxPct: number | null, delta: string | null, yenText: string | null, noteText: string | null): string {
  return (elapsed != null ? `  経過 ${elapsed}%` : '')
    + `  ${word} ${left}`
    + (ctxPct != null ? `   文脈 ${ctxPct}%` : '')
    + (delta ? `   今回 ${delta}` : '')
    + (yenText ? `   累計 ${yenText}` : '')
    + (noteText ?? '')
}

// 前回リセット〜次回リセットのうち、いま何%進んだか。
function elapsedPct(limit: Limit, kind: string): number | null {
  const win = WINDOW_MS[kind]
  if (!win || !limit.resetsAt || !nowMs) return null
  const leftMs = Date.parse(limit.resetsAt) - nowMs
  if (Number.isNaN(leftMs)) return null
  return Math.max(0, Math.min(100, Math.round(((win - leftMs) / win) * 100)))
}

function colorFor(pct: number): string {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'yellow'
  return 'green'
}

function remaining(iso?: string): string {
  if (!iso || !nowMs) return '—'
  const ms = Date.parse(iso) - nowMs
  if (!(ms > 0)) return 'まもなく'
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d}日${h}時間`
  if (h > 0) return `${h}時間${m}分`
  return `${m}分`
}
