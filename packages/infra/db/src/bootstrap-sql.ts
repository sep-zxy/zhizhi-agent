/**
 * 基座初始化 SQL（幂等执行，PGlite 与标准 PostgreSQL 100% 通用）。
 * 后续演进迁移通过 drizzle-kit 生成增量 SQL 文件。
 */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scene TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT,
  encrypted_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scene)
);

CREATE TABLE IF NOT EXISTS user_memories (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_quiz_on_save BOOLEAN NOT NULL DEFAULT true,
  ui_switches_json JSONB NOT NULL DEFAULT '{"skillGenCard":false,"quizTools":{"mcq":true,"tf":false,"blank":false,"qa":false}}'::jsonb,
  habit_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'archive_only',
  content_hash TEXT NOT NULL,
  origin_asset_key TEXT,
  frontmatter_json JSONB NOT NULL,
  standard_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, content_hash)
);

CREATE TABLE IF NOT EXISTS wiki_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  current_version_no INTEGER NOT NULL DEFAULT 1,
  source_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  personal_note TEXT,
  mastery_level INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wiki_card_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES wiki_cards(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  change_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, version_no)
);

CREATE TABLE IF NOT EXISTS wiki_topics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_topic_id TEXT,
  title TEXT NOT NULL,
  guide_markdown TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wiki_card_topics (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES wiki_cards(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES wiki_topics(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (card_id, topic_id)
);

CREATE TABLE IF NOT EXISTS wiki_edges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_card_id TEXT NOT NULL REFERENCES wiki_cards(id) ON DELETE CASCADE,
  to_card_id TEXT NOT NULL REFERENCES wiki_cards(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wiki_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_questions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES wiki_cards(id) ON DELETE CASCADE,
  card_version_no INTEGER NOT NULL,
  source_id TEXT,
  tool_type TEXT NOT NULL,
  dimension TEXT NOT NULL,
  coverage_summary TEXT NOT NULL,
  question_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES card_questions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  card_version_no INTEGER NOT NULL,
  user_answer_json JSONB NOT NULL,
  is_correct BOOLEAN NOT NULL,
  feedback_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wrong_book (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES card_questions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  card_version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  wrong_count INTEGER NOT NULL DEFAULT 1,
  last_wrong_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_id TEXT,
  draft_card_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls_json JSONB,
  citations_json JSONB,
  is_citation_locked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS page_canvas_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_scene TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT 'default',
  slots_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, page_scene, session_id)
);

CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL,
  result_json JSONB,
  error_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_wiki_cards_user ON wiki_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_card_questions_user_card ON card_questions(user_id, card_id);
CREATE INDEX IF NOT EXISTS idx_wrong_book_user_status ON wrong_book(user_id, status);
CREATE INDEX IF NOT EXISTS idx_async_jobs_user_status ON async_jobs(user_id, status);
`
