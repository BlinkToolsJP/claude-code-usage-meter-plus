import { expect, test } from 'claude-code/testing'

test('帯が端末とデスクトップの両方で描ける', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-meter-plus',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as any)
    expect(await ui.find({ type: 'Text', text: /週間/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5時間/ })).toBeDefined()
    await ui.unmount()
  }
})
