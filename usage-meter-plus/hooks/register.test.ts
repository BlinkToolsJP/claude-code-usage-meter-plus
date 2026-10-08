import { expect, test } from 'claude-code/testing'

import { advance, deltaOf, planBar, rateNote, yen } from './register'

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

test('バーは余りをすべて使い、入らなければ null', () => {
  const rows = [
    { label: '週間', main: true, bar: { pct: 41, color: 'green' }, cols: [[{ text: '41%' }], [{ text: '経過 56%' }], [{ text: 'リセットまで 3日10時間' }], [{ text: '今回 +1.2%' }], [{ text: '文脈 34%' }]] },
    { label: '5時間', main: false, bar: { pct: 83, color: 'yellow' }, cols: [[{ text: '83%' }], [{ text: '経過 40%' }], [{ text: 'リセットまで 3時間0分' }], [{ text: '今回 +12.5%' }], [{ text: '累計 約386円（158円/ドル）' }]] },
  ]
  // 固定分 = ラベル5 + 列(3+8+22+11+26=70) + 間隔2×6 = 87
  expect(planBar(rows, 137)).toBe(50)
  expect(planBar(rows, 90)).toBeNull()
})
