import { expect, test } from 'claude-code/testing'

import { advance, deltaOf, layoutRows, rateNote, yen } from './register'

test('セッション開始時の値を起点に増加分を出す', () => {
  let t = advance({}, [{ kind: 'five_hour', percentUsed: 40 }])
  t = advance(t, [{ kind: 'five_hour', percentUsed: 52.5 }])
  expect(deltaOf(t.five_hour)).toBe(12.5)
})

test('リセットをまたいだらリセット前の増加分を足す', () => {
  let t = advance({}, [{ kind: 'five_hour', percentUsed: 80 }])
  t = advance(t, [{ kind: 'five_hour', percentUsed: 90 }])
  t = advance(t, [{ kind: 'five_hour', percentUsed: 3 }])
  expect(deltaOf(t.five_hour)).toBe(13)
})

test('ドルを円の目安にする', () => {
  expect(yen(3.2, 150)).toBe('約480円')
  expect(yen(10, 149.6)).toBe('約1,496円')
})

test('レート注記は取得済みならレートだけ、未取得なら仮を付ける', () => {
  expect(rateNote(158.1, true)).toBe('（158円/ドル）')
  expect(rateNote(150, false)).toBe('（150円/ドル・仮）')
})

test('2段の列がそろい、左端から右端までちょうど埋まる', () => {
  const rows = [
    { label: '週間', main: true, bar: { pct: 41, color: 'green' }, cols: [[{ text: '41%' }], [{ text: '経過 56%' }], [{ text: 'リセットまで 3日10時間' }], [{ text: '今回 +1.2%' }], [{ text: '文脈 34%' }]] },
    { label: '5時間', main: false, bar: { pct: 83, color: 'yellow' }, cols: [[{ text: '83%' }], [{ text: '経過 40%' }], [{ text: 'リセットまで 3時間0分' }], [{ text: '今回 +12.5%' }], [{ text: '累計 約386円（158円/ドル）' }]] },
  ]
  const laid = layoutRows(rows, 120)!
  const text = laid.map(r => r.map(p => p.text).join(''))
  const w = (s: string) => [...s].reduce((a, ch) => a + (ch.codePointAt(0)! >= 0x2e80 && ch.codePointAt(0)! <= 0xff60 ? 2 : 1), 0)
  // 下の段（いちばん長い列を持つ段）は右端まで埋まる
  expect(w(text[1])).toBe(120)
  // 「今回」の位置が上下でそろう
  expect(w(text[0].slice(0, text[0].indexOf('今回')))).toBe(w(text[1].slice(0, text[1].indexOf('今回'))))
  expect(layoutRows(rows, 40)).toBeNull()
})
