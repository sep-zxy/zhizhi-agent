import { describe, expect, it } from 'vitest'
import {
  applyCanvasOperation,
  collectPinnedSlotIds,
  parseSseDataLine,
  toggleSlotPin,
} from '@zhizhi/client-core'
import type { CanvasSlotState } from '@zhizhi/contracts'

describe('client-core zero-DOM state helpers', () => {
  const baseSlot: CanvasSlotState = {
    slotId: 'slot_a',
    cardType: 'wiki_card_viewer',
    title: 'Original',
    isPinned: false,
    payload: { v: 1 },
    updatedAt: '2026-11-27T00:00:00.000Z',
  }

  it('protects pinned slots from mount_card and clear_slot', () => {
    const pinned = toggleSlotPin([baseSlot], 'slot_a')
    expect(collectPinnedSlotIds(pinned)).toEqual(['slot_a'])

    const afterMount = applyCanvasOperation(pinned, {
      op: 'mount_card',
      slotId: 'slot_a',
      cardType: 'quiz_mcq_card',
      title: 'Attempted overwrite',
      payload: {},
    })
    expect(afterMount[0]?.title).toBe('Original')

    const afterClear = applyCanvasOperation(pinned, { op: 'clear_slot', slotId: 'slot_a' })
    expect(afterClear).toHaveLength(1)
  })

  it('parses valid SSE data lines and ignores malformed payloads', () => {
    const ev = parseSseDataLine('data: {"type":"text_delta","delta":"hello"}')
    expect(ev).toEqual({ type: 'text_delta', delta: 'hello' })
    expect(parseSseDataLine('data: [DONE]')).toBeNull()
  })
})
