-- =============================================================================
-- Sanctum 2.0 — Phase 1: Foundation Migration
-- =============================================================================
-- 9 tables that form the complete database substrate for Sanctum 2.0.
-- All Opus review fields (Components 27, 29, 30, 31, 32, 33) are baked into
-- the schemas here so no ALTER TABLE migrations are needed in Phase 2–5.
--
-- Run against: Sanctum Supabase project (ozezxrmaoukpqjshimys)
-- SQL Editor:  https://supabase.com/dashboard/project/ozezxrmaoukpqjshimys/sql/new
-- =============================================================================


-- pgcrypto: provides gen_random_uuid() used as the default PK on every table
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_trgm: required for fuzzy entity name matching in Phase 2 (Component 30)
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- =============================================================================
-- TABLE 1: notes
-- Source of truth for every vault note. Replaces vault-index.md.
-- Components: 1 (core) + 31 (authority_weight) + 27 (usefulness feedback)
-- =============================================================================

CREATE TABLE IF NOT EXISTS notes (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  path              TEXT          UNIQUE NOT NULL,
  title             TEXT,
  type              TEXT,           -- frontmatter: type field
  artifact_type     TEXT,           -- frontmatter: artifact_type (spec, reference, template, …)
  purpose           TEXT,
  status            TEXT,
  project           TEXT,
  tags              TEXT[],
  created_at        DATE,
  updated_at        TIMESTAMPTZ,
  word_count        INT,
  embedding_id      UUID,           -- pointer into existing embeddings pipeline

  -- Staleness & access signals
  staleness_score   FLOAT         DEFAULT 1.0,  -- 1.0 = fresh, 0.0 = very stale
  last_accessed_at  TIMESTAMPTZ,
  access_count      INT           DEFAULT 0,

  -- Component 31: Authority Weight
  -- Independent of staleness. Set by generate_vault_index based on type/artifact_type:
  --   resource + spec=0.9 | status=0.8 | resource + reference=0.85
  --   brainstorm=0.4 | digest-item=0.3 | default=0.5
  -- Retrieval rank formula: semantic_similarity * (staleness * 0.4 + authority_weight * 0.6)
  authority_weight  FLOAT         DEFAULT 0.5,

  -- Component 27: Retrieval Feedback Loop
  -- Updated by close_session: notes used in session decisions go up; notes loaded but
  -- never referenced decay toward 0. Incorporated into effective staleness scoring.
  usefulness_score  FLOAT         DEFAULT 0.5,
  last_useful_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notes_path        ON notes (path);
CREATE INDEX IF NOT EXISTS idx_notes_project     ON notes (project);
CREATE INDEX IF NOT EXISTS idx_notes_type        ON notes (type);
CREATE INDEX IF NOT EXISTS idx_notes_status      ON notes (status);
CREATE INDEX IF NOT EXISTS idx_notes_created_at  ON notes (created_at);
CREATE INDEX IF NOT EXISTS idx_notes_tags        ON notes USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_notes_staleness   ON notes (staleness_score);
CREATE INDEX IF NOT EXISTS idx_notes_authority   ON notes (authority_weight);


-- =============================================================================
-- TABLE 2: note_edges
-- The knowledge graph. Explicit named relationships between notes.
-- Components: 2 (core) + 25 (confidence routing thresholds)
-- =============================================================================

CREATE TABLE IF NOT EXISTS note_edges (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id_a           UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  note_id_b           UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  relationship_type   TEXT        NOT NULL,
  -- Valid types: relates_to | contradicts | supersedes | supports | is_part_of | references | inspired_by

  -- Component 25: Confidence routing (enforced by query layer):
  --   > 0.75  → surfaced automatically in searches and session context
  --   0.5–0.75 → stored, shown when explicitly requested
  --   < 0.5  → stored for graph/Obsidian visualisation only, not surfaced in queries
  confidence          FLOAT       NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  source              TEXT        NOT NULL CHECK (source IN ('auto', 'manual')),
  created_at          TIMESTAMPTZ DEFAULT now(),

  UNIQUE (note_id_a, note_id_b, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_note_a     ON note_edges (note_id_a);
CREATE INDEX IF NOT EXISTS idx_edges_note_b     ON note_edges (note_id_b);
CREATE INDEX IF NOT EXISTS idx_edges_confidence ON note_edges (confidence);
CREATE INDEX IF NOT EXISTS idx_edges_type       ON note_edges (relationship_type);


-- =============================================================================
-- TABLE 3: entities
-- People, companies, technologies, and concepts as first-class records.
-- Components: 3 (core) + 30 (deduplication: parent_entity_id, aliases)
-- =============================================================================

CREATE TABLE IF NOT EXISTS entities (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  entity_type         TEXT        NOT NULL,
  -- Valid types: person | company | technology | concept | project
  description         TEXT,
  first_mentioned_at  DATE,
  mention_count       INT         DEFAULT 1,
  active              BOOLEAN     DEFAULT true,

  -- Component 30: Entity Deduplication
  -- parent_entity_id: e.g. "Supabase Edge Functions" is a child of "Supabase"
  -- aliases: alternative surface forms for the same entity ["Edge Functions", "Supa"]
  -- On every insert, Extraction Agent checks pg_trgm similarity > 0.7 against existing
  -- entities of the same type before creating a new record (Phase 2 logic).
  parent_entity_id    UUID        REFERENCES entities(id),
  aliases             TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_entities_name        ON entities (name);
CREATE INDEX IF NOT EXISTS idx_entities_type        ON entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_active      ON entities (active);
CREATE INDEX IF NOT EXISTS idx_entities_parent      ON entities (parent_entity_id);
-- GIN trgm index for fuzzy name matching used by entity deduplication in Phase 2
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm   ON entities USING GIN (name gin_trgm_ops);


-- =============================================================================
-- TABLE 4: entity_mentions
-- Join table: which entities appear in which notes, with context.
-- Component 3
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_mentions (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     UUID    NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  note_id       UUID    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  context       TEXT,   -- the sentence or paragraph where the entity was mentioned
  mentioned_at  DATE
);

CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions (entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_note   ON entity_mentions (note_id);


-- =============================================================================
-- TABLE 5: decisions
-- Every decision extracted from vault notes, individually tracked with lifecycle.
-- Components: 4 (core) + 33 (provenance_type baked in from day one)
-- =============================================================================

CREATE TABLE IF NOT EXISTS decisions (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id           UUID    REFERENCES notes(id) ON DELETE SET NULL,
  decision_text     TEXT    NOT NULL,
  project           TEXT,
  decided_at        DATE    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'superseded', 'proven', 'disproven', 'abandoned')),
  superseded_by     UUID    REFERENCES decisions(id),
  superseded_at     DATE,
  superseded_reason TEXT,
  outcome_notes     TEXT,
  tags              TEXT[],

  -- Component 33: Decision Provenance
  -- Populated when a decision is superseded. Captures WHY the decision changed.
  -- Feeds the Reasoning Profile (Component 28) in Phase 5:
  --   "70% of John's architecture reversals are caused by better_alternative"
  provenance_type   TEXT
    CHECK (provenance_type IN (
      'new_information',    -- learned something that changed the calculus
      'experiment_failed',  -- tried it, didn't work
      'strategic_pivot',    -- broader direction changed
      'cost_constraint',    -- too expensive or resource-intensive
      'external_change',    -- market, technology, or dependency changed
      'better_alternative'  -- found a superior option
    ))
);

CREATE INDEX IF NOT EXISTS idx_decisions_note_id    ON decisions (note_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project    ON decisions (project);
CREATE INDEX IF NOT EXISTS idx_decisions_status     ON decisions (status);
CREATE INDEX IF NOT EXISTS idx_decisions_decided_at ON decisions (decided_at);
CREATE INDEX IF NOT EXISTS idx_decisions_tags       ON decisions USING GIN (tags);


-- =============================================================================
-- TABLE 6: conflicts
-- Detected contradictions between decisions. Flagged at save time by the
-- Contradiction Agent (Phase 2). Surfaces in session startup and daily briefing.
-- Component 6
-- =============================================================================

CREATE TABLE IF NOT EXISTS conflicts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id_a         UUID        NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  decision_id_b         UUID        NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  conflict_description  TEXT        NOT NULL,
  detected_at           TIMESTAMPTZ DEFAULT now(),
  status                TEXT        NOT NULL DEFAULT 'unresolved'
                          CHECK (status IN ('unresolved', 'acknowledged', 'resolved')),
  resolution_notes      TEXT
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status      ON conflicts (status);
CREATE INDEX IF NOT EXISTS idx_conflicts_detected_at ON conflicts (detected_at);


-- =============================================================================
-- TABLE 7: hot_context
-- Small always-current briefing layer (~10–15 rows). Loaded at every session
-- startup via load_session_context. Curated by relevance and urgency scores.
-- Components: 5 (core) + 29 (temporal decay: expires_at, urgency_score)
-- =============================================================================

CREATE TABLE IF NOT EXISTS hot_context (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type    TEXT        NOT NULL
    CHECK (context_type IN (
      'project_status',   -- current state of a project
      'recent_decision',  -- key decision from last 7 days
      'open_thread',      -- unresolved question or task
      'active_entity',    -- person/company/technology currently in active play
      'flagged_conflict'  -- unresolved contradiction awaiting resolution
    )),
  project         TEXT,
  content         TEXT        NOT NULL,
  relevance_score FLOAT       DEFAULT 1.0,
  created_at      TIMESTAMPTZ DEFAULT now(),

  -- Component 29: Hot Context Temporal Decay
  -- TTL policy enforced by load_session_context (clean before serving) and
  -- generate_daily_briefing (eviction pass):
  --   project_status   → expires_at = last project activity + 14 days
  --   recent_decision  → expires_at = created_at + 7 days (unless in open_thread)
  --   flagged_conflict → no expires_at; urgency decays: 1.0 / (1 + days_old * 0.1)
  --   open_thread      → expires_at = created_at + 14 days, then "stale threads" bucket
  --   active_entity    → expires_at = last mention + 7 days
  expires_at      TIMESTAMPTZ,

  -- urgency_score: for flagged_conflicts, computed by decay formula at query time.
  -- For all other types, mirrors relevance_score on insert.
  urgency_score   FLOAT       DEFAULT 1.0,

  source_note_id  UUID        REFERENCES notes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hot_context_type      ON hot_context (context_type);
CREATE INDEX IF NOT EXISTS idx_hot_context_project   ON hot_context (project);
CREATE INDEX IF NOT EXISTS idx_hot_context_expires   ON hot_context (expires_at);
CREATE INDEX IF NOT EXISTS idx_hot_context_relevance ON hot_context (relevance_score DESC);


-- =============================================================================
-- TABLE 8: session_log
-- Episodic memory of every working session. Structured summaries, not raw
-- transcripts. Populated by close_session MCP tool at end of every session.
-- Components: 7 (core) + 32 (abandoned_approaches JSONB baked in from day one)
-- =============================================================================

CREATE TABLE IF NOT EXISTS session_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date          DATE        NOT NULL,
  projects_touched      TEXT[],
  decisions_made        UUID[],     -- UUIDs referencing decisions.id (not FK-enforced for flexibility)
  notes_saved           UUID[],     -- UUIDs referencing notes.id (not FK-enforced for flexibility)
  open_threads          TEXT[],
  summary               TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),

  -- Component 32: Dead End Memory
  -- Captures approaches tried and abandoned during the session.
  -- Prevents re-exploring the same dead ends months later.
  -- Queried by the intent router (Phase 3) before recommending an approach:
  --   "Note: you tried this on [date] and abandoned it because [reason]."
  -- Each entry shape: {
  --   "approach": "string",
  --   "reason_failed": "string",
  --   "project": "string",
  --   "related_decision_id": "UUID or null"
  -- }
  abandoned_approaches  JSONB       DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_session_log_date     ON session_log (session_date);
CREATE INDEX IF NOT EXISTS idx_session_log_projects ON session_log USING GIN (projects_touched);


-- =============================================================================
-- TABLE 9: recurring_questions
-- Questions asked repeatedly across sessions. Deduplicated by semantic
-- similarity. Surfaced in daily briefing when ask_count >= 3.
-- Component 34
-- =============================================================================

CREATE TABLE IF NOT EXISTS recurring_questions (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  question_text       TEXT    NOT NULL,
  canonical_form      TEXT    NOT NULL,   -- deduplicated/normalised form of the question
  project             TEXT,
  first_asked_at      DATE    NOT NULL,
  last_asked_at       DATE    NOT NULL,
  ask_count           INT     DEFAULT 1,
  status              TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'resolved', 'parked')),
  resolution_notes    TEXT,
  related_decision_id UUID    REFERENCES decisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_project    ON recurring_questions (project);
CREATE INDEX IF NOT EXISTS idx_questions_status     ON recurring_questions (status);
CREATE INDEX IF NOT EXISTS idx_questions_ask_count  ON recurring_questions (ask_count DESC);
CREATE INDEX IF NOT EXISTS idx_questions_last_asked ON recurring_questions (last_asked_at);
