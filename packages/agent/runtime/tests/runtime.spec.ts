import { describe, expect, it } from 'vitest'
import {
  createDefaultToolRegistry,
  guardCanvasOperation,
  inspectPiAgentRuntime,
  runPiAgentTurn,
  runPiSubLoopTask,
} from '@zhizhi/agent-runtime'
import { mintUserId } from '@zhizhi/brand'
import type { SseEvent, TenantContext } from '@zhizhi/contracts'
import { ZhizhiError } from '@zhizhi/errors'

describe('Pi Agent core runtime integration', () => {
  it('loads @earendil-works/pi-agent-core and @earendil-works/pi-ai', () => {
    const meta = inspectPiAgentRuntime()
    expect(meta.engine).toBe('pi-agent-core')
    expect(meta.piAgentAvailable).toBe(true)
    expect(meta.piAiVersion.length).toBeGreaterThan(0)
  })

  it('filters exposed Pi Agent tools deterministically from UI switches', () => {
    const registry = createDefaultToolRegistry()

    const defaultOnly = registry.resolveActiveTools({
      skillGenCard: false,
      quizTools: { mcq: false, tf: false, blank: false, qa: false },
    })
    expect(defaultOnly.map(t => t.name)).toEqual(['kb_search', 'web_search', 'canvas_dispatch'])

    const withCardAndMcq = registry.resolveActiveTools({
      skillGenCard: true,
      quizTools: { mcq: true, tf: false, blank: false, qa: false },
    })
    expect(withCardAndMcq.map(t => t.name)).toContain('draft_wiki_card')
    expect(withCardAndMcq.map(t => t.name)).toContain('quiz_generate_mcq')
  })

  it('blocks canvas overwrites on pinned slots', () => {
    expect(() =>
      guardCanvasOperation(
        {
          op: 'mount_card',
          slotId: 'slot_a',
          cardType: 'wiki_card_viewer',
          title: 'Overwritten',
          payload: {},
        },
        new Set(['slot_a']),
      ),
    ).toThrow(ZhizhiError)
  })

  it('runs a real Pi Agent Core multi-step tool loop and routes MCQ card around pinned slots', async () => {
    const registry = createDefaultToolRegistry()
    const tenant: TenantContext = { userId: mintUserId(), role: 'user' }
    const events: SseEvent[] = []

    const result = await runPiAgentTurn({
      tenant,
      sessionId: 'ses_pi_loop',
      registry,
      modelRoute: { provider: 'zhizhi-faux', modelId: 'zhizhi-dev-mock' },
      request: {
        pageScene: 'chat_qa',
        message: '给我出一道选择题',
        switches: {
          skillGenCard: false,
          quizTools: { mcq: true, tf: false, blank: false, qa: false },
        },
        pinnedSlotIds: ['slot_a', 'slot_b'],
        contextCardIds: [],
      },
      emit(event) {
        events.push(event)
      },
    })

    expect(result.isFaux).toBe(true)
    expect(result.activeTools).toContain('quiz_generate_mcq')
    expect(events.some(e => e.type === 'tool_start' && e.toolName === 'quiz_generate_mcq')).toBe(true)
    expect(events.some(e => e.type === 'tool_end' && e.toolName === 'quiz_generate_mcq' && e.ok)).toBe(true)

    const canvasEvent = events.find(e => e.type === 'canvas_op')
    expect(canvasEvent?.type).toBe('canvas_op')
    if (canvasEvent?.type === 'canvas_op') {
      expect(canvasEvent.operation.slotId).toBe('slot_c')
      expect(canvasEvent.operation.op).toBe('mount_card')
    }
    expect(events.some(e => e.type === 'done')).toBe(true)
    expect(result.finalText.length).toBeGreaterThan(0)
  })

  it('prevents quiz tool invocation when user turns off the MCQ switch', async () => {
    const registry = createDefaultToolRegistry()
    const tenant: TenantContext = { userId: mintUserId(), role: 'user' }
    const events: SseEvent[] = []

    const result = await runPiAgentTurn({
      tenant,
      sessionId: 'ses_pi_disabled',
      registry,
      modelRoute: { provider: 'zhizhi-faux', modelId: 'zhizhi-dev-mock' },
      request: {
        pageScene: 'chat_qa',
        message: '给我出一道选择题',
        switches: {
          skillGenCard: false,
          quizTools: { mcq: false, tf: false, blank: false, qa: false },
        },
        pinnedSlotIds: [],
        contextCardIds: [],
      },
      emit(event) {
        events.push(event)
      },
    })

    expect(result.activeTools).not.toContain('quiz_generate_mcq')
    expect(events.some(e => e.type === 'tool_start' && e.toolName === 'quiz_generate_mcq')).toBe(false)
    expect(result.finalText).toContain('选择题')
  })

  it('runs stateless Pi AI sub-loop task isolated from main conversation loop', async () => {
    const res = await runPiSubLoopTask({
      systemPrompt: '你是解析子循环，将原始资料总结为干净的 Standard Markdown。',
      userPrompt: '原始提交记录：重构鉴权中间件',
      modelRoute: { provider: 'zhizhi-faux', modelId: 'zhizhi-dev-mock' },
    })
    expect(res.isFaux).toBe(true)
    expect(res.text.length).toBeGreaterThan(0)
  })
})
