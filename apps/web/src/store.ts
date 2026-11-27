import { create } from 'zustand'
import {
  applyCanvasOperation,
  toggleSlotPin,
} from '@zhizhi/client-core'
import type {
  CanvasOperation,
  CanvasSlotState,
  UiSwitchState,
} from '@zhizhi/contracts'

interface ChatMessageItem {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
}

interface WorkspaceStore {
  slots: CanvasSlotState[]
  switches: UiSwitchState
  messages: ChatMessageItem[]
  drawerOpen: boolean
  togglePin: (slotId: string) => void
  applyOp: (op: CanvasOperation) => void
  toggleSkillGenCard: () => void
  toggleQuizTool: (tool: keyof UiSwitchState['quizTools']) => void
  appendMessage: (msg: ChatMessageItem) => void
  setDrawerOpen: (open: boolean) => void
}

const INITIAL_SLOTS: CanvasSlotState[] = [
  {
    slotId: 'slot_a',
    cardType: 'wiki_card_viewer',
    refId: 'crd_demo_1',
    title: '《统一 Markdown 中间层与双循环解耦》',
    isPinned: true,
    payload: {
      summary: '所有原始来源经 AI 解析子循环清洗并过 Zod Schema 后，方进入 Agent 主循环与三出口。',
      versionNo: 1,
      questionCount: 2,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    slotId: 'slot_b',
    cardType: 'quiz_mcq_card',
    refId: 'qst_demo_1',
    title: '知返 · 入库默认选择题（情境应用预测）',
    isPinned: false,
    payload: {
      stem: '当用户通过 PDF 和 Word 两次补充同一知识点时，系统应如何更新题库？',
      options: [
        { key: 'A', text: '清空旧题重新全量出题' },
        { key: 'B', text: '比对变更 Diff 与已有题目摘要，未覆盖才增量挂靠新题' },
        { key: 'C', text: '禁止同一知识卡挂靠多道题目' },
      ],
      correctKeys: ['B'],
    },
    updatedAt: new Date().toISOString(),
  },
]

export const useWorkspaceStore = create<WorkspaceStore>(set => ({
  slots: INITIAL_SLOTS,
  switches: {
    skillGenCard: false,
    quizTools: { mcq: true, tf: false, blank: false, qa: false },
  },
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content: '你好！我是知枝主循环 Agent。当前已挂载「自主查库 + 联网兜底」，打开下方开关即可授权我生成知识卡或调用对应题型工具。',
    },
  ],
  drawerOpen: false,
  togglePin: slotId => set(state => ({ slots: toggleSlotPin(state.slots, slotId) })),
  applyOp: op => set(state => ({ slots: applyCanvasOperation(state.slots, op) })),
  toggleSkillGenCard: () =>
    set(state => ({
      switches: { ...state.switches, skillGenCard: !state.switches.skillGenCard },
    })),
  toggleQuizTool: tool =>
    set(state => ({
      switches: {
        ...state.switches,
        quizTools: {
          ...state.switches.quizTools,
          [tool]: !state.switches.quizTools[tool],
        },
      },
    })),
  appendMessage: msg => set(state => ({ messages: [...state.messages, msg] })),
  setDrawerOpen: open => set({ drawerOpen: open }),
}))
