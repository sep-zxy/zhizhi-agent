import {
  SseEventSchema,
  type CanvasOperation,
  type CanvasSlotState,
  type PageScene,
  type SseEvent,
  type UiSwitchState,
} from '@zhizhi/contracts'

/**
 * 零 DOM 依赖的页内受控卡片槽状态更新函数（Web 与未来 Capacitor/RN 共用）。
 * 双重防线：客户端应用 canvas_op 时同样跳过已被用户钉住的槽位。
 */
export function applyCanvasOperation(
  slots: readonly CanvasSlotState[],
  operation: CanvasOperation,
  nowIso: string = new Date().toISOString(),
): CanvasSlotState[] {
  const existing = slots.find(s => s.slotId === operation.slotId)
  if (existing?.isPinned) {
    return [...slots]
  }

  switch (operation.op) {
    case 'mount_card': {
      const next: CanvasSlotState = {
        slotId: operation.slotId,
        cardType: operation.cardType,
        ...(operation.refId !== undefined ? { refId: operation.refId } : {}),
        title: operation.title,
        isPinned: false,
        payload: operation.payload,
        updatedAt: nowIso,
      }
      if (existing) {
        return slots.map(s => (s.slotId === operation.slotId ? next : s))
      }
      return [...slots, next]
    }
    case 'update_payload': {
      if (!existing) return [...slots]
      return slots.map(s =>
        s.slotId === operation.slotId
          ? { ...s, payload: { ...s.payload, ...operation.payloadPatch }, updatedAt: nowIso }
          : s,
      )
    }
    case 'clear_slot': {
      return slots.filter(s => s.slotId !== operation.slotId)
    }
  }
}

export function toggleSlotPin(
  slots: readonly CanvasSlotState[],
  slotId: string,
): CanvasSlotState[] {
  return slots.map(s => (s.slotId === slotId ? { ...s, isPinned: !s.isPinned } : s))
}

export function collectPinnedSlotIds(slots: readonly CanvasSlotState[]): string[] {
  return slots.filter(s => s.isPinned).map(s => s.slotId)
}

/**
 * 根据 UI 开关推算客户端展示的生效工具清单（与服务端 ZhizhiToolRegistry 保持对称）。
 */
export function previewActiveToolNames(switches: UiSwitchState): string[] {
  const names = ['kb_search', 'web_search', 'canvas_dispatch']
  if (switches.skillGenCard) names.push('draft_wiki_card')
  if (switches.quizTools.mcq) names.push('quiz_generate_mcq')
  if (switches.quizTools.tf) names.push('quiz_generate_tf')
  if (switches.quizTools.blank) names.push('quiz_generate_blank')
  if (switches.quizTools.qa) names.push('quiz_generate_qa')
  return names
}

/**
 * 解析单行 SSE `data: ...` 为强校验的 SseEvent。
 */
export function parseSseDataLine(line: string): SseEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const raw = trimmed.slice(5).trim()
  if (!raw || raw === '[DONE]') return null
  const json: unknown = JSON.parse(raw)
  const parsed = SseEventSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * 预设 6 大功能独立页元数据（桌面左侧导航与移动端底部 Tab 共用）。
 */
export interface PageSceneMeta {
  readonly scene: PageScene
  readonly path: string
  readonly label: string
  readonly shortLabel: string
  readonly description: string
}

export const PAGE_SCENES: readonly PageSceneMeta[] = [
  {
    scene: 'chat_qa',
    path: '/chat',
    label: '统一问答',
    shortLabel: '问答',
    description: '日常问答与本库检索合一，受控页内卡片槽 + 技能/题型开关',
  },
  {
    scene: 'search',
    path: '/search',
    label: '全局搜索',
    shortLabel: '搜索',
    description: '中文全文与多维度组合筛选，直达卡片与原资料',
  },
  {
    scene: 'sources',
    path: '/sources',
    label: '知识来源',
    shortLabel: '来源',
    description: '插槽式插件导入（网页/视频/PDF/HTML/MD/Git 总结）与统一三出口',
  },
  {
    scene: 'wiki',
    path: '/wiki',
    label: 'LLM Wiki',
    shortLabel: 'Wiki',
    description: '知识卡、主题页、历史版本回退与强绑定 1:N 题库池',
  },
  {
    scene: 'map_radar',
    path: '/map',
    label: '地图与雷达',
    shortLabel: '地图',
    description: '知识关系图谱查漏着色，基于地图拓扑驱动知识雷达推荐',
  },
  {
    scene: 'wrong_book',
    path: '/wrong-book',
    label: '独立错题本',
    shortLabel: '错题',
    description: '与入库完全解耦的客观错题记录，支持原题/变式重练、归档与删除',
  },
]
