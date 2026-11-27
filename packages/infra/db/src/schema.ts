import {
  pgTable,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'

/**
 * 1. 账号与多租户基座（V1 原生多人隔离，本地单机复用单账号）
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const userApiKeys = pgTable('user_api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scene: text('scene').notNull(), // main_loop | sub_loop | quiz_gen
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  baseUrl: text('base_url'),
  encryptedSecret: text('encrypted_secret').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('uq_user_api_keys_user_scene').on(t.userId, t.scene),
])

export const userMemories = pgTable('user_memories', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  autoQuizOnSave: boolean('auto_quiz_on_save').notNull().default(true),
  uiSwitchesJson: jsonb('ui_switches_json').notNull().default({
    skillGenCard: false,
    quizTools: { mcq: true, tf: false, blank: false, qa: false },
  }),
  habitProfileJson: jsonb('habit_profile_json').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * 2. 知识来源与统一 Standard Markdown 中间层
 */
export const rawSources = pgTable('raw_sources', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  sourceType: text('source_type').notNull(),
  title: text('title').notNull(),
  disposition: text('disposition').notNull().default('archive_only'),
  contentHash: text('content_hash').notNull(),
  originAssetKey: text('origin_asset_key'),
  frontmatterJson: jsonb('frontmatter_json').notNull(),
  standardMarkdown: text('standard_markdown').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_raw_sources_user').on(t.userId),
  uniqueIndex('uq_raw_sources_user_hash').on(t.userId, t.contentHash),
])

/**
 * 3. LLM Wiki 知识库（知识卡 / 历史版本 / 主题 / 关系图谱 / 变更日志）
 */
export const wikiCards = pgTable('wiki_cards', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  bodyMarkdown: text('body_markdown').notNull(),
  currentVersionNo: integer('current_version_no').notNull().default(1),
  sourceRefsJson: jsonb('source_refs_json').notNull().default([]),
  personalNote: text('personal_note'),
  masteryLevel: integer('mastery_level').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_wiki_cards_user').on(t.userId),
])

export const wikiCardVersions = pgTable('wiki_card_versions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  cardId: text('card_id').notNull().references(() => wikiCards.id, { onDelete: 'cascade' }),
  versionNo: integer('version_no').notNull(),
  title: text('title').notNull(),
  bodyMarkdown: text('body_markdown').notNull(),
  changeSummary: text('change_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('uq_card_versions_card_ver').on(t.cardId, t.versionNo),
  index('idx_card_versions_user').on(t.userId),
])

export const wikiTopics = pgTable('wiki_topics', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  parentTopicId: text('parent_topic_id'),
  title: text('title').notNull(),
  guideMarkdown: text('guide_markdown').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_wiki_topics_user').on(t.userId),
])

export const wikiCardTopics = pgTable('wiki_card_topics', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  cardId: text('card_id').notNull().references(() => wikiCards.id, { onDelete: 'cascade' }),
  topicId: text('topic_id').notNull().references(() => wikiTopics.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [
  uniqueIndex('uq_card_topic').on(t.cardId, t.topicId),
  index('idx_card_topics_user').on(t.userId),
])

export const wikiEdges = pgTable('wiki_edges', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fromCardId: text('from_card_id').notNull().references(() => wikiCards.id, { onDelete: 'cascade' }),
  toCardId: text('to_card_id').notNull().references(() => wikiCards.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull(), // prerequisite | contrast | supplement
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_wiki_edges_user').on(t.userId),
])

export const wikiLogs = pgTable('wiki_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_wiki_logs_user').on(t.userId),
])

/**
 * 4. 知返：强绑定知识卡的 1:N 独立题库 + 练题流水 + 解耦独立错题表 + 待学清单
 */
export const cardQuestions = pgTable('card_questions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  cardId: text('card_id').notNull().references(() => wikiCards.id, { onDelete: 'cascade' }),
  cardVersionNo: integer('card_version_no').notNull(),
  sourceId: text('source_id'),
  toolType: text('tool_type').notNull(), // mcq | tf | blank | qa | code_predict
  dimension: text('dimension').notNull(), // understanding | scenario_prediction
  coverageSummary: text('coverage_summary').notNull(),
  questionJson: jsonb('question_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_card_questions_user_card').on(t.userId, t.cardId),
])

export const quizAttempts = pgTable('quiz_attempts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  questionId: text('question_id').notNull().references(() => cardQuestions.id, { onDelete: 'cascade' }),
  cardId: text('card_id').notNull(),
  cardVersionNo: integer('card_version_no').notNull(),
  userAnswerJson: jsonb('user_answer_json').notNull(),
  isCorrect: boolean('is_correct').notNull(),
  feedbackText: text('feedback_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_quiz_attempts_user').on(t.userId),
])

export const wrongBook = pgTable('wrong_book', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  questionId: text('question_id').notNull().references(() => cardQuestions.id, { onDelete: 'cascade' }),
  cardId: text('card_id').notNull(),
  cardVersionNo: integer('card_version_no').notNull(),
  status: text('status').notNull().default('active'), // active | archived | deleted
  wrongCount: integer('wrong_count').notNull().default(1),
  lastWrongAt: timestamp('last_wrong_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [
  uniqueIndex('uq_wrong_book_user_question').on(t.userId, t.questionId),
  index('idx_wrong_book_user_status').on(t.userId, t.status),
])

export const todoItems = pgTable('todo_items', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sourceId: text('source_id'),
  draftCardId: text('draft_card_id'),
  status: text('status').notNull().default('pending'), // pending | learning | promoted
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_todo_items_user').on(t.userId),
])

/**
 * 5. 统一对话、按情境页画布快照与异步任务队列
 */
export const chatSessions = pgTable('chat_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('新对话'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_chat_sessions_user').on(t.userId),
])

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant | tool
  content: text('content').notNull(),
  toolCallsJson: jsonb('tool_calls_json'),
  citationsJson: jsonb('citations_json'),
  isCitationLocked: boolean('is_citation_locked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_chat_messages_user_session').on(t.userId, t.sessionId),
])

export const pageCanvasStates = pgTable('page_canvas_states', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageScene: text('page_scene').notNull(), // chat_qa | search | sources | wiki | map_radar | wrong_book
  sessionId: text('session_id').notNull().default('default'),
  slotsJson: jsonb('slots_json').notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('uq_page_canvas_user_scene_session').on(t.userId, t.pageScene, t.sessionId),
])

export const asyncJobs = pgTable('async_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobType: text('job_type').notNull(), // ingest_sub_loop | card_auto_quiz | card_diff_quiz
  dedupeKey: text('dedupe_key'),
  status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | cancelled
  progress: integer('progress').notNull().default(0),
  payloadJson: jsonb('payload_json').notNull(),
  resultJson: jsonb('result_json'),
  errorText: text('error_text'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('idx_async_jobs_user_status').on(t.userId, t.status),
  uniqueIndex('uq_async_jobs_user_dedupe').on(t.userId, t.dedupeKey),
])
