import { expect, test } from 'claude-code/testing'

import { advance, deltaOf, rateNote, yen } from './register'

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

test('レート注記は取得済みなら自動取得、未取得なら仮', () => {
  expect(rateNote(158.1, true)).toBe('（1ドル=158円・自動取得）')
  expect(rateNote(150, false)).toBe('（1ドル=150円・仮）')
})
