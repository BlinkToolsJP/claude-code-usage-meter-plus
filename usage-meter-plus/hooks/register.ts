// Usage Meter Plus: 週間使用量と5時間使用量に加え、このセッションでの消費をプロンプトの上に表示する。
// aikworks さんの usage-meter（MIT, https://github.com/aikworks/claude-code-usage-meter）をもとに改良。
//
//   週間  ██████████░░░░░░  41%    経過 56%    リセットまで 3日10時間    今回 +1.2%     文脈 34%
//   5時間 █████████████░░░  83%    経過 40%    リセットまで 3時間0分     今回 +12.5%    累計 約386円（158円/ドル）
//
// 2段は表のように列をそろえ、項目の間隔は2マスで固定。余った幅はすべてバーが伸びて埋め、最後の列は右端にそろう。
//
// 「今回」＝このセッションを開いてから使用率が何ポイント増えたか。
//   使用率はアカウント全体の値なので、同時に動かしている別セッションの分も混ざる。
//   途中でリセットをまたいだら、リセット前の増加分を足して合算する。
// 「累計 約◯円」＝このセッション全体の API 換算コスト（ドル）を円にした目安。実際の請求額ではない。
//   「今回 %」とは測り始めが違う別の数字なので、並べるが括弧ではつながない。
//   為替は1日1回 open.er-api.com から取得し、失敗したら前回の値、それもなければ 150円（「・仮」を付ける）。
// 幅が足りないときは 文脈 → 「リセットまで」を「残り」 → レート注記 → 累計 → 今回 の順に、2段そろえて削る。

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Track, Tracks } from '../types'

const REFRESH_MS = 60_000
const FX_MAX_AGE_MS = 24 * 3600_000
const FX_URL = 'https://open.er-api.com/v6/latest/USD'
const FX_FALLBACK = 150
const WINDOW_MS: Record<string, number> = { seven_day: 7 * 24 * 3600_000, five_hour: 5 * 3600_000 }
const BAR_MIN = 6
// バーの文字の在庫。画面がどれだけ広くても足りる数を用意し、はみ出た分は隠す。
const BAR_STOCK = 400

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
      children: renderBand(Box, Text, avail, seen),
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

type Piece = { text: string; dim?: boolean; bold?: boolean; color?: string }
type Cell = Piece[]
// 1段分のデータ。bar が null の段は、バーの位置に「取得待ち」を出す。
type RowData = { label: string; main: boolean; bar: { pct: number; color: string } | null; cols: Cell[] }
type Variant = { ctx: boolean; word: string; note: boolean; yen: boolean; delta: boolean }

// 幅が足りなければ、文脈 → 「残り」表記 → レート注記 → 累計 → 今回 の順に削る（2段そろえて）。
const VARIANTS: Variant[] = [
  { ctx: true, word: 'リセットまで', note: true, yen: true, delta: true },
  { ctx: false, word: 'リセットまで', note: true, yen: true, delta: true },
  { ctx: false, word: '残り', note: true, yen: true, delta: true },
  { ctx: false, word: '残り', note: false, yen: true, delta: true },
  { ctx: false, word: '残り', note: false, yen: false, delta: true },
  { ctx: false, word: '残り', note: false, yen: false, delta: false },
]
const MIN_GAP = 2
const WAITING = '取得待ち'

const cellWidth = (c: Cell) => c.reduce((w, p) => w + width(p.text), 0)
const labelled = (name: string, value: string, extra: Piece[] = []): Cell =>
  [{ text: `${name} `, dim: true }, { text: value }, ...extra]

// 段ごとの列：[使用率%, 経過, リセットまで, 今回, 文脈 or 累計]。今回の列が上下でそろう。
function buildRow(label: string, kind: string, main: boolean, v: Variant, seen: Tracks): RowData {
  const limit = limits.find(l => l.kind === kind)
  const cols: Cell[] = [[], [], [], [], []]
  // 円は5時間の段にだけ付ける（セッション全体で1つの値なので）。
  if (!main && v.yen && usd != null) {
    cols[4] = labelled('累計', yen(usd, fxRate), v.note ? [{ text: rateNote(fxRate, fxFetched), dim: true }] : [])
  }
  if (!limit) {
    return { label, main, bar: null, cols }
  }
  const pct = Math.max(0, Math.min(100, limit.percentUsed))
  const color = colorFor(pct)
  cols[0] = [{ text: `${Math.round(pct)}%`, color, bold: true }]
  const elapsed = elapsedPct(limit, kind)
  if (elapsed != null) cols[1] = labelled('経過', `${elapsed}%`)
  cols[2] = [{ text: `${v.word} ${remaining(limit.resetsAt)}`, dim: true }]
  const d = deltaOf(seen[kind])
  if (v.delta && d != null) cols[3] = labelled('今回', `+${d.toFixed(1)}%`)
  if (main && v.ctx && context && context.window) {
    const ctxPct = Math.round(context.percent ?? ((context.tokens ?? 0) / context.window) * 100)
    cols[4] = labelled('文脈', `${ctxPct}%`)
  }
  return { label, main, bar: { pct, color }, cols }
}

// 2段を表のようにそろえたとき、バーに使える幅を求める。入らなければ null。
// 日本語の幅は多めに見積もるので、実際の画面では少し余裕が出る。その余りはバーが伸びて吸収する。
export function planBar(rows: RowData[], avail: number): number | null {
  const labelW = Math.max(...rows.map(r => width(r.label)))
  const nCols = rows[0].cols.length
  const colW = Array.from({ length: nCols }, (_, i) => Math.max(...rows.map(r => cellWidth(r.cols[i]))))
  const used = colW.filter(w => w > 0)
  const barMin = rows.some(r => r.bar == null) ? Math.max(BAR_MIN, width(WAITING)) : BAR_MIN
  const fixed = labelW + used.reduce((a, w) => a + w, 0) + MIN_GAP * (used.length + 1)
  const free = avail - fixed
  if (free < barMin) return null
  // 実際のバーの幅は画面の配置で決まる（renderBand）。ここでは入るかどうかの目安を返す。
  return free
}

function renderBand(Box: any, Text: any, avail: number, seen: Tracks) {
  let rows: RowData[] = []
  for (const v of VARIANTS) {
    rows = [buildRow('週間', 'seven_day', true, v, seen), buildRow('5時間', 'five_hour', false, v, seen)]
    if (planBar(rows, avail) != null) break
  }
  const cell = (pieces: Piece[], key: string) => Box({
    key,
    flexDirection: 'row',
    children: pieces.length
      ? pieces.map((p, i) => Text({ key: String(i), dimColor: p.dim, bold: p.bold, color: p.color, children: p.text }))
      : [Text({ key: '0', children: ' ' })],
  })
  // 列ごとに縦の Box を作り、上下の段を同じ列に入れる。こうすると文字幅に関係なく上下がそろう。
  const column = (cells: Piece[][], key: string, align: 'flex-start' | 'flex-end' = 'flex-start') => Box({
    key,
    flexDirection: 'column',
    flexShrink: 0,
    alignItems: align,
    children: cells.map((c, i) => cell(c, String(i))),
  })
  // バーの一部分。flexGrow の比で幅が決まり、はみ出た文字は隠す。
  const segment = (key: string, grow: number, char: string, props: object) => Box({
    key,
    width: 0,
    minWidth: 0,
    flexGrow: grow,
    height: 1,
    overflow: 'hidden',
    children: [Text({ key: '0', ...props, children: char.repeat(BAR_STOCK) })],
  })
  // バーは残りの幅をすべて使う。塗りと空きを使用率の比で分けるので、どんな幅でも比率は正確。
  const barColumn = Box({
    key: 'bar',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: BAR_MIN,
    children: rows.map((r, i) => {
      if (!r.bar) return cell([{ text: WAITING, dim: true }], String(i))
      return Box({
        key: String(i),
        flexDirection: 'row',
        width: '100%',
        children: [
          segment('on', r.bar.pct, '█', { color: r.bar.color, bold: r.main }),
          segment('off', 100 - r.bar.pct, '░', { dimColor: true }),
        ],
      })
    }),
  })
  const columns = [column(rows.map(r => [{ text: r.label, bold: r.main }]), 'label'), barColumn]
  rows[0].cols.forEach((_, i) => {
    if (rows.every(r => r.cols[i].length === 0)) return
    columns.push(column(rows.map(r => r.cols[i]), `c${i}`, i === 0 ? 'flex-end' : 'flex-start'))
  })
  // 項目の間隔は MIN_GAP で固定。余りはすべてバーが吸収するので、最後の列は右端にそろう。
  return [Box({ key: 'band', flexDirection: 'row', width: '100%', columnGap: MIN_GAP, children: columns })]
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
