import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ZhizhiApiClient,
  ZhizhiApiError,
  type AuthSession,
  type ClientJobItem,
  type ClientSourceItem,
  type PluginHealthItem,
} from '@zhizhi/client-core'
import type { SourceDisposition } from '@zhizhi/contracts'

const SESSION_STORAGE_KEY = 'zhizhi_web_auth_session_v1'
const SAMPLE_DOUYIN_INPUT =
  '5.89 复制打开抖音，看看【RabbittuX的作品】数万人催更的Purrge win版本来啦 # AI... https://v.douyin.com/enP6_nqH4bQ/ m@Q.kP 06/16 :0pm mDU:/'

type WorkbenchTab = 'douyin_ingest' | 'more_sources' | 'wiki_cards' | 'quiz_drill' | 'mistakes_review'

const WORKBENCH_SLOTS: ReadonlyArray<{
  readonly id: WorkbenchTab
  readonly label: string
  readonly badge: string
  readonly ready: boolean
  readonly description: string
  readonly plannedContract: string
}> = [
  {
    id: 'douyin_ingest',
    label: '来源采集测试台',
    badge: '已就绪 · 抖音',
    ready: true,
    description: '实时测试来源插槽 → ASR/字幕 → L1/L2 截帧 → LLM 子循环 → StandardMarkdown 持久化落库与图文渲染',
    plannedContract: 'POST /api/v1/sources/ingest · GET /api/v1/sources · GET /api/v1/assets',
  },
  {
    id: 'more_sources',
    label: '扩展来源插槽',
    badge: '预留槽位',
    ready: false,
    description: 'B 站视频/图文、小红书笔记、YouTube、PDF/HTML/Markdown 文档与外部 MCP 来源，共享公共 ASR 与截帧能力域',
    plannedContract: 'packages/ingest/plugin-* · SourcePluginRegistry (ADR-02)',
  },
  {
    id: 'wiki_cards',
    label: '知识卡草稿与正式入库',
    badge: '预留槽位',
    ready: false,
    description: '草稿编辑、显式「保存入库」确认、自动触发默认 2 道选择题（认知理解 + 情境应用预测）及改卡判重补题',
    plannedContract: 'ADR-03 写库保护 · wiki_cards · async_jobs',
  },
  {
    id: 'quiz_drill',
    label: '题库练习与出题工具',
    badge: '预留槽位',
    ready: false,
    description: '选择题（V1）、判断/填空/问答（V1.5）题型插件槽位，与 Pi Agent 动态 Tool 白名单联动',
    plannedContract: 'quizzes · QuizPluginRegistry',
  },
  {
    id: 'mistakes_review',
    label: '独立错题本与复盘',
    badge: '预留槽位',
    ready: false,
    description: '与入库事务解耦的独立错题流，支持错因标注、周期复习、归档与删除',
    plannedContract: 'mistakes · 独立状态流转',
  },
]

const DISPOSITION_OPTIONS: ReadonlyArray<{
  readonly value: SourceDisposition
  readonly label: string
  readonly hint: string
}> = [
  { value: 'wiki_card', label: '生成知识卡草稿', hint: '落盘 raw_sources 并返回草稿预览，用户保存前不写正式库' },
  { value: 'archive_only', label: '仅归档来源', hint: '沉淀至 raw_sources 供后续检索与引用' },
  { value: 'todo_queue', label: '加入待学清单', hint: '归档并写入待学队列' },
]

function loadStoredSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null
      && typeof parsed === 'object'
      && 'accessToken' in parsed
      && 'user' in parsed
    ) {
      return parsed as AuthSession
    }
    return null
  } catch (_err) {
    // Corrupted localStorage entry is safely ignored.
    return null
  }
}

function saveStoredSession(session: AuthSession | null): void {
  try {
    if (!session) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    }
  } catch (_err) {
    // Ignore storage quota or private-mode restrictions.
  }
}

function formatTimestamp(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return ''
  const total = Math.max(0, Math.floor(sec))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function MarkdownPreview({
  markdown,
  accessToken,
  api,
}: {
  readonly markdown: string
  readonly accessToken: string
  readonly api: ZhizhiApiClient
}): ReactElement {
  return (
    <div className="space-y-3 text-sm leading-7 text-[#1c2b25]">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          if (url.startsWith('asset://')) {
            return api.resolveAssetUrl(accessToken, url)
          }
          if (/^(https?:\/\/|mailto:|\/)/i.test(url)) {
            return url
          }
          return ''
        }}
        components={{
          h1: ({ children }) => (
            <h1 className="border-b border-[#d4dcd0] pb-2 text-lg font-extrabold text-[#14362a]">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-4 text-base font-extrabold text-[#14362a]">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 text-sm font-bold text-[#1f5e47]">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-2.5 text-sm font-bold text-[#2b4c3f]">{children}</h4>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-4 border-[#1f5e47] bg-[#f4faf6] px-3 py-1.5 text-[#2d463c]">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const isBlock = Boolean(className)
            if (isBlock) {
              return (
                <code className="block overflow-x-auto rounded-lg bg-[#16231e] p-3 font-mono text-xs text-[#e6f0ea]">
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-[#e8efe9] px-1.5 py-0.5 font-mono text-xs text-[#14362a]">
                {children}
              </code>
            )
          },
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#1f5e47] underline underline-offset-2 hover:text-[#14362a]"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[#c9d6c7] bg-[#edf4ef] px-2.5 py-1.5 text-left font-bold text-[#14362a]">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-[#d4dcd0] px-2.5 py-1.5">{children}</td>,
          img: ({ src, alt }) => {
            if (!src) return null
            return (
              <span className="my-3 block overflow-hidden rounded-lg border border-[#d4dcd0] bg-[#f7f9f6]">
                <img
                  src={src}
                  alt={alt ?? '关键帧截图'}
                  loading="lazy"
                  className="max-h-96 w-full bg-[#101815] object-contain"
                />
                {alt ? (
                  <span className="block border-t border-[#e1e8de] px-3 py-1.5 text-xs text-[#495b53]">
                    {alt}
                  </span>
                ) : null}
              </span>
            )
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  )
}

export function SourcesScenePage(): ReactElement {
  const api = useMemo(() => new ZhizhiApiClient(), [])

  const [activeTab, setActiveTab] = useState<WorkbenchTab>('douyin_ingest')
  const [session, setSession] = useState<AuthSession | null>(() => loadStoredSession())
  const [email, setEmail] = useState('dev@zhizhi.local')
  const [displayName, setDisplayName] = useState('本地测试账号')
  const [password, setPassword] = useState('zhizhi123456')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const [plugins, setPlugins] = useState<PluginHealthItem[]>([])
  const [jobs, setJobs] = useState<ClientJobItem[]>([])
  const [sources, setSources] = useState<ClientSourceItem[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState<'rendered' | 'raw' | 'json'>('rendered')

  const [shareInput, setShareInput] = useState('')
  const [titleHint, setTitleHint] = useState('')
  const [disposition, setDisposition] = useState<SourceDisposition>('wiki_card')
  const [maxKeyframes, setMaxKeyframes] = useState(4)
  const [submitting, setSubmitting] = useState(false)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [errorNotice, setErrorNotice] = useState<string | null>(null)
  const [trackingJobId, setTrackingJobId] = useState<string | null>(null)

  const refreshAll = useCallback(async (token: string): Promise<void> => {
    try {
      const [pluginList, jobList, sourceList] = await Promise.all([
        api.listPlugins(token),
        api.listJobs(token),
        api.listSources(token),
      ])
      const reversedJobs = [...jobList].reverse()
      setPlugins(pluginList)
      setJobs(reversedJobs)
      setSources(sourceList)

      // 如果正在跟踪的任务已完成且产出了 sourceId，自动切过去方便第一时间看输出
      if (trackingJobId) {
        const tracked = reversedJobs.find(j => j.id === trackingJobId)
        if (tracked?.status === 'succeeded' && tracked.result?.sourceId) {
          setSelectedSourceId(tracked.result.sourceId)
          setTrackingJobId(null)
        } else if (tracked?.status === 'failed') {
          setTrackingJobId(null)
        }
      } else {
        setSelectedSourceId((prev) => {
          if (prev && sourceList.some(s => s.id === prev)) return prev
          return sourceList[0]?.id ?? null
        })
      }
    } catch (err) {
      if (err instanceof ZhizhiApiError && err.status === 401) {
        saveStoredSession(null)
        setSession(null)
        setAuthError('登录态已过期，请重新登录。')
        return
      }
      setErrorNotice(err instanceof Error ? err.message : String(err))
    }
  }, [api, trackingJobId])

  useEffect(() => {
    if (!session) return
    void refreshAll(session.accessToken)
  }, [refreshAll, session])

  const hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!session || (!hasActiveJobs && !trackingJobId)) return
    const timer = window.setInterval(() => {
      void refreshAll(session.accessToken)
    }, 1_200)
    return () => window.clearInterval(timer)
  }, [hasActiveJobs, refreshAll, session, trackingJobId])

  async function handleQuickDevAuth(): Promise<void> {
    setAuthBusy(true)
    setAuthError(null)
    try {
      let next: AuthSession
      try {
        next = await api.login({ email: email.trim(), password })
      } catch (err) {
        if (err instanceof ZhizhiApiError && err.status === 401) {
          next = await api.register({
            email: email.trim(),
            displayName: displayName.trim() || '本地测试账号',
            password,
          })
        } else {
          throw err
        }
      }
      saveStoredSession(next)
      setSession(next)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuthBusy(false)
    }
  }

  function handleLogout(): void {
    saveStoredSession(null)
    setSession(null)
    setPlugins([])
    setJobs([])
    setSources([])
    setSelectedSourceId(null)
    setTrackingJobId(null)
  }

  async function handleIngestSubmit(runNow: boolean): Promise<void> {
    if (!session) return
    const text = shareInput.trim()
    if (!text) {
      setErrorNotice('请先粘贴抖音分享口令或视频/图文链接。')
      return
    }

    setSubmitting(true)
    setErrorNotice(null)
    setStatusNotice(null)

    const isPureUrl = /^https?:\/\/\S+$/i.test(text)
    try {
      const res = await api.ingestSource(session.accessToken, {
        sourceType: 'video_note',
        ...(isPureUrl ? { url: text } : { rawText: text }),
        ...(titleHint.trim() ? { titleHint: titleHint.trim() } : {}),
        disposition,
        maxKeyframes,
        runNow,
      })

      setTrackingJobId(res.jobId)
      if (res.job?.result?.sourceId) {
        setSelectedSourceId(res.job.result.sourceId)
      }
      const warnText = res.preflight.warningMessage ? `（提示：${res.preflight.warningMessage}）` : ''
      setStatusNotice(`已投递至插件 ${res.pluginId} · 任务 ${res.jobId}${warnText}`)
      setShareInput('')
      setTitleHint('')
      await refreshAll(session.accessToken)
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const selectedSource = sources.find(s => s.id === selectedSourceId) ?? sources[0] ?? null
  const activeSlotMeta = WORKBENCH_SLOTS.find(s => s.id === activeTab) ?? WORKBENCH_SLOTS[0]
  const selectedSourceJob = selectedSource
    ? jobs.find(j => j.result?.sourceId === selectedSource.id) ?? null
    : null

  return (
    <div className="space-y-4">
      {/* 顶部测试台栏 + 租户认证 */}
      <section className="rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[#1f5e47] px-2.5 py-0.5 text-xs font-bold text-white">
                功能测试工作台 · Test Workbench
              </span>
              <span className="rounded-full bg-[#e4f0ea] px-2.5 py-0.5 text-xs font-bold text-[#14362a]">
                PGlite + LocalFs 本地持久化
              </span>
            </div>
            <h1 className="mt-1.5 text-xl font-extrabold text-[#14362a]">知枝能力联调测试面板</h1>
            <p className="text-xs text-[#6c7c74]">
              直接跑通来源采集、ASR 字幕、L1/L2 截帧落盘与 Markdown 图文渲染；其余模块已预留功能槽位方便逐个挂载联调。
            </p>
          </div>

          {session ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-lg border border-[#b8d4c4] bg-[#e4f0ea] px-3 py-1.5 text-xs font-bold text-[#14362a]">
                租户：{session.user.displayName} · <code className="font-mono">{session.user.userId}</code>
              </span>
              <button
                type="button"
                onClick={() => void refreshAll(session.accessToken)}
                className="rounded-lg border border-[#b4c2b2] bg-white px-3 py-1.5 text-xs font-bold text-[#1f5e47] hover:bg-[#e4f0ea]"
              >
                刷新数据
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-lg border border-[#e6c6b1] bg-[#f9ece2] px-3 py-1.5 text-xs font-bold text-[#9c4f21]"
              >
                切换账号
              </button>
            </div>
          ) : null}
        </div>

        {/* 功能槽位导航（当前抖音采集已就绪，其余核心能力预留槽位） */}
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {WORKBENCH_SLOTS.map((slot) => {
            const isActive = activeTab === slot.id
            return (
              <button
                key={slot.id}
                type="button"
                onClick={() => setActiveTab(slot.id)}
                className={`rounded-lg border p-2.5 text-left transition ${
                  isActive
                    ? 'border-[#1f5e47] bg-[#e4f0ea] shadow-xs'
                    : slot.ready
                      ? 'border-[#c8d8cc] bg-white hover:bg-[#f4faf6]'
                      : 'border-dashed border-[#cfd8cc] bg-[#fafaf6] hover:bg-[#f1f4ef]'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="truncate text-xs font-extrabold text-[#14362a]">{slot.label}</span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                      slot.ready
                        ? 'bg-[#1f5e47] text-white'
                        : 'bg-[#ebe8df] text-[#6c6b60]'
                    }`}
                  >
                    {slot.badge}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-[#5b6c64]">
                  {slot.description}
                </div>
              </button>
            )
          })}
        </div>

        {!session ? (
          <div className="mt-4 rounded-lg border border-dashed border-[#b4c2b2] bg-[#f5f4ee] p-4">
            <div className="mb-2 text-sm font-bold text-[#14362a]">
              先登录或一键创建本地持久化账号（刷新页面或重启服务后记录与图片都会保留）
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="邮箱"
                className="rounded-lg border border-[#b4c2b2] bg-white px-3 py-2 text-sm outline-none focus:border-[#1f5e47]"
              />
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="昵称（首次注册用）"
                className="rounded-lg border border-[#b4c2b2] bg-white px-3 py-2 text-sm outline-none focus:border-[#1f5e47]"
              />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="密码（至少 8 位）"
                className="rounded-lg border border-[#b4c2b2] bg-white px-3 py-2 text-sm outline-none focus:border-[#1f5e47]"
              />
              <button
                type="button"
                disabled={authBusy}
                onClick={() => void handleQuickDevAuth()}
                className="rounded-lg bg-[#1f5e47] px-4 py-2 text-sm font-bold text-white hover:bg-[#14362a] disabled:opacity-60"
              >
                {authBusy ? '认证中...' : '一键登录 / 注册'}
              </button>
            </div>
            {authError ? (
              <div className="mt-2 text-xs font-semibold text-[#9f2d2d]">{authError}</div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 非来源采集槽位的占位面板 */}
      {activeTab !== 'douyin_ingest' && activeSlotMeta ? (
        <section className="rounded-xl border border-dashed border-[#b8c6b8] bg-[#fffdf9] p-6">
          <div className="inline-block rounded-full bg-[#ebe8df] px-2.5 py-0.5 text-xs font-bold text-[#5e5c52]">
            预留功能测试槽位 · {activeSlotMeta.id}
          </div>
          <h2 className="mt-2 text-lg font-extrabold text-[#14362a]">{activeSlotMeta.label}</h2>
          <p className="mt-1 text-sm text-[#495b53]">{activeSlotMeta.description}</p>
          <div className="mt-4 rounded-lg bg-[#f4f6f2] p-3 font-mono text-xs text-[#31473e]">
            预留契约挂载点：{activeSlotMeta.plannedContract}
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('douyin_ingest')}
            className="mt-4 rounded-lg bg-[#1f5e47] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#14362a]"
          >
            返回来源采集测试台
          </button>
        </section>
      ) : null}

      {/* 已就绪：来源采集测试台（左输入/队列/历史，右直接看 Markdown 图文渲染输出） */}
      {session && activeTab === 'douyin_ingest' ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          {/* 左列：插件状态 + 输入表单 + 任务队列 + 已落盘历史列表 */}
          <div className="space-y-4">
            {/* 插件插槽状态 */}
            <section className="rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-extrabold uppercase tracking-wide text-[#14362a]">
                  已挂载来源插件（{plugins.length}）
                </h2>
                <span className="text-[11px] text-[#6c7c74]">ADR-02 可拆卸</span>
              </div>
              <div className="space-y-2">
                {plugins.map(p => (
                  <div
                    key={p.pluginId}
                    className={`rounded-lg border p-2.5 ${
                      p.ok ? 'border-[#b8d4c4] bg-[#f4faf6]' : 'border-[#e4bd7d] bg-[#fff9ee]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-[#14362a]">
                        {p.displayName} <code className="ml-1 font-mono text-[11px] text-[#495b53]">({p.mode})</code>
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${
                          p.ok ? 'bg-[#1f5e47]' : 'bg-[#9c4f21]'
                        }`}
                      >
                        {p.ok ? '在线就绪' : '降级'}
                      </span>
                    </div>
                    {p.detail ? <div className="mt-1 text-[11px] text-[#495b53]">{p.detail}</div> : null}
                  </div>
                ))}
              </div>
            </section>

            {/* 采集输入表单 */}
            <section className="rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-extrabold text-[#14362a]">1. 粘贴分享口令 / 链接</h2>
                <button
                  type="button"
                  onClick={() => setShareInput(SAMPLE_DOUYIN_INPUT)}
                  className="rounded border border-[#b8d4c4] bg-[#f4faf6] px-2 py-0.5 text-[11px] font-bold text-[#1f5e47] hover:bg-[#e4f0ea]"
                >
                  填入示例口令
                </button>
              </div>

              <textarea
                rows={4}
                value={shareInput}
                onChange={e => setShareInput(e.target.value)}
                placeholder="粘贴抖音 App 分享口令、短链（v.douyin.com）或视频/图文链接..."
                className="mt-2.5 w-full rounded-lg border border-[#b4c2b2] bg-white p-2.5 text-sm outline-none focus:border-[#1f5e47]"
              />

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_110px]">
                <input
                  value={titleHint}
                  onChange={e => setTitleHint(e.target.value)}
                  placeholder="可选：自定义标题（留空自动提取）"
                  className="rounded-lg border border-[#b4c2b2] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#1f5e47]"
                />
                <label className="flex items-center justify-between rounded-lg border border-[#b4c2b2] bg-white px-2.5 py-1.5 text-xs text-[#495b53]">
                  <span>截帧数</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={maxKeyframes}
                    onChange={e => setMaxKeyframes(Math.max(1, Math.min(8, Number(e.target.value) || 4)))}
                    className="w-10 text-right font-mono font-bold text-[#14362a] outline-none"
                  />
                </label>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {DISPOSITION_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    title={opt.hint}
                    onClick={() => setDisposition(opt.value)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-bold ${
                      disposition === opt.value
                        ? 'border-[#1f5e47] bg-[#1f5e47] text-white'
                        : 'border-[#b4c2b2] bg-white text-[#495b53]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleIngestSubmit(false)}
                  className="flex-1 rounded-lg bg-[#1f5e47] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#14362a] disabled:opacity-60"
                >
                  {submitting ? '提交中...' : '异步入队解析（自动出结果）'}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleIngestSubmit(true)}
                  className="rounded-lg border border-[#b4c2b2] bg-white px-3 py-2 text-xs font-bold text-[#1f5e47] hover:bg-[#e4f0ea] disabled:opacity-60"
                >
                  同步直跑
                </button>
              </div>

              {statusNotice ? (
                <div className="mt-2.5 rounded-lg border border-[#b8d4c4] bg-[#e4f0ea] px-2.5 py-2 text-xs font-semibold text-[#14362a]">
                  {statusNotice}
                </div>
              ) : null}
              {errorNotice ? (
                <div className="mt-2.5 rounded-lg border border-[#e6b8b8] bg-[#fbeaea] px-2.5 py-2 text-xs font-semibold text-[#9f2d2d]">
                  {errorNotice}
                </div>
              ) : null}
            </section>

            {/* 实时任务队列 */}
            <section className="rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-extrabold text-[#14362a]">2. 异步任务进度（DbJobQueue）</h2>
                <span className="text-[11px] text-[#6c7c74]">
                  {hasActiveJobs ? 'Worker 处理中...' : `${jobs.length} 条`}
                </span>
              </div>
              {jobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#d4dcd0] p-3 text-xs text-[#6c7c74]">
                  暂无任务，提交链接后这里实时显示解析 → ASR → 截帧 → LLM 子循环进度。
                </div>
              ) : (
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {jobs.slice(0, 8).map(job => (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => {
                        if (job.result?.sourceId) {
                          setSelectedSourceId(job.result.sourceId)
                        }
                      }}
                      className="block w-full rounded-lg border border-[#d4dcd0] bg-[#fafaf6] p-2 text-left hover:border-[#1f5e47]"
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-mono font-bold text-[#172922]">{job.id}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 font-bold ${
                            job.status === 'succeeded'
                              ? 'bg-[#e4f0ea] text-[#14362a]'
                              : job.status === 'failed'
                                ? 'bg-[#fbeaea] text-[#9f2d2d]'
                                : 'bg-[#fff5e3] text-[#7e4400]'
                          }`}
                        >
                          {job.status} · {job.progress}%
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#e6ece2]">
                        <div
                          className="h-full bg-[#1f5e47] transition-all"
                          style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                        />
                      </div>
                      {job.errorText ? (
                        <div className="mt-1 text-[11px] text-[#9f2d2d]">{job.errorText}</div>
                      ) : null}
                      {job.result?.warnings && job.result.warnings.length > 0 ? (
                        <div className="mt-1 text-[11px] text-[#7e4400]">
                          降级：{job.result.warnings.join('；')}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* 已持久化历史来源列表 */}
            <section className="rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-extrabold text-[#14362a]">
                  3. 已持久化来源（raw_sources · {sources.length}）
                </h2>
                <span className="text-[11px] text-[#6c7c74]">点击查看渲染结果</span>
              </div>
              {sources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#d4dcd0] p-3 text-xs text-[#6c7c74]">
                  暂无持久化记录。提交一条抖音口令后将自动落盘并在此常驻保留。
                </div>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {sources.map((src) => {
                    const isSelected = selectedSource?.id === src.id
                    return (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => setSelectedSourceId(src.id)}
                        className={`w-full rounded-lg border p-2.5 text-left transition ${
                          isSelected
                            ? 'border-[#1f5e47] bg-[#e4f0ea]'
                            : 'border-[#d4dcd0] bg-[#fafaf6] hover:bg-[#f0f3ee]'
                        }`}
                      >
                        <div className="line-clamp-2 text-xs font-bold text-[#14362a]">{src.title}</div>
                        <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-[11px] text-[#5b6c64]">
                          <span>
                            {src.pluginId} · {src.frontmatterJson.assets.length} 张图
                          </span>
                          <span className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[10px]">
                            {src.disposition}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          </div>

          {/* 右列：直接查看输出（Markdown 渲染 + 内嵌图片直出 + 截图相册 + 原文/元信息切换） */}
          <section className="flex min-h-[680px] flex-col rounded-xl border border-[#d4dcd0] bg-[#fffdf9] p-4">
            {selectedSource ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-dashed border-[#d4dcd0] pb-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-[#e4f0ea] px-2 py-0.5 font-mono text-[11px] font-bold text-[#14362a]">
                        {selectedSource.pluginId}
                      </span>
                      <span className="rounded-full bg-[#fff0d6] px-2 py-0.5 text-[11px] font-bold text-[#8c4b00]">
                        {selectedSource.disposition === 'wiki_card' ? '知识卡草稿（未写正式库）' : selectedSource.disposition}
                      </span>
                      {selectedSource.frontmatterJson.parseTrace?.subLoopModel ? (
                        <span className="rounded-full bg-[#eef2f6] px-2 py-0.5 font-mono text-[11px] text-[#334e68]">
                          LLM: {selectedSource.frontmatterJson.parseTrace.subLoopModel} ·{' '}
                          {selectedSource.frontmatterJson.parseTrace.tokensUsed} tokens
                        </span>
                      ) : null}
                      <span className="rounded-full bg-[#f0f3ee] px-2 py-0.5 font-mono text-[11px] text-[#495b53]">
                        {selectedSource.frontmatterJson.assets.length} 张已落盘图片
                      </span>
                    </div>
                    <h2 className="mt-1.5 text-lg font-extrabold text-[#14362a]">{selectedSource.title}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6c7c74]">
                      <span>{selectedSource.frontmatterJson.originRef.label}</span>
                      {selectedSource.frontmatterJson.originRef.url ? (
                        <a
                          href={selectedSource.frontmatterJson.originRef.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-[#1f5e47] underline underline-offset-2"
                        >
                          查看原视频
                        </a>
                      ) : null}
                      <span className="font-mono text-[11px]">sourceId={selectedSource.id}</span>
                    </div>
                  </div>

                  {/* 视图切换：Markdown 渲染 / 原始 MD / 元数据 JSON */}
                  <div className="flex shrink-0 rounded-lg border border-[#c8d8cc] bg-[#f4f7f4] p-0.5 text-xs font-bold">
                    {(
                      [
                        { id: 'rendered', label: 'MD 渲染视图' },
                        { id: 'raw', label: 'Markdown 源码' },
                        { id: 'json', label: '元信息 JSON' },
                      ] as const
                    ).map(tab => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setPreviewMode(tab.id)}
                        className={`rounded-md px-2.5 py-1 transition ${
                          previewMode === tab.id
                            ? 'bg-[#1f5e47] text-white'
                            : 'text-[#495b53] hover:text-[#14362a]'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 若本次任务存在降级告警，顶部直接提示 */}
                {selectedSourceJob?.result?.warnings && selectedSourceJob.result.warnings.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-[#e4bd7d] bg-[#fff9ee] px-3 py-2 text-xs text-[#7e4400]">
                    降级提示：{selectedSourceJob.result.warnings.join('；')}
                  </div>
                ) : null}

                {/* 已落盘关键帧/图片画廊（直接可见，不依赖正文是否引用） */}
                {selectedSource.frontmatterJson.assets.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-[#dde6db] bg-[#f8faf7] p-3">
                    <div className="mb-2 flex items-center justify-between text-xs font-bold text-[#14362a]">
                      <span>已落盘截图 / 图片资产（LocalFs 租户隔离目录直出）</span>
                      <span className="font-mono text-[11px] font-normal text-[#6c7c74]">
                        点击可新标签打开原图
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                      {selectedSource.frontmatterJson.assets.map((asset) => {
                        const imgUrl = api.resolveAssetUrl(session.accessToken, asset.url)
                        return (
                          <a
                            key={asset.id}
                            href={imgUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="group overflow-hidden rounded-lg border border-[#d4dcd0] bg-white transition hover:border-[#1f5e47]"
                          >
                            <div className="aspect-video w-full overflow-hidden bg-[#101815]">
                              <img
                                src={imgUrl}
                                alt={asset.caption ?? asset.id}
                                loading="lazy"
                                className="h-full w-full object-cover transition group-hover:scale-105"
                              />
                            </div>
                            <div className="p-1.5">
                              <div className="line-clamp-2 text-[11px] font-semibold text-[#172922]">
                                {asset.caption ?? asset.id}
                              </div>
                              {asset.timestampSec !== undefined ? (
                                <div className="mt-0.5 font-mono text-[10px] text-[#6c7c74]">
                                  @{formatTimestamp(asset.timestampSec)} ({asset.timestampSec.toFixed(1)}s)
                                </div>
                              ) : null}
                            </div>
                          </a>
                        )
                      })}
                    </div>
                  </div>
                ) : null}

                {/* 正文输出区 */}
                <div className="mt-4 flex-1 overflow-y-auto pr-1">
                  {previewMode === 'rendered' ? (
                    <MarkdownPreview
                      markdown={selectedSource.standardMarkdown}
                      accessToken={session.accessToken}
                      api={api}
                    />
                  ) : null}

                  {previewMode === 'raw' ? (
                    <pre className="overflow-x-auto rounded-lg bg-[#16231e] p-4 font-mono text-xs leading-relaxed text-[#e6f0ea]">
                      {selectedSource.standardMarkdown}
                    </pre>
                  ) : null}

                  {previewMode === 'json' ? (
                    <pre className="overflow-x-auto rounded-lg bg-[#16231e] p-4 font-mono text-xs leading-relaxed text-[#d7efe0]">
                      {JSON.stringify(
                        {
                          sourceId: selectedSource.id,
                          userId: selectedSource.userId,
                          pluginId: selectedSource.pluginId,
                          disposition: selectedSource.disposition,
                          contentHash: selectedSource.contentHash,
                          createdAt: selectedSource.createdAt,
                          updatedAt: selectedSource.updatedAt,
                          frontmatter: selectedSource.frontmatterJson,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-[#cfd8cc] bg-[#fafaf6] p-8 text-center">
                <div className="text-sm font-bold text-[#14362a]">右侧实时展示解析结果（Markdown 图文直出）</div>
                <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#6c7c74]">
                  在左侧粘贴任意抖音分享口令或点击「填入示例口令」并提交，后台完成免 Cookie 解析、Groq Whisper 语音转写、L1 字幕定位截图与 DeepSeek 结构化整理后，会直接在这里渲染完整图文文档。
                </p>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
