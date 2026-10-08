// このセッションでの増加分を測るための記録（枠ごと）
export type Track = {
  // 測り始めの使用率（リセット後は 0）
  from: number
  // 最後に読んだ使用率
  last: number
  // リセット前までに積み上がった増加分
  carried: number
}

export type Tracks = Record<string, Track>

declare module 'claude-code' {
  interface PluginState {
    'usage-meter-plus': { tracks: Tracks }
  }
}
