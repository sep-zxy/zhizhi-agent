import { useState, type ReactElement } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router'
import {
  PAGE_SCENES,
  collectPinnedSlotIds,
  previewActiveToolNames,
  type PageSceneMeta,
} from '@zhizhi/client-core'
import { useWorkspaceStore } from './store.ts'
import { SourcesScenePage } from './SourcesPage.tsx'

function ChatScenePage(): ReactElement {
  const {
    slots,
    switches,
    messages,
    drawerOpen,
    togglePin,
    toggleSkillGenCard,
    toggleQuizTool,
    appendMessage,
    setDrawerOpen,
  } = useWorkspaceStore()

  const [draft, setDraft] = useState('')
  const activeTools = previewActiveToolNames(switches)
  const pinnedIds = collectPinnedSlotIds(slots)

  function handleSend(): void {
    const text = draft.trim()
    if (!text) return
    appendMessage({ id: `u_${Date.now()}`, role: 'user', content: text })
    appendMessage({
      id: `a_${Date.now() + 1}`,
      role: 'assistant',
      content: `（基座本地回显）已收到：“${text}”。本次下发 Tool 白名单：[${activeTools.join(', ')}]，已保护钉住槽位：[${pinnedIds.join(', ') || '无'}]。`,
    })
    setDraft('')
  }

  return (
    <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.95fr)]">
      {/* 页内受控卡片槽（桌面常驻左栏，移动端点击按钮滑出抽屉） */}
      <section
        className={`${drawerOpen ? 'block' : 'hidden'} rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-3.5 lg:block`}
      >
        <div className="mb-3 flex items-center justify-between border-b border-dashed border-[#d4dcd0] pb-2">
          <div>
            <h2 className="text-sm font-bold text-[#14362a]">问答页内受控卡片槽（有限调整）</h2>
            <p className="text-xs text-[#6c7c74]">仅允许投放预设白名单卡片；右上角钉住防对话覆写</p>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="rounded-md border border-[#b4c2b2] px-2 py-1 text-xs font-semibold text-[#1f5e47] lg:hidden"
          >
            收起卡片
          </button>
        </div>

        <div className="space-y-3">
          {slots.map(slot => (
            <article
              key={slot.slotId}
              className={`rounded-lg border p-3 ${
                slot.isPinned
                  ? 'border-[#c57611] bg-[#fffcf5]'
                  : 'border-[#d4dcd0] bg-[#fafaf6]'
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="text-xs font-bold text-[#172922]">
                  {slot.title}
                  <span className="ml-2 rounded bg-[#e4f0ea] px-1.5 py-0.5 font-mono text-[11px] text-[#14362a]">
                    {slot.cardType}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => togglePin(slot.slotId)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                    slot.isPinned
                      ? 'border-[#c57611] bg-[#fff0d6] text-[#8c4b00]'
                      : 'border-[#b4c2b2] bg-white text-[#495b53]'
                  }`}
                >
                  {slot.isPinned ? '已钉住' : '钉住'}
                </button>
              </div>
              <pre className="overflow-x-auto rounded bg-[#f0f3ee] p-2 text-xs text-[#495b53]">
                {JSON.stringify(slot.payload, null, 2)}
              </pre>
            </article>
          ))}
        </div>
      </section>

      {/* 统一 AI 对话流 + 技能/题型开关 */}
      <section className="flex min-h-[460px] flex-col rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-3.5">
        <div className="mb-3 flex items-center justify-between border-b border-dashed border-[#d4dcd0] pb-2">
          <div>
            <h2 className="text-sm font-bold text-[#14362a]">统一 AI 对话流</h2>
            <p className="text-xs text-[#6c7c74]">优先自主查知识库，未命中触发联网兜底</p>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(!drawerOpen)}
            className="rounded-md bg-[#e4f0ea] px-2.5 py-1 text-xs font-bold text-[#1f5e47] lg:hidden"
          >
            画布卡片 ({slots.length})
          </button>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto pr-1">
          {messages.map(m => (
            <div
              key={m.id}
              className={`rounded-lg px-3 py-2 text-sm ${
                m.role === 'user'
                  ? 'ml-8 bg-[#e4f0ea] text-[#14362a]'
                  : 'mr-6 bg-[#f0f3ee] text-[#172922]'
              }`}
            >
              {m.content}
            </div>
          ))}
        </div>

        {/* 显式技能与题型工具开关 */}
        <div className="mt-3 border-t border-dashed border-[#d4dcd0] pt-2.5">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={toggleSkillGenCard}
              className={`rounded-full border px-2.5 py-1 text-xs font-bold ${
                switches.skillGenCard
                  ? 'border-[#1f5e47] bg-[#1f5e47] text-white'
                  : 'border-[#b4c2b2] bg-white text-[#495b53]'
              }`}
            >
              生成知识卡：{switches.skillGenCard ? '开' : '关'}
            </button>
            {(['mcq', 'tf', 'blank', 'qa'] as const).map((key) => {
              const labels = { mcq: '选择题', tf: '判断题(V1.5)', blank: '填空题(V1.5)', qa: '问答题(V1.5)' }
              const enabled = switches.quizTools[key]
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleQuizTool(key)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-bold ${
                    enabled
                      ? 'border-[#1f5e47] bg-[#1f5e47] text-white'
                      : 'border-[#b4c2b2] bg-white text-[#495b53]'
                  }`}
                >
                  {labels[key]}：{enabled ? '开' : '关'}
                </button>
              )
            })}
          </div>

          <div className="mb-2 rounded bg-[#16231e] px-2.5 py-1.5 font-mono text-[11px] text-[#bfe0ca]">
            Active Tools: {JSON.stringify(activeTools)}
          </div>

          <div className="flex gap-2">
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend()
              }}
              placeholder="输入问题，或输入“给我出一道选择题”..."
              className="flex-1 rounded-lg border border-[#b4c2b2] bg-white px-3 py-2 text-sm outline-none focus:border-[#1f5e47]"
            />
            <button
              type="button"
              onClick={handleSend}
              className="rounded-lg bg-[#1f5e47] px-4 py-2 text-sm font-bold text-white hover:bg-[#14362a]"
            >
              发送
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function PresetScenePlaceholder({ meta }: { readonly meta: PageSceneMeta }): ReactElement {
  return (
    <section className="rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-5">
      <div className="mb-2 inline-block rounded-full bg-[#e4f0ea] px-2.5 py-0.5 text-xs font-bold text-[#1f5e47]">
        预设情境独立页 · {meta.scene}
      </div>
      <h2 className="text-xl font-extrabold text-[#14362a]">{meta.label}</h2>
      <p className="mt-1.5 text-sm text-[#495b53]">{meta.description}</p>
      <div className="mt-4 rounded-lg border border-dashed border-[#b4c2b2] bg-[#f5f4ee] p-4 text-xs text-[#6c7c74]">
        该预设情境页骨架已就绪，对应业务线（A/B/C/D）按 <code>docs/architecture.md</code> 契约直接挂载领域组件即可并行开发。
      </div>
    </section>
  )
}

export function App(): ReactElement {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* 桌面端固定左侧导航 */}
      <aside className="hidden w-56 shrink-0 border-r border-[#d4dcd0] bg-[#fffdf9] p-4 lg:flex lg:flex-col">
        <div className="mb-5">
          <div className="text-lg font-extrabold text-[#14362a]">知枝 Web</div>
          <div className="text-xs text-[#6c7c74]">多人原生 · Pi Agent 基座</div>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {PAGE_SCENES.map(item => (
            <NavLink
              key={item.scene}
              to={item.path}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-[#e4f0ea] text-[#14362a]'
                    : 'text-[#495b53] hover:bg-[#f0f3ee]'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[#d4dcd0] pt-3 text-[11px] text-[#6c7c74]">
          6 个预设情境独立页 · PWA 就绪
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 p-3 pb-20 lg:p-5 lg:pb-5">
        <Routes>
          <Route path="/chat" element={<ChatScenePage />} />
          <Route path="/sources" element={<SourcesScenePage />} />
          {PAGE_SCENES.filter(s => s.scene !== 'chat_qa' && s.scene !== 'sources').map(meta => (
            <Route key={meta.scene} path={meta.path} element={<PresetScenePlaceholder meta={meta} />} />
          ))}
          <Route path="*" element={<Navigate to="/sources" replace />} />
        </Routes>
      </main>

      {/* 移动端固定底部导航栏（原生契合多页架构与后续 Capacitor 打包） */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-[#d4dcd0] bg-[#fffdf9]/95 px-1 py-1.5 backdrop-blur lg:hidden">
        {PAGE_SCENES.map(item => (
          <NavLink
            key={item.scene}
            to={item.path}
            className={({ isActive }) =>
              `flex flex-col items-center rounded-md py-1 text-[11px] font-bold ${
                isActive ? 'bg-[#e4f0ea] text-[#14362a]' : 'text-[#6c7c74]'
              }`
            }
          >
            <span>{item.shortLabel}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
