import { expect, test } from 'claude-code/testing'

import { advance, deltaOf } from './register'

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
