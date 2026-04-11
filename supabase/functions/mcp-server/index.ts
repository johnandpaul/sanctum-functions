import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'
import { Hono } from 'npm:hono@^4.9.7'
import { z } from 'npm:zod@^4.3.6'
import { createClient } from 'npm:@supabase/supabase-js@2'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPADATA_API_KEY = Deno.env.get("GET_YOUTUBE_TRANSCRIPTS")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const GITHUB_REPO = "johnandpaul/vault";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function readNoteFromGitHub(path: string): Promise<string | null> {
  const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${encodedPath}`, {
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3.raw",
      "User-Agent": "sanctum-mcp-server"
    }
  });
  if (!res.ok) return null;
  return await res.text();
}

async function listFolderFromGitHub(folderPath: string): Promise<string[] | null> {
  const encodedPath = folderPath.split('/').map(s => encodeURIComponent(s)).join('/');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${encodedPath}`, {
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "sanctum-mcp-server"
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.map((entry: { name: string }) => entry.name);
}

function encodedVaultPath(path: string): string {
  return path.split('/').map((s: string) => s ? encodeURIComponent(s) : s).join('/');
}

// ─── Query Intent Router helpers (Component 20) ─────────────────────────────

async function callHaiku(prompt: string, maxTokens = 512): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Haiku API ${res.status}`)
  const data = await res.json()
  return data.content[0].text
}

async function callSonnet(prompt: string, maxTokens = 2048): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Sonnet API ${res.status}`)
  const data = await res.json()
  return data.content[0].text
}

type QueryType =
  | 'factual_recall'
  | 'decision_history'
  | 'current_status'
  | 'entity_lookup'
  | 'exploratory_synthesis'
  | 'cross_project'
  | 'approach_recommendation'

interface QueryClassification {
  query_type: QueryType
  topic: string
  project: string | null
  confidence: number
  classifier_error?: string
}

async function classifyQueryIntent(query: string): Promise<QueryClassification> {
  const prompt = `You are a query intent classifier for John's knowledge vault.

Classify the query into exactly ONE of these types:

- factual_recall: find specific notes or facts. "what did I save about X", "find notes on Y"
- decision_history: history of decisions on a topic. "what did I decide about X", "how has my thinking on Y evolved"
- current_status: current state of something. "what's the status of project X", "what's active right now"
- entity_lookup: info about a person, company, technology, or concept. "who is X", "tell me about technology Y"
- exploratory_synthesis: narrative across many notes. "tell me everything about X", "synthesize my thinking on Y"
- cross_project: connections across multiple projects. "what do Sono and Sigyls have in common"
- approach_recommendation: advice on how to proceed. "how should I approach X", "what should I try for Y"

Also extract:
- topic: the main subject (2-5 words, lowercase)
- project: if a specific project is named (sigyls, sono, sanctum, dtf, turnkey, iconic-roofing), else null

Return ONLY valid JSON, no prose, no code fences:
{"query_type":"...","topic":"...","project":null_or_string,"confidence":0.0}

Query: ${JSON.stringify(query)}`

  try {
    const raw = await callHaiku(prompt, 256)
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)
    const validTypes: QueryType[] = [
      'factual_recall', 'decision_history', 'current_status', 'entity_lookup',
      'exploratory_synthesis', 'cross_project', 'approach_recommendation'
    ]
    if (!validTypes.includes(parsed.query_type)) {
      return {
        query_type: 'factual_recall',
        topic: query,
        project: null,
        confidence: 0.3,
        classifier_error: `invalid query_type: ${parsed.query_type}`,
      }
    }
    return {
      query_type: parsed.query_type,
      topic: (parsed.topic ?? query).toString(),
      project: parsed.project ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    }
  } catch (err) {
    return {
      query_type: 'factual_recall',
      topic: query,
      project: null,
      confidence: 0.3,
      classifier_error: `classifier failure: ${(err as Error).message}`,
    }
  }
}

async function internalSemanticSearch(
  query: string,
  limit = 5,
  project: string | null = null
): Promise<Array<{
  path: string
  similarity: number
  content: string
  staleness: number
  authority: number
  retrieval_rank: number
}>> {
  // Over-fetch so re-ranking has room to promote high-authority/fresh results
  const overfetch = Math.max(limit * 4, 20)
  const res = await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/semantic-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: overfetch, project }),
  })
  if (!res.ok) return []
  const data = await res.json()
  const raw = (data.results ?? []) as Array<{ path: string; similarity: number; content: string }>
  if (raw.length === 0) return []

  const paths = raw.map(r => r.path)
  const { data: noteRows } = await supabase
    .from('notes')
    .select('path, staleness_score, authority_weight')
    .in('path', paths)

  const metaByPath = new Map<string, { staleness: number; authority: number }>()
  for (const n of (noteRows ?? []) as Array<{ path: string; staleness_score: number | null; authority_weight: number | null }>) {
    metaByPath.set(n.path, {
      staleness: n.staleness_score ?? 1.0,
      authority: n.authority_weight ?? 0.5,
    })
  }

  const reranked = raw.map(r => {
    // Notes missing from the notes table (pre-backfill) get neutral defaults
    const meta = metaByPath.get(r.path) ?? { staleness: 1.0, authority: 0.5 }
    const retrieval_rank = r.similarity * (meta.staleness * 0.4 + meta.authority * 0.6)
    return {
      path: r.path,
      similarity: r.similarity,
      content: r.content,
      staleness: meta.staleness,
      authority: meta.authority,
      retrieval_rank,
    }
  })
  reranked.sort((a, b) => b.retrieval_rank - a.retrieval_rank)
  return reranked.slice(0, limit)
}

// ─── Decision history (Component 13) ─────────────────────────────────────

interface DecisionRow {
  id: string
  note_id: string | null
  decision_text: string
  project: string | null
  decided_at: string
  status: 'active' | 'superseded' | 'proven' | 'disproven' | 'abandoned'
  superseded_by: string | null
  superseded_at: string | null
  superseded_reason: string | null
  outcome_notes: string | null
  tags: string[] | null
  provenance_type: string | null
}

interface DecisionChain {
  decisions: DecisionRow[]
  tip: DecisionRow
  projects: string[]
  matched_ids: Set<string>
}

interface DecisionHistoryResult {
  topic: string
  project: string | null
  chains: DecisionChain[]
  total_matched: number
}

const DECISION_COLUMNS =
  'id, note_id, decision_text, project, decided_at, status, superseded_by, superseded_at, superseded_reason, outcome_notes, tags, provenance_type'

async function internalGetDecisionHistory(
  topic: string,
  project: string | null = null,
  limit = 5,
): Promise<DecisionHistoryResult> {
  // ─── 1. Match phase: ILIKE on decision_text + tag overlap ──────────────
  const tagTokens = topic.toLowerCase().split(/\s+/).filter(Boolean)

  let byTextQ = supabase
    .from('decisions')
    .select(DECISION_COLUMNS)
    .ilike('decision_text', `%${topic}%`)
    .limit(20)
  if (project) byTextQ = byTextQ.eq('project', project)

  let byTagQ = supabase
    .from('decisions')
    .select(DECISION_COLUMNS)
    .overlaps('tags', tagTokens)
    .limit(20)
  if (project) byTagQ = byTagQ.eq('project', project)

  const [byTextRes, byTagRes] = await Promise.all([byTextQ, byTagQ])

  const allDecisions = new Map<string, DecisionRow>()
  for (const row of (byTextRes.data ?? []) as DecisionRow[]) allDecisions.set(row.id, row)
  for (const row of (byTagRes.data ?? []) as DecisionRow[]) allDecisions.set(row.id, row)

  if (allDecisions.size === 0) {
    return { topic, project, chains: [], total_matched: 0 }
  }

  const matchedIds = new Set(allDecisions.keys())

  // ─── 2. Walk phase: BFS outward via superseded_by, bounded depth=5 ─────
  let frontierIds = new Set(allDecisions.keys())
  for (let depth = 0; depth < 5 && frontierIds.size > 0; depth++) {
    const frontierList = [...frontierIds]

    // Forward successors: follow superseded_by pointers we haven't loaded yet
    const successorIds = frontierList
      .map(id => allDecisions.get(id)?.superseded_by)
      .filter((x): x is string => !!x && !allDecisions.has(x))

    const queries: Array<Promise<{ data: DecisionRow[] | null }>> = []
    if (successorIds.length > 0) {
      queries.push(
        supabase.from('decisions').select(DECISION_COLUMNS).in('id', successorIds) as any
      )
    }
    // Backward predecessors: rows whose superseded_by IN frontier
    queries.push(
      supabase.from('decisions').select(DECISION_COLUMNS).in('superseded_by', frontierList) as any
    )

    const results = await Promise.all(queries)
    const newIds = new Set<string>()
    for (const res of results) {
      for (const row of (res.data ?? [])) {
        if (!allDecisions.has(row.id)) {
          allDecisions.set(row.id, row)
          newIds.add(row.id)
        }
      }
    }
    frontierIds = newIds
  }

  // ─── 3. Group into chains via union-find on superseded_by edges ────────
  const parent = new Map<string, string>()
  const findRoot = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!
    return x
  }
  for (const id of allDecisions.keys()) parent.set(id, id)
  for (const [id, d] of allDecisions) {
    if (d.superseded_by && allDecisions.has(d.superseded_by)) {
      const ra = findRoot(id)
      const rb = findRoot(d.superseded_by)
      if (ra !== rb) parent.set(ra, rb)
    }
  }

  const chainByRoot = new Map<string, DecisionRow[]>()
  for (const [id, d] of allDecisions) {
    const root = findRoot(id)
    const list = chainByRoot.get(root) ?? []
    list.push(d)
    chainByRoot.set(root, list)
  }

  // ─── 4. Sort each chain by decided_at ASC, identify tip + metadata ─────
  const chains: DecisionChain[] = []
  for (const decisions of chainByRoot.values()) {
    decisions.sort((a, b) => a.decided_at.localeCompare(b.decided_at))
    const tip = decisions[decisions.length - 1]
    const projects = [...new Set(decisions.map(d => d.project).filter((p): p is string => !!p))]
    const chain_matched = new Set(decisions.filter(d => matchedIds.has(d.id)).map(d => d.id))
    chains.push({ decisions, tip, projects, matched_ids: chain_matched })
  }

  // ─── 5. Sort chains by tip decided_at DESC, cap at limit ───────────────
  chains.sort((a, b) => b.tip.decided_at.localeCompare(a.tip.decided_at))
  return {
    topic,
    project,
    chains: chains.slice(0, limit),
    total_matched: matchedIds.size,
  }
}

function formatDecisionHistory(result: DecisionHistoryResult): string {
  const { topic, project, chains, total_matched } = result

  if (chains.length === 0) {
    return `# Decision history — "${topic}"\n\nNo decisions found${project ? ` for project ${project}` : ''}.`
  }

  const truncate = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1) + '…'

  const header =
    `# Decision history — "${topic}"\n` +
    (project ? `Project: ${project} | ` : '') +
    `${chains.length} chain${chains.length > 1 ? 's' : ''} · ${total_matched} matched decision${total_matched > 1 ? 's' : ''}`

  const chainBlocks = chains.map((chain, i) => {
    const tipLabel = chain.tip.status === 'active' ? 'current' : chain.tip.status
    const projectLabel =
      chain.projects.length === 1 ? chain.projects[0] :
      chain.projects.length > 1 ? `multi (${chain.projects.join(', ')})` :
      '(no project)'
    const n = chain.decisions.length
    const chainHeader = `## Chain ${i + 1} — ${projectLabel} (${n} decision${n > 1 ? 's' : ''}, ${tipLabel}: ${truncate(chain.tip.decision_text, 60)})`

    const lines = chain.decisions.map((d, j) => {
      const isTip = j === chain.decisions.length - 1
      const matchMarker = chain.matched_ids.has(d.id) ? ' ★' : ''
      const currentMarker = isTip && d.status === 'active' ? '  ← CURRENT' : ''
      const headLine = `${j + 1}. [${d.decided_at} | ${d.status}]${matchMarker} ${d.decision_text}${currentMarker}`

      const extras: string[] = []
      if (d.superseded_by && d.superseded_at) {
        const prov = d.provenance_type ? ` · ${d.provenance_type}` : ''
        const reason = d.superseded_reason ? ` — "${d.superseded_reason}"` : ''
        extras.push(`   ↓ ${d.superseded_at}${prov}${reason}`)
      }
      if (d.outcome_notes && (d.status === 'proven' || d.status === 'disproven' || d.status === 'abandoned')) {
        extras.push(`   outcome: ${d.outcome_notes}`)
      }

      return [headLine, ...extras].join('\n')
    }).join('\n\n')

    return `${chainHeader}\n\n${lines}`
  }).join('\n\n')

  return `${header}\n\n${chainBlocks}`
}

// ─── Conflicts (Component 15) ────────────────────────────────────────────

interface ConflictRow {
  id: string
  decision_id_a: string
  decision_id_b: string
  conflict_description: string
  detected_at: string
  status: 'unresolved' | 'acknowledged' | 'resolved'
  resolution_notes: string | null
}

interface EnrichedConflict extends ConflictRow {
  decision_a: DecisionRow | null
  decision_b: DecisionRow | null
  obsolete_because: string | null
}

interface ConflictsResult {
  status_filter: 'unresolved' | 'acknowledged' | 'resolved' | 'all'
  project_filter: string | null
  total: number
  conflicts: EnrichedConflict[]
}

const CONFLICT_COLUMNS =
  'id, decision_id_a, decision_id_b, conflict_description, detected_at, status, resolution_notes'

async function internalGetConflicts(
  statusFilter: 'unresolved' | 'acknowledged' | 'resolved' | 'all' = 'unresolved',
  project: string | null = null,
  limit = 10,
): Promise<ConflictsResult> {
  const fetchLimit = project ? limit * 3 : limit

  let q = supabase
    .from('conflicts')
    .select(CONFLICT_COLUMNS)
    .order('detected_at', { ascending: false })
    .limit(fetchLimit)
  if (statusFilter !== 'all') q = q.eq('status', statusFilter)

  const { data: conflictRows } = await q
  const conflicts = (conflictRows ?? []) as ConflictRow[]
  if (conflicts.length === 0) {
    return { status_filter: statusFilter, project_filter: project, total: 0, conflicts: [] }
  }

  const decisionIds = new Set<string>()
  for (const c of conflicts) {
    decisionIds.add(c.decision_id_a)
    decisionIds.add(c.decision_id_b)
  }
  const { data: decisionRows } = await supabase
    .from('decisions')
    .select(DECISION_COLUMNS)
    .in('id', [...decisionIds])

  const decisionById = new Map<string, DecisionRow>()
  for (const d of (decisionRows ?? []) as DecisionRow[]) decisionById.set(d.id, d)

  const isDead = (d: DecisionRow | null) =>
    d !== null && (d.status === 'superseded' || d.status === 'abandoned' || d.status === 'disproven')

  const enriched: EnrichedConflict[] = conflicts.map(c => {
    const a = decisionById.get(c.decision_id_a) ?? null
    const b = decisionById.get(c.decision_id_b) ?? null
    const aDead = isDead(a)
    const bDead = isDead(b)
    let obsolete_because: string | null = null
    if (aDead && bDead) {
      obsolete_because = `Both decisions are now inactive (A: ${a!.status}, B: ${b!.status}).`
    } else if (aDead) {
      obsolete_because = `Decision A is now ${a!.status}.`
    } else if (bDead) {
      obsolete_because = `Decision B is now ${b!.status}.`
    }
    return { ...c, decision_a: a, decision_b: b, obsolete_because }
  })

  const filtered = project
    ? enriched.filter(e => e.decision_a?.project === project || e.decision_b?.project === project)
    : enriched

  return {
    status_filter: statusFilter,
    project_filter: project,
    total: filtered.length,
    conflicts: filtered.slice(0, limit),
  }
}

function formatConflicts(result: ConflictsResult): string {
  const { status_filter, project_filter, total, conflicts } = result

  if (conflicts.length === 0) {
    const statusLabel = status_filter === 'all' ? '' : `${status_filter} `
    const projLabel = project_filter ? ` for project ${project_filter}` : ''
    return `# Conflicts\n\nNo ${statusLabel}conflicts found${projLabel}.`
  }

  const statusLabel = status_filter === 'all' ? '' : `${status_filter} `
  const header =
    `# Conflicts — ${total} ${statusLabel}conflict${total > 1 ? 's' : ''}\n` +
    (project_filter ? `Filter: project=${project_filter} | ` : '') +
    `showing ${conflicts.length} of ${total}`

  const renderDecision = (label: 'A' | 'B', d: DecisionRow | null) => {
    if (!d) return `  ${label}. ⚠️ decision not found (deleted?)`
    const proj = d.project ? ` (${d.project})` : ''
    return `  ${label}. [${d.decided_at} | ${d.status}]${proj} ${d.decision_text}`
  }

  const blocks = conflicts.map((c, i) => {
    const lines = [
      `## Conflict ${i + 1}  ·  detected ${c.detected_at.split('T')[0]}  ·  ${c.status}`,
      `ID: ${c.id}`,
      `Description: ${c.conflict_description}`,
      '',
      renderDecision('A', c.decision_a),
      renderDecision('B', c.decision_b),
    ]
    if (c.obsolete_because) lines.push('', `⚠️ ${c.obsolete_because}`)
    if (c.resolution_notes) lines.push('', `Resolution notes: ${c.resolution_notes}`)
    return lines.join('\n')
  }).join('\n\n')

  return `${header}\n\n${blocks}`
}

// ─── Staleness scoring (Component 21) ────────────────────────────────────

function pickHalfLife(row: {
  type: string | null
  artifact_type: string | null
  status: string | null
}): number {
  const t = (row.type ?? '').toLowerCase()
  const a = (row.artifact_type ?? '').toLowerCase()

  // Reference material — long-lived
  if (a === 'spec' || a === 'reference') return 730
  if (t === 'resource') return 365

  // Time-sensitive snapshots
  if (a === 'status' || t === 'status') return 14
  if (t === 'digest-item' || a === 'digest-item') return 30

  // Thinking artifacts
  if (t === 'brainstorm') return 60
  if (t === 'decision') return 180
  if (t === 'project') return 30

  return 90 // default
}

async function internalUpdateStalenessScores(dryRun = false): Promise<{
  updated: number
  skipped: number
  errors: number
  total: number
  dry_run: boolean
}> {
  const { data: rows, error } = await supabase
    .from('notes')
    .select('id, type, artifact_type, status, updated_at, staleness_score')
  if (error || !rows) {
    return { updated: 0, skipped: 0, errors: 1, total: 0, dry_run: dryRun }
  }

  const now = Date.now()
  const LN2 = Math.log(2)
  const DAY_MS = 1000 * 60 * 60 * 24
  const NOISE_FLOOR = 0.01
  const CHUNK = 50

  let updated = 0
  let skipped = 0
  let errors = 0

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const results = await Promise.all(chunk.map(async row => {
      const halfLife = pickHalfLife(row)
      const anchor = row.updated_at ? new Date(row.updated_at).getTime() : now
      const ageDays = Math.max(0, (now - anchor) / DAY_MS)
      const newScore = Math.exp(-LN2 * ageDays / halfLife)
      const currentScore = row.staleness_score ?? 1.0

      // Noise floor — skip writes for sub-0.01 drifts to avoid churn
      if (Math.abs(newScore - currentScore) < NOISE_FLOOR) return 'skip'
      if (dryRun) return 'updated' // count it but don't actually write

      const { error: updErr } = await supabase
        .from('notes')
        .update({ staleness_score: newScore })
        .eq('id', row.id)
      return updErr ? 'error' : 'updated'
    }))
    for (const r of results) {
      if (r === 'updated') updated++
      else if (r === 'skip') skipped++
      else errors++
    }
  }

  return { updated, skipped, errors, total: rows.length, dry_run: dryRun }
}

// ─── Confidence routing on edges (Component 25) ──────────────────────────

const EDGE_AUTO_SURFACE_MIN = 0.75  // strict > threshold for auto tier
const EDGE_EXPLICIT_MIN = 0.5       // inclusive >= threshold for explicit tier

interface RelatedNoteRow {
  related_id: string
  related_path: string
  related_title: string | null
  relationship_type: string
  confidence: number
  direction: 'outgoing' | 'incoming'
}

async function internalGetRelatedNotes(
  noteId: string,
  tier: 'auto' | 'medium' = 'auto',
  limit = 10,
): Promise<RelatedNoteRow[]> {
  let outQ = supabase
    .from('note_edges')
    .select('note_id_b, relationship_type, confidence')
    .eq('note_id_a', noteId)
  let inQ = supabase
    .from('note_edges')
    .select('note_id_a, relationship_type, confidence')
    .eq('note_id_b', noteId)

  if (tier === 'auto') {
    outQ = outQ.gt('confidence', EDGE_AUTO_SURFACE_MIN)
    inQ = inQ.gt('confidence', EDGE_AUTO_SURFACE_MIN)
  } else {
    // medium: [0.5, 0.75] inclusive both ends — 0.75 exactly falls in medium per schema comment
    outQ = outQ.gte('confidence', EDGE_EXPLICIT_MIN).lte('confidence', EDGE_AUTO_SURFACE_MIN)
    inQ = inQ.gte('confidence', EDGE_EXPLICIT_MIN).lte('confidence', EDGE_AUTO_SURFACE_MIN)
  }

  const [outRes, inRes] = await Promise.all([
    outQ.order('confidence', { ascending: false }).limit(limit * 2),
    inQ.order('confidence', { ascending: false }).limit(limit * 2),
  ])

  type EdgeInfo = { far: string; relationship_type: string; confidence: number; direction: 'outgoing' | 'incoming' }
  const edges: EdgeInfo[] = []
  for (const r of ((outRes.data ?? []) as Array<{ note_id_b: string; relationship_type: string; confidence: number }>)) {
    edges.push({ far: r.note_id_b, relationship_type: r.relationship_type, confidence: r.confidence, direction: 'outgoing' })
  }
  for (const r of ((inRes.data ?? []) as Array<{ note_id_a: string; relationship_type: string; confidence: number }>)) {
    edges.push({ far: r.note_id_a, relationship_type: r.relationship_type, confidence: r.confidence, direction: 'incoming' })
  }

  if (edges.length === 0) return []

  const farIds = Array.from(new Set(edges.map(e => e.far)))
  const { data: noteRows } = await supabase
    .from('notes')
    .select('id, path, title')
    .in('id', farIds)
  const notesById = new Map<string, { id: string; path: string; title: string | null }>()
  for (const n of (noteRows ?? []) as Array<{ id: string; path: string; title: string | null }>) {
    notesById.set(n.id, n)
  }

  const rows: RelatedNoteRow[] = []
  for (const e of edges) {
    const note = notesById.get(e.far)
    if (!note) continue // orphaned edge — shouldn't happen under CASCADE
    rows.push({
      related_id: note.id,
      related_path: note.path,
      related_title: note.title,
      relationship_type: e.relationship_type,
      confidence: e.confidence,
      direction: e.direction,
    })
  }
  rows.sort((a, b) => b.confidence - a.confidence)
  return rows.slice(0, limit)
}

const SYMMETRIC_EDGE_TYPES = new Set(['contradicts', 'supports', 'relates_to', 'inspired_by'])

function renderEdgeArrow(relType: string, direction: 'outgoing' | 'incoming'): string {
  if (SYMMETRIC_EDGE_TYPES.has(relType)) {
    return `↔ ${relType} ↔`
  }
  if (relType === 'supersedes') {
    return direction === 'outgoing' ? '→ supersedes →' : '← superseded by ←'
  }
  if (relType === 'is_part_of') {
    return direction === 'outgoing' ? '→ part of →' : '← contains ←'
  }
  if (relType === 'references') {
    return direction === 'outgoing' ? '→ references →' : '← referenced by ←'
  }
  return direction === 'outgoing' ? `→ ${relType} →` : `← ${relType} ←`
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().split('T')[0]
}

// ─── Session close helpers (Component 24 + 32 + 27 + 34 + 23) ────────────

function internalNormalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[?!.,:;"'`()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function internalExtractQuestions(summary: string): Promise<string[]> {
  const prompt = `You are extracting questions from a session summary for John's knowledge vault.

Read the summary and return every distinct question John posed during the session — both questions he asked Claude and questions he raised for himself to think about later. Do NOT invent questions that aren't in the summary.

Rules:
- Each question should be a single sentence ending with a question mark.
- Canonicalize — if the same question is asked twice in slightly different words, return it only once.
- Ignore rhetorical asides and clarifying sub-questions that are immediately answered.
- If there are no questions, return an empty array.

Return ONLY valid JSON, no prose, no code fences:
{"questions":["...","..."]}

Summary: ${JSON.stringify(summary)}`

  try {
    const raw = await callHaiku(prompt, 512)
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)
    if (!parsed || !Array.isArray(parsed.questions)) return []
    return parsed.questions
      .filter((q: unknown) => typeof q === 'string' && q.trim().length > 0)
      .map((q: string) => q.trim())
  } catch {
    // Non-fatal — skip question bank update for this session
    return []
  }
}

// ─── Synthesize thinking on topic (Component 12) ─────────────────────────

interface TimelineEntry {
  date: string          // YYYY-MM-DD
  kind: 'note' | 'decision' | 'related'
  render: string
  source_path?: string
  source_id?: string
}

interface SynthesisResult {
  topic: string
  project: string | null
  since: string | null
  narrative: string
  timeline_start: string | null
  timeline_end: string | null
  source_count: { notes: number; decisions: number; related: number }
  note_sources: string[]
  decision_matched: boolean
  synthesis_error?: string
}

async function internalSynthesizeThinking(
  topic: string,
  project: string | null,
  since: string | null,
): Promise<SynthesisResult> {
  // ── Phase A: parallel retrieval ─────────────────────────────────────
  const [semanticHits, decisionHistory] = await Promise.all([
    internalSemanticSearch(topic, 10, project),
    internalGetDecisionHistory(topic, project, 5),
  ])

  // ── Phase B: fetch note metadata for semantic-hit paths ─────────────
  const noteMetaByPath = new Map<string, {
    id: string
    path: string
    title: string | null
    date: string | null
  }>()

  if (semanticHits.length > 0) {
    const { data: noteRows } = await supabase
      .from('notes')
      .select('id, path, title, created_at, updated_at')
      .in('path', semanticHits.map(s => s.path))
    for (const n of (noteRows ?? []) as Array<{ id: string; path: string; title: string | null; created_at: string | null; updated_at: string | null }>) {
      const updated = n.updated_at ? n.updated_at.split('T')[0] : null
      noteMetaByPath.set(n.path, {
        id: n.id,
        path: n.path,
        title: n.title,
        date: n.created_at ?? updated ?? null,
      })
    }
  }

  // ── Phase C: parallel edge expansion from top 5 semantic seeds ──────
  const seedIds = semanticHits
    .slice(0, 5)
    .map(s => noteMetaByPath.get(s.path)?.id)
    .filter((x): x is string => !!x)

  const relatedBySeeder = await Promise.all(
    seedIds.map(id => internalGetRelatedNotes(id, 'auto', 5))
  )

  const semanticPathSet = new Set(semanticHits.map(s => s.path))
  const relatedSeen = new Set<string>()
  const relatedEntries: Array<{
    related_id: string
    related_path: string
    related_title: string | null
    relationship_type: string
  }> = []
  for (const bucket of relatedBySeeder) {
    for (const r of bucket) {
      if (semanticPathSet.has(r.related_path)) continue
      if (relatedSeen.has(r.related_path)) continue
      relatedSeen.add(r.related_path)
      relatedEntries.push({
        related_id: r.related_id,
        related_path: r.related_path,
        related_title: r.related_title,
        relationship_type: r.relationship_type,
      })
    }
  }

  const relatedDateById = new Map<string, string | null>()
  if (relatedEntries.length > 0) {
    const { data: rows } = await supabase
      .from('notes')
      .select('id, created_at, updated_at')
      .in('id', relatedEntries.map(r => r.related_id))
    for (const n of (rows ?? []) as Array<{ id: string; created_at: string | null; updated_at: string | null }>) {
      const updated = n.updated_at ? n.updated_at.split('T')[0] : null
      relatedDateById.set(n.id, n.created_at ?? updated ?? null)
    }
  }

  // ── Phase D: build timeline entries ─────────────────────────────────
  const timeline: TimelineEntry[] = []

  for (const hit of semanticHits) {
    const meta = noteMetaByPath.get(hit.path)
    const date = meta?.date
    if (!date) continue
    const title = meta?.title ?? hit.path
    const excerpt = hit.content.slice(0, 300).replace(/\s+/g, ' ').trim()
    timeline.push({
      date,
      kind: 'note',
      source_path: hit.path,
      render: `[${date} | note]           ${hit.path} — ${title}\n  excerpt: ${excerpt}...`,
    })
  }

  for (const chain of decisionHistory.chains) {
    for (const d of chain.decisions) {
      const date = d.decided_at
      if (!date) continue
      const statusPart = d.status === 'superseded' && d.superseded_by
        ? `superseded_by ${d.superseded_by.slice(0, 8)}${d.superseded_reason ? ` (reason: ${d.superseded_reason})` : ''}`
        : d.status
      const lines = [
        `[${date} | decision]       ${statusPart}`,
        `  "${d.decision_text}"`,
        `  id: ${d.id.slice(0, 8)}`,
      ]
      if (d.outcome_notes && d.status !== 'active') {
        lines.push(`  outcome: ${d.outcome_notes}`)
      }
      timeline.push({
        date,
        kind: 'decision',
        source_id: d.id,
        render: lines.join('\n'),
      })
    }
  }

  for (const r of relatedEntries) {
    const date = relatedDateById.get(r.related_id)
    if (!date) continue
    const title = r.related_title ?? r.related_path
    timeline.push({
      date,
      kind: 'related',
      source_path: r.related_path,
      render: `[${date} | related]        via "${r.relationship_type}"\n  ${r.related_path} — ${title}`,
    })
  }

  // ── Phase E: dedupe ─────────────────────────────────────────────────
  const seenPath = new Set<string>()
  const seenDecisionId = new Set<string>()
  const deduped: TimelineEntry[] = []
  for (const entry of timeline) {
    if (entry.kind === 'decision' && entry.source_id) {
      if (seenDecisionId.has(entry.source_id)) continue
      seenDecisionId.add(entry.source_id)
    } else if (entry.source_path) {
      if (seenPath.has(entry.source_path)) continue
      seenPath.add(entry.source_path)
    }
    deduped.push(entry)
  }

  // ── Phase F: since filter + chronological sort ──────────────────────
  const filtered = since
    ? deduped.filter(e => e.date >= since)
    : deduped
  filtered.sort((a, b) => a.date.localeCompare(b.date))

  // ── Phase G: empty check (hardcoded, no Sonnet call) ────────────────
  const noteCount = filtered.filter(e => e.kind === 'note').length
  const decisionCount = filtered.filter(e => e.kind === 'decision').length
  const relatedCount = filtered.filter(e => e.kind === 'related').length

  if (filtered.length === 0) {
    return {
      topic,
      project,
      since,
      narrative: `No relevant thinking found on "${topic}"${project ? ` in project ${project}` : ''}${since ? ` since ${since}` : ''}. No notes, decisions, or related knowledge-graph edges matched.`,
      timeline_start: null,
      timeline_end: null,
      source_count: { notes: 0, decisions: 0, related: 0 },
      note_sources: [],
      decision_matched: false,
    }
  }

  // ── Phase H: call Sonnet ────────────────────────────────────────────
  const timelineDump = filtered.map(e => e.render).join('\n\n')

  const prompt = `You are synthesizing how John's thinking on "${topic}" has evolved over time.

Below is a chronological timeline of notes he wrote, decisions he recorded, and related notes surfaced from his knowledge graph. Each entry is timestamped.

Write a 3-5 paragraph narrative that:
1. Opens with when this thinking started and what the initial position was.
2. Traces the key shifts in position over time, citing specific dates.
3. Calls out decisions that were superseded, proven, disproven, or abandoned — and what changed his mind (use the "reason:" hint when present).
4. Ends with the current settled position, OR identifies the remaining unresolved tension if there isn't one.
5. Keeps it grounded — do NOT invent facts or decisions that aren't in the timeline. If the timeline is sparse, say so explicitly.

Respond with ONLY the narrative text. No headers, no bullet lists, no code fences.

--- TIMELINE ---
${timelineDump}
--- END TIMELINE ---`

  let narrative = ''
  let synthesis_error: string | undefined

  try {
    narrative = (await callSonnet(prompt, 2048)).trim()
  } catch (err) {
    synthesis_error = `synthesis failed: ${(err as Error).message}`
    narrative = `⚠️ Sonnet synthesis failed. Raw timeline below:\n\n${timelineDump}`
  }

  // ── Phase I: build result ───────────────────────────────────────────
  const noteSources = Array.from(new Set(
    filtered
      .filter(e => e.source_path && (e.kind === 'note' || e.kind === 'related'))
      .map(e => e.source_path!)
  ))

  return {
    topic,
    project,
    since,
    narrative,
    timeline_start: filtered[0].date,
    timeline_end: filtered[filtered.length - 1].date,
    source_count: { notes: noteCount, decisions: decisionCount, related: relatedCount },
    note_sources: noteSources,
    decision_matched: decisionCount > 0,
    synthesis_error,
  }
}

function formatSynthesis(result: SynthesisResult): string {
  const lines: string[] = [`# Thinking on: ${result.topic}`]
  if (result.project) lines.push(`Project: ${result.project}`)
  if (result.since) lines.push(`Since: ${result.since}`)

  if (result.timeline_start && result.timeline_end) {
    lines.push(`📅 Timeline: ${result.timeline_start} → ${result.timeline_end}`)
  }
  lines.push(`📊 Sources: ${result.source_count.notes} notes, ${result.source_count.decisions} decisions, ${result.source_count.related} related`)
  if (result.synthesis_error) lines.push(`⚠️ ${result.synthesis_error}`)

  lines.push('', result.narrative)

  if (result.note_sources.length > 0) {
    lines.push('', '## Sources')
    for (const p of result.note_sources) lines.push(`📄 ${p}`)
    if (result.decision_matched) lines.push(`🎯 Decision chain matched on topic keywords`)
  }

  return lines.join('\n')
}

// ─── Cross-project insight (Component 14) ────────────────────────────────

const CROSS_PROJECT_FETCH_CAP = 200
const CROSS_PROJECT_SONNET_CAP = 20

interface CrossProjectEdge {
  edge_id: string
  relationship_type: string
  confidence: number
  created_at: string
  a: { id: string; path: string; title: string | null; project: string }
  b: { id: string; path: string; title: string | null; project: string }
}

interface CrossProjectInsightResult {
  since: string
  confidence_min: number
  projects: string[] | null
  edge_count: number
  projects_involved: string[]
  narrative: string
  edges: CrossProjectEdge[]
  insight_error?: string
}

async function internalFindCrossProjectEdges(
  since: string,
  confidence_min: number,
  projects: string[] | null,
  limit = CROSS_PROJECT_SONNET_CAP,
): Promise<CrossProjectEdge[]> {
  const { data: edgeRows } = await supabase
    .from('note_edges')
    .select('id, note_id_a, note_id_b, relationship_type, confidence, created_at')
    .gte('confidence', confidence_min)
    .gte('created_at', since)
    .order('confidence', { ascending: false })
    .limit(CROSS_PROJECT_FETCH_CAP)

  const edges = (edgeRows ?? []) as Array<{
    id: string
    note_id_a: string
    note_id_b: string
    relationship_type: string
    confidence: number
    created_at: string
  }>
  if (edges.length === 0) return []

  const noteIds = Array.from(new Set(edges.flatMap(e => [e.note_id_a, e.note_id_b])))
  const { data: noteRows } = await supabase
    .from('notes')
    .select('id, path, title, project')
    .in('id', noteIds)

  const notesById = new Map<string, { id: string; path: string; title: string | null; project: string | null }>()
  for (const n of (noteRows ?? []) as Array<{ id: string; path: string; title: string | null; project: string | null }>) {
    notesById.set(n.id, n)
  }

  const projectFilterSet = projects && projects.length > 0 ? new Set(projects) : null

  const result: CrossProjectEdge[] = []
  for (const e of edges) {
    const a = notesById.get(e.note_id_a)
    const b = notesById.get(e.note_id_b)
    if (!a || !b) continue
    if (!a.project || !b.project) continue
    if (a.project === b.project) continue
    if (projectFilterSet && !projectFilterSet.has(a.project) && !projectFilterSet.has(b.project)) continue
    result.push({
      edge_id: e.id,
      relationship_type: e.relationship_type,
      confidence: e.confidence,
      created_at: e.created_at,
      a: { id: a.id, path: a.path, title: a.title, project: a.project },
      b: { id: b.id, path: b.path, title: b.title, project: b.project },
    })
    if (result.length >= limit) break
  }
  return result
}

function renderCrossProjectEdgeForPrompt(e: CrossProjectEdge): string {
  const titleA = e.a.title ?? e.a.path
  const titleB = e.b.title ?? e.b.path
  const arrow = SYMMETRIC_EDGE_TYPES.has(e.relationship_type)
    ? `↔ ${e.relationship_type} ↔`
    : `→ ${e.relationship_type} →`
  return `[${e.a.project}] "${titleA}" — ${e.a.path}\n  ${arrow} (confidence ${e.confidence.toFixed(2)})\n[${e.b.project}] "${titleB}" — ${e.b.path}`
}

async function internalCrossProjectInsight(
  since: string,
  confidence_min: number,
  projects: string[] | null,
): Promise<CrossProjectInsightResult> {
  const edges = await internalFindCrossProjectEdges(since, confidence_min, projects, CROSS_PROJECT_SONNET_CAP)

  const projectsInvolved = Array.from(
    new Set(edges.flatMap(e => [e.a.project, e.b.project]))
  ).sort()

  if (edges.length === 0) {
    const projFilter = projects && projects.length > 0 ? ` involving ${projects.join(', ')}` : ''
    return {
      since,
      confidence_min,
      projects,
      edge_count: 0,
      projects_involved: [],
      narrative: `No cross-project edges${projFilter} at confidence ≥ ${confidence_min} since ${since}. Either the projects are siloed or the intelligence pipeline hasn't surfaced connections yet.`,
      edges: [],
    }
  }

  const edgeDump = edges.map(renderCrossProjectEdgeForPrompt).join('\n\n')

  const prompt = `You are analyzing cross-project connections in John's knowledge vault.

Below is a list of edges — named relationships between notes — where each edge connects notes from DIFFERENT projects. These represent ideas, decisions, or patterns that echo across his work on multiple projects.

Your job: write a 2-4 paragraph narrative that surfaces the themes these cross-project connections reveal. What patterns show up in multiple projects? What has he learned in one project that's influenced another? What cross-cutting concerns emerge?

Rules:
- Group by theme, not by project pair.
- Cite specific notes by path when referencing them.
- Do NOT invent relationships or notes not in the list.
- If the edges are sparse or thematically incoherent, say so plainly — don't fabricate a narrative.
- Keep it grounded — reason from what's here, don't speculate beyond it.

Respond with ONLY the narrative text. No headers, no bullet lists, no code fences.

--- CROSS-PROJECT EDGES ---
${edgeDump}
--- END EDGES ---`

  let narrative = ''
  let insight_error: string | undefined

  try {
    narrative = (await callSonnet(prompt, 2048)).trim()
  } catch (err) {
    insight_error = `synthesis failed: ${(err as Error).message}`
    narrative = `⚠️ Sonnet synthesis failed. Raw edges below:\n\n${edgeDump}`
  }

  return {
    since,
    confidence_min,
    projects,
    edge_count: edges.length,
    projects_involved: projectsInvolved,
    narrative,
    edges,
    insight_error,
  }
}

function formatCrossProjectInsight(result: CrossProjectInsightResult): string {
  const lines: string[] = ['# Cross-project insight']
  const projFilter = result.projects && result.projects.length > 0
    ? result.projects.join(', ')
    : 'all projects'
  lines.push(`Filter: ${projFilter}`)
  lines.push(`Since: ${result.since} | confidence ≥ ${result.confidence_min}`)
  lines.push(`📊 ${result.edge_count} cross-project edges across: ${result.projects_involved.join(', ') || '—'}`)
  if (result.insight_error) lines.push(`⚠️ ${result.insight_error}`)

  lines.push('', result.narrative)

  if (result.edges.length > 0) {
    lines.push('', '## Edges')
    for (const e of result.edges) {
      const arrow = SYMMETRIC_EDGE_TYPES.has(e.relationship_type)
        ? `↔ ${e.relationship_type} ↔`
        : `→ ${e.relationship_type} →`
      lines.push(`[${e.a.project}] ${e.a.path}  ${arrow}  [${e.b.project}] ${e.b.path}  (${e.confidence.toFixed(2)})`)
    }
  }

  return lines.join('\n')
}

const app = new Hono()
const server = new McpServer({ name: 'sanctum-vault', version: '1.0.0' })

async function getAllVaultNotes(folderPath = ''): Promise<string[]> {
  const urlPath = folderPath ? `${folderPath}/` : ''
  const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(urlPath)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!res.ok) return []
  const data = await res.json()
  const entries: string[] = data.files ?? []
  const allNotes: string[] = []
  for (const entry of entries) {
    if (entry.endsWith('/')) {
      const subfolderName = entry.slice(0, -1)
      const subfolderPath = folderPath ? `${folderPath}/${subfolderName}` : subfolderName
      const subNotes = await getAllVaultNotes(subfolderPath)
      allNotes.push(...subNotes)
    } else if (entry.endsWith('.md')) {
      allNotes.push(folderPath ? `${folderPath}/${entry}` : entry)
    }
  }
  return allNotes
}

function buildIndexEntry(filename: string, meta: { type?: string; purpose?: string; status?: string; tags?: string }): string {
  const t = meta.type || 'unknown';
  const p = meta.purpose || 'NEEDS REVIEW';
  const s = meta.status || 'active';
  const tg = meta.tags || '';
  return `[${t}] ${filename}\n  purpose: "${p}"\n  tags: ${tg}\n  status: ${s}`;
}

async function updateVaultIndex(
  operation: 'add' | 'update' | 'remove',
  folder: string,
  filename: string,
  meta?: { type?: string; purpose?: string; status?: string; tags?: string }
): Promise<void> {
  const indexPath = '00-system/vault-index.md';
  let content = '';

  // Try to read existing index
  try {
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(indexPath)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (res.ok) {
      content = await res.text();
    }
  } catch {
    // Index doesn't exist yet, start fresh
  }

  if (!content) {
    const today = new Date().toISOString().split('T')[0];
    content = `# Vault Index\n\nGenerated: ${today}\n`;
  }

  const sectionHeader = `## ${folder}`;
  const entry = meta ? buildIndexEntry(filename, meta) : '';

  if (operation === 'remove' || operation === 'update') {
    // Remove existing entry for this filename in the folder section
    const sectionRegex = new RegExp(`(## ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)([\\s\\S]*?)(?=\\n## |$)`);
    const sectionMatch = content.match(sectionRegex);
    if (sectionMatch) {
      const sectionContent = sectionMatch[2];
      // Remove the entry block: [type] filename.md followed by indented lines
      const entryRegex = new RegExp(`\\[\\w+\\] ${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?:  [^\\n]*\\n?)*`, 'g');
      const cleaned = sectionContent.replace(entryRegex, '');
      content = content.replace(sectionMatch[0], sectionMatch[1] + cleaned);
    }
  }

  if (operation === 'add' || operation === 'update') {
    if (!content.includes(sectionHeader)) {
      // Append new section
      content = content.trimEnd() + `\n\n${sectionHeader}\n\n${entry}\n`;
    } else {
      // Add entry at end of existing section
      const sectionRegex = new RegExp(`(## ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)`);
      const sectionMatch = content.match(sectionRegex);
      if (sectionMatch && sectionMatch.index !== undefined) {
        // Find end of section (next ## or end of file)
        const afterSection = content.substring(sectionMatch.index + sectionMatch[0].length);
        const nextSectionIdx = afterSection.search(/\n## /);
        const insertPos = nextSectionIdx === -1
          ? content.length
          : sectionMatch.index + sectionMatch[0].length + nextSectionIdx;
        content = content.substring(0, insertPos).trimEnd() + `\n${entry}\n` + content.substring(insertPos);
      }
    }
  }

  // Write updated index
  await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(indexPath)}`, {
    method: 'PUT',
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown"
    },
    body: content
  });
}

async function updateVaultIndexSection(
  operation: 'create' | 'remove' | 'rename',
  folderPath: string,
  newFolderPath?: string
): Promise<void> {
  const indexPath = '00-system/vault-index.md';
  let content = '';

  // Try to read existing index
  try {
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(indexPath)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (res.ok) {
      content = await res.text();
    }
  } catch {
    // Index doesn't exist yet, start fresh
  }

  if (!content) {
    const today = new Date().toISOString().split('T')[0];
    content = `# Vault Index\n\nGenerated: ${today}\n`;
  }

  const sectionHeader = `## ${folderPath}`;
  const escapedFolder = folderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (operation === 'remove') {
    // Remove the entire section header and all its content
    const sectionRegex = new RegExp(`\\n?## ${escapedFolder}\\n[\\s\\S]*?(?=\\n## |$)`);
    content = content.replace(sectionRegex, '');
  }

  if (operation === 'rename' && newFolderPath) {
    // Replace the section header with the new folder path
    content = content.replace(`## ${folderPath}`, `## ${newFolderPath}`);
  }

  if (operation === 'create') {
    if (!content.includes(sectionHeader)) {
      content = content.trimEnd() + `\n\n${sectionHeader}\n`;
    }
  }

  // Write updated index
  await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(indexPath)}`, {
    method: 'PUT',
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown"
    },
    body: content
  });
}

async function runVaultIndexGeneration(): Promise<{ totalNotes: number; folderCount: number; errors: string[] }> {
  const folders = [
    '00-system/', '00-inbox/',
    '01-projects/sigyls/', '01-projects/dallas-tub-fix/',
    '01-projects/sanctum/', '01-projects/sono/',
    '01-projects/turnkey/', '01-projects/iconic-roofing/',
    '02-areas/', '03-resources/', '04-archive/'
  ];

  const today = new Date().toISOString().split('T')[0];
  let index = `# Vault Index\n\nGenerated: ${today}\n`;
  let totalNotes = 0;
  const errors: string[] = [];

  for (const folder of folders) {
    try {
      const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folder)}`, {
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      });
      if (!listRes.ok) continue;

      const listing = await listRes.json();
      const files: string[] = (listing.files || []).filter((f: string) =>
        f.endsWith('.md') && f !== 'vault-index.md'
      );

      if (files.length === 0) {
        index += `\n## ${folder}\n`;
        continue;
      }

      index += `\n## ${folder}\n\n`;

      for (const file of files) {
        try {
          const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folder + file)}`, {
            headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
          });
          if (!noteRes.ok) {
            errors.push(`Failed to read: ${file}`);
            continue;
          }

          const content = await noteRes.text();
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          let type = 'unknown';
          let purpose = 'NEEDS REVIEW';
          let status = 'active';
          let tagStr = '';

          if (fmMatch) {
            const fm = fmMatch[1];
            const getField = (name: string) => {
              const m = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
              return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
            };
            type = getField('type') || getField('artifact_type') || 'unknown';
            purpose = getField('purpose') || 'NEEDS REVIEW';
            status = getField('status') || 'active';
            const tags = fm.match(/^tags:\s*\[([^\]]*)\]/m);
            tagStr = tags ? tags[1].replace(/\s/g, '') : '';
          }

          const filename = file.split('/').pop() || file;
          index += buildIndexEntry(filename, { type, purpose, status, tags: tagStr }) + '\n';
          totalNotes++;
        } catch {
          errors.push(`Error reading: ${file}`);
        }
      }
    } catch {
      errors.push(`Error listing folder: ${folder}`);
    }
  }

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath('00-system/vault-index.md')}`, {
    method: 'PUT',
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown"
    },
    body: index
  });

  if (!writeRes.ok) {
    throw new Error(`Failed to write vault-index.md (status ${writeRes.status})`);
  }

  return { totalNotes, folderCount: folders.length, errors };
}

server.registerTool('save_brainstorm', {
  title: 'Save Brainstorm',
  description: "Save a brainstorm or idea from a Claude chat directly to John's Obsidian vault inbox. Use this when John asks to save, capture, or send something to his vault.",
  inputSchema: {
    title: z.string().describe("Short descriptive title for the note"),
    summary: z.string().describe("2-3 sentence overview of the brainstorm"),
    insights: z.array(z.string()).optional().describe("Key insights or ideas"),
    actions: z.array(z.string()).optional().describe("Action items or next steps"),
    raw: z.string().optional().describe("Full context or raw notes"),
    project: z.string().optional().describe("Project: sigyls, dallas-tub-fix, or leave empty"),
    tags: z.array(z.string()).optional().describe("Hierarchical tags like sigyls/strategy"),
    source_chat_url: z.string().optional().describe("URL of the Claude chat where this brainstorm originated"),
    purpose: z.string().optional().default("NEEDS REVIEW").describe("Purpose or intent of this brainstorm")
  }
}, async ({ title, summary, insights, actions, raw, project, tags, source_chat_url, purpose }) => {
  const today = new Date().toISOString().split("T")[0];
  const tagList = tags ? tags.join(", ") : "";
  const note = `---
type: brainstorm
purpose: "${purpose}"
status: active
tags: [${tagList}]
created: ${today}
source: claude-chat
project: ${(project || "general").trim()}
source_chat_url: "${source_chat_url || ""}"
edit_history:
  - date: ${today}
    action: created
    chat_url: "${source_chat_url || ""}"
---

# ${title}

## Summary
${summary}

## Key Insights
${insights ? insights.map(i => `- ${i}`).join("\n") : "- "}

## Action Items
${actions ? actions.map(a => `- [ ] ${a}`).join("\n") : "- [ ] "}

## Raw Notes
${raw || ""}

## Related
`;
  const fileName = `00-inbox/${today}-${title.toLowerCase().replace(/\s+/g, "-").replace(/\//g, "-")}.md`;
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(fileName)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown",
    },
    body: note,
  });
  if (response.ok) {
    await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/embed-note', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ path: fileName, content: note, project: project || '' })
    })
    fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/intelligence-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ path: fileName, content: note, project: project || '' })
    }).catch(() => {})
    updateVaultIndex('add', fileName.substring(0, fileName.lastIndexOf('/') + 1), fileName.split('/').pop() || '', { type: 'brainstorm', purpose, status: 'active', tags: tagList }).catch(() => {});
  }

  return {
    content: [{ type: "text", text: response.ok ? `✅ Saved to vault: ${fileName}` : `❌ Failed to save note` }]
  };
})

server.registerTool('search_vault', {
  title: 'Search Vault',
  description: "Exact keyword/substring search across John's Obsidian vault (literal string match only). ⚠️ For natural language questions, use route_query instead — it picks the right retrieval strategy automatically. Only use search_vault when you need to find notes containing a specific exact term, filename fragment, or literal phrase (e.g. finding every note that mentions a specific function name or error string).",
  inputSchema: { query: z.string().describe("Search term or topic") }
}, async ({ query }) => {
  const response = await fetch(
    `${OBSIDIAN_API_URL}/search/simple/?query=${encodeURIComponent(query)}&contextLength=100`,
    { method: 'POST', headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }
  );
  if (!response.ok) {
    const errorBody = await response.text();
    return { content: [{ type: "text", text: `Search failed — HTTP ${response.status}: ${errorBody}` }] };
  }
  const results = await response.json();
  return {
    content: [{ type: "text", text: results.length ? JSON.stringify(results.slice(0, 5), null, 2) : `No notes found for: ${query}` }]
  };
})

server.registerTool('browse_vault', {
  title: 'Browse Vault',
  description: "Browse John's Obsidian vault folder structure and file tree. Use to explore what notes and folders exist, navigate the PARA structure, or find notes before reading them.",
  inputSchema: {
    folder: z.string().optional().describe("Folder path to browse, e.g. '01-projects/sigyls/' or leave empty for root")
  }
}, async ({ folder }) => {
  const path = folder ? `${folder.replace(/\/$/, '')}/` : '';
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!response.ok) return { content: [{ type: "text", text: `❌ Could not browse: ${path || 'root'}` }] };
  const data = await response.json();
  const files = data.files || [];
  const folders = files.filter((f: string) => f.endsWith('/'));
  const notes = files.filter((f: string) => !f.endsWith('/'));
  return {
    content: [{ type: "text", text: `📁 ${path || 'vault root'}\n\nFolders:\n${folders.map((f: string) => `  📁 ${f}`).join('\n') || '  (none)'}\n\nNotes:\n${notes.map((f: string) => `  📄 ${f}`).join('\n') || '  (none)'}` }]
  };
})

server.registerTool('read_note', {
  title: 'Read Note',
  description: "Read the full contents of a specific note in John's Obsidian vault by its path. Use after browse_vault to read a specific note.",
  inputSchema: {
    path: z.string().describe("Full path to the note, e.g. '01-projects/sigyls/2026-02-28-ada-design.md'")
  }
}, async ({ path }) => {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (response.ok) {
    const content = await response.text();
    return { content: [{ type: "text", text: `📄 ${path}\n\n${content}` }] };
  }
  // Obsidian unavailable — try GitHub fallback
  const githubContent = await readNoteFromGitHub(path);
  if (githubContent) {
    return { content: [{ type: "text", text: `📄 ${path} *(via GitHub fallback)*\n\n${githubContent}` }] };
  }
  return { content: [{ type: "text", text: `❌ Note not found: ${path} (Obsidian offline and not found on GitHub)` }] };
})

server.registerTool('save_artifact', {
  title: 'Save Artifact',
  description: "Save an artifact, document, specification, or reference material to John's Obsidian vault. Use when John wants to save a document, spec, design, diagram description, or any structured reference content. Files to 03-resources unless a project is specified.",
  inputSchema: {
    title: z.string().describe("Short descriptive title for the artifact"),
    content: z.string().describe("The full content of the artifact"),
    summary: z.string().describe("2-3 sentence description of what this artifact is and why it matters"),
    project: z.string().optional().describe("Project: sigyls, dallas-tub-fix, sanctum, sono, turnkey, or leave empty for general resources"),
    tags: z.array(z.string()).optional().describe("Hierarchical tags like sigyls/architecture or sigyls/ux-design"),
    artifact_type: z.string().optional().describe("Type of artifact: spec, design, diagram, research, template, other"),
    source_chat_url: z.string().optional().describe("URL of the Claude chat where this artifact originated"),
    date_prefix: z.boolean().optional().default(true).describe("Whether to prepend today's date to the filename. Default true. Set false for Foundry spec files."),
    purpose: z.string().optional().default("NEEDS REVIEW").describe("Purpose or intent of this artifact")
  }
}, async ({ title, summary, content, project, tags, artifact_type, source_chat_url, date_prefix, purpose }) => {
  const today = new Date().toISOString().split("T")[0];
  const tagList = tags ? tags.join(", ") : "";
  const folder = project
    ? `01-projects/${project}`
    : `03-resources`;

  const note = `---
type: resource
purpose: "${purpose}"
artifact_type: ${artifact_type || "other"}
status: active
tags: [${tagList}]
created: ${today}
source: claude-chat
project: ${(project || "general").trim()}
source_chat_url: "${source_chat_url || ""}"
edit_history:
  - date: ${today}
    action: created
    chat_url: "${source_chat_url || ""}"
---

# ${title}

## Summary
${summary}

## Content
${content}

## Related
`;

  const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const fileName = date_prefix !== false ? `${folder}/${today}-${slug}.md` : `${folder}/${slug}.md`;
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(fileName)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown",
    },
    body: note,
  });
  if (response.ok) {
    await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/embed-note', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ path: fileName, content: note, project: project || '' })
    })
    fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/intelligence-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ path: fileName, content: note, project: project || '' })
    }).catch(() => {})
    updateVaultIndex('add', fileName.substring(0, fileName.lastIndexOf('/') + 1), fileName.split('/').pop() || '', { type: 'resource', purpose, status: 'active', tags: tagList }).catch(() => {});
  }

  return {
    content: [{ type: "text", text: response.ok ? `✅ Artifact saved to: ${fileName}` : `❌ Failed to save artifact` }]
  };
})

server.registerTool('semantic_search', {
  title: 'Semantic Search',
  description: "Low-level semantic similarity search over John's vault by meaning rather than keywords. ⚠️ For natural language questions, use route_query instead — it classifies intent and picks the best retrieval strategy (semantic_search is just one of several it can choose). Only use semantic_search directly when you explicitly want raw vector similarity results without intent classification or routing.",
  inputSchema: {
    query: z.string().describe("The concept or question to search for"),
    limit: z.number().optional().describe("Number of results to return, default 5"),
    project: z.string().optional().describe("Filter by project: sigyls, dallas-tub-fix, sanctum, sono, turnkey")
  }
}, async ({ query, limit = 5, project }) => {
  const response = await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/semantic-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, project: project || null })
  })
  if (!response.ok) return { content: [{ type: "text", text: "❌ Semantic search failed" }] }
  const data = await response.json()
  if (!data.results?.length) return { content: [{ type: "text", text: `No results found for: ${query}` }] }
  const formatted = data.results.map((r: any) =>
    `📄 ${r.path} (${Math.round(r.similarity * 100)}% match)\n${r.content.slice(0, 200)}...`
  ).join('\n\n')
  return { content: [{ type: "text", text: formatted }] }
})

server.registerTool('delete_note', {
  title: 'Delete Note',
  description: "Permanently delete a note from John's Obsidian vault. Use with caution — this is irreversible.",
  inputSchema: {
    path: z.string().describe("Full path to the note, e.g. '01-projects/sigyls/2026-03-01-old-note.md'")
  }
}, async ({ path }) => {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (response.ok) {
    const delFilename = path.split('/').pop() || '';
    const delFolder = path.substring(0, path.lastIndexOf('/') + 1);
    updateVaultIndex('remove', delFolder, delFilename).catch(() => {});
  }
  return {
    content: [{ type: "text", text: response.ok ? `🗑️ Deleted: ${path}` : `❌ Failed to delete: ${path} (status ${response.status})` }]
  };
})

server.registerTool('edit_note', {
  title: 'Edit Note',
  description: "Edit an existing note in John's Obsidian vault. Can update frontmatter fields, append content, or find and replace specific text within a note.",
  inputSchema: {
    path: z.string().describe("Full path to the note, e.g. '01-projects/sigyls/2026-02-28-ada-design.md'"),
    mode: z.string().describe("Edit mode: 'append' adds to end, 'find_replace' swaps text, 'frontmatter' updates a frontmatter field"),
    content: z.string().optional().describe("Content to append (for append mode)"),
    find: z.string().optional().describe("Text to find (for find_replace mode)"),
    replace: z.string().optional().describe("Text to replace with (for find_replace mode)"),
    field: z.string().optional().describe("Frontmatter field name to update (for frontmatter mode)"),
    value: z.string().optional().describe("New value for the frontmatter field (for frontmatter mode)"),
    chat_url: z.string().optional().describe("URL of the Claude chat where this edit is being made")
  }
}, async ({ path, mode, content, find, replace, field, value, chat_url }) => {
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] };
  let noteContent = await readResponse.text();

  if (mode === "append" && content) {
    noteContent = noteContent.trimEnd() + "\n\n" + content;
  } else if (mode === "find_replace" && find && replace !== undefined) {
    if (!noteContent.includes(find)) return { content: [{ type: "text", text: `❌ Text not found in note: "${find}"` }] };
    noteContent = noteContent.replace(find, replace);
  } else if (mode === "frontmatter" && field && value !== undefined) {
    const regex = new RegExp(`^(${field}:\\s*)(.+)$`, "m");
    if (!regex.test(noteContent)) return { content: [{ type: "text", text: `❌ Frontmatter field not found: "${field}"` }] };
    noteContent = noteContent.replace(regex, `$1${value}`);
  } else {
    return { content: [{ type: "text", text: "❌ Invalid parameters for selected mode" }] };
  }

  const today = new Date().toISOString().split("T")[0];
  const newHistoryEntry = `  - date: ${today}\n    action: edited\n    same_as_creator: false\n    chat_url: "${chat_url || ""}"`;
  const fmEnd = noteContent.indexOf('\n---\n', 3);
  if (fmEnd !== -1 && noteContent.includes('edit_history:')) {
    noteContent = noteContent.slice(0, fmEnd) + '\n' + newHistoryEntry + noteContent.slice(fmEnd);
  }

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown",
    },
    body: noteContent,
  });

  if (writeResponse.ok) {
    await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/embed-note', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ path, content: noteContent, project: '' })
    })
    if (mode === 'frontmatter') {
      try {
        const editedRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
          headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
        });
        if (editedRes.ok) {
          const editedContent = await editedRes.text();
          const fmMatch = editedContent.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const getField = (name: string) => {
              const m = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
              return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
            };
            const editFilename = path.split('/').pop() || '';
            const editFolder = path.substring(0, path.lastIndexOf('/') + 1);
            const tags = fm.match(/^tags:\s*\[([^\]]*)\]/m);
            const tagStr = tags ? tags[1].replace(/\s/g, '') : '';
            updateVaultIndex('update', editFolder, editFilename, {
              type: getField('type') || getField('artifact_type'),
              purpose: getField('purpose'),
              status: getField('status'),
              tags: tagStr
            }).catch(() => {});
          }
        }
      } catch {
        // INDEX update failed silently
      }
    }
  }

  return {
    content: [{ type: "text", text: writeResponse.ok ? `✅ Note updated: ${path}` : `❌ Failed to update note` }]
  };
})

server.registerTool('vault_profile_sync', {
  title: 'Vault Profile Sync',
  description: "Reads John's vault across all active projects and synthesizes a structured profile capturing current project status, next steps, recent decisions, and business context. Writes the profile to 03-resources/claude-profile.md and returns it to Claude for Layer 2 memory update.",
  inputSchema: {
    confirm: z.string().optional().describe("Optional confirmation message, leave empty to run")
  }
}, async () => {
  const notes: { path: string, content: string }[] = []
  const projects = ['sono', 'dallas-tub-fix', 'sigyls', 'turnkey', 'sanctum']
  const today = new Date()

  // LAYER 1 — STATUS note from each project folder (matches STATUS.md or date-prefixed status files)
  for (const project of projects) {
    const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/01-projects/${project}/`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!listRes.ok) continue
    const data = await listRes.json()
    const statusFile = (data.files || [])
      .filter((f: string) => f.toLowerCase().includes('status') && f.endsWith('.md'))
      .sort()
      .reverse()[0]
    if (!statusFile) continue
    const path = `01-projects/${project}/${statusFile}`
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (res.ok) {
      const content = await res.text()
      notes.push({ path, content })
    }
  }
  // LAYER 2 — Handoff notes
  for (const project of projects) {
    const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/01-projects/${project}/`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!listRes.ok) continue
    const data = await listRes.json()
    const handoffFiles = (data.files || []).filter((f: string) => f.toLowerCase().includes('handoff'))
    // Get the most recent handoff only
    const latest = handoffFiles.sort().reverse()[0]
    if (!latest) continue
    const path = `01-projects/${project}/${latest}`
    const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (noteRes.ok) {
      const content = await noteRes.text()
      notes.push({ path, content })
    }
  }
  // LAYER 3 — Last 7 days
  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(today.getDate() - 7)

  for (const project of projects) {
    const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/01-projects/${project}/`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!listRes.ok) continue
    const data = await listRes.json()
    const recentFiles = (data.files || []).filter((f: string) => {
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/)
      if (!dateMatch) return false
      const fileDate = new Date(dateMatch[1])
      return fileDate >= sevenDaysAgo
    })
    for (const file of recentFiles) {
      const path = `01-projects/${project}/${file}`
      // Skip if already collected in Layer 1 or 2
      if (notes.some(n => n.path === path)) continue
      const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      })
      if (noteRes.ok) {
        const content = await noteRes.text()
        notes.push({ path, content })
      }
    }
  }
  // LAYER 4 — Semantic search
  const searchRes = await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/semantic-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ query: 'current priorities next steps active work recent decisions', limit: 5 })
  })
  if (searchRes.ok) {
    const searchData = await searchRes.json()
    for (const result of (searchData.results || [])) {
      // Skip if already collected
      if (notes.some(n => n.path === result.path)) continue
      notes.push({ path: result.path, content: result.content })
    }
  }

  // Synthesize profile with Gemini
  const combinedNotes = notes.map(n => `--- ${n.path} ---\n${n.content}`).join('\n\n')

  const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${Deno.env.get('GEMINI_API_KEY')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `You are synthesizing a profile of John's current work state from his vault notes.

Based on the notes below, produce a structured profile with exactly these four sections:

## Active Projects & Phase
For each active project, one line: project name — current phase — status

## Immediate Next Steps
The most pressing action items across all projects, max 8 bullet points total

## Recent Decisions
Key decisions made recently that affect future work, max 6 bullet points

## Business Context
One line per active venture summarizing where it stands right now

Be concise and specific. Use only what is actually in the notes — do not infer or invent.

NOTES:
${combinedNotes}`
        }]
      }]
    })
  })

  if (!geminiRes.ok) {
    return { content: [{ type: "text", text: `❌ Gemini synthesis failed: ${geminiRes.status}` }] }
  }

  const geminiData = await geminiRes.json()
  const profile = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || ''

  if (!profile) {
    return { content: [{ type: "text", text: '❌ Gemini returned empty profile' }] }
  }

  // Write profile to vault
  const profileNote = `---
type: resource
status: active
tags: [sanctum/claude-profile]
created: ${today.toISOString().split('T')[0]}
source: vault-profile-sync
---

# Claude Profile — Last Synced ${today.toISOString().split('T')[0]}

${profile}
`

  await fetch(`${OBSIDIAN_API_URL}/vault/03-resources/claude-profile.md`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${OBSIDIAN_API_KEY}`,
      'Content-Type': 'text/markdown'
    },
    body: profileNote
  })

  return {
    content: [{
      type: "text",
      text: `✅ Vault profile synced — ${notes.length} notes read\n\n${profile}`
    }]
  }
})

server.registerTool('run_gap_filler', {
  title: 'Run Gap Filler',
  description: "Trigger the gap filler agent to analyze John's Obsidian vault for missing connections between notes. Writes a gap analysis report to the vault inbox. Use when John says 'run the gap filler', 'analyze my vault', or 'find missing connections'.",
  inputSchema: {}
}, async () => {
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")!}/functions/v1/gap-filler`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SANCTUM_ANON_KEY")!}`
    }
  });
  const data = await response.json();
  return {
    content: [{ type: "text", text: response.ok
      ? `✅ Gap filler complete — ${data.connections_proposed} connections proposed across ${data.notes_analyzed} notes. Check your inbox for the gap analysis note.`
      : `❌ Gap filler failed: ${JSON.stringify(data)}` }]
  };
})

server.registerTool('move_note', {
  title: 'Move Note',
  description: "Move a note from any path to any destination in John's Obsidian vault. Use when John wants to reorganize or relocate a note.",
  inputSchema: {
    source_path: z.string().describe("Full source path, e.g. '00-inbox/2026-03-01-my-note.md'"),
    destination_path: z.string().describe("Full destination path, e.g. '01-projects/sigyls/2026-03-01-my-note.md'")
  }
}, async ({ source_path, destination_path }) => {
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(source_path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Source not found: ${source_path}` }] };
  const content = await readResponse.text();

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(destination_path)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content,
  });
  if (!writeResponse.ok) return { content: [{ type: "text", text: `❌ Failed to write to: ${destination_path}` }] };

  const deleteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(source_path)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });

  const { error: embeddingError } = await supabase
    .from('note_embeddings')
    .update({ path: destination_path })
    .eq('path', source_path);
  if (embeddingError) {
    console.warn(`⚠️ Embeddings path update failed for move ${source_path} → ${destination_path}:`, embeddingError.message);
  }

  const srcFilename = source_path.split('/').pop() || '';
  const srcFolder = source_path.substring(0, source_path.lastIndexOf('/') + 1);
  const destFilename = destination_path.split('/').pop() || '';
  const destFolder = destination_path.substring(0, destination_path.lastIndexOf('/') + 1);
  updateVaultIndex('remove', srcFolder, srcFilename).catch(() => {});
  updateVaultIndex('add', destFolder, destFilename, { type: 'unknown', purpose: 'NEEDS REVIEW', status: 'active', tags: '' }).catch(() => {});

  return {
    content: [{ type: "text", text: deleteResponse.ok
      ? `✅ Moved: ${source_path} → ${destination_path}`
      : `⚠️ Copied to ${destination_path} but failed to delete source: ${source_path}` }]
  };
})

server.registerTool('rename_note', {
  title: 'Rename Note',
  description: "Rename a note in place without moving it to a different folder in John's Obsidian vault.",
  inputSchema: {
    path: z.string().describe("Full current path, e.g. '01-projects/sigyls/2026-03-01-old-name.md'"),
    new_name: z.string().describe("New filename only (no folder), e.g. 'my-new-name.md'")
  }
}, async ({ path, new_name }) => {
  const folder = path.substring(0, path.lastIndexOf('/') + 1);
  const new_path = folder + new_name;

  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] };
  const content = await readResponse.text();

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(new_path)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content,
  });
  if (!writeResponse.ok) return { content: [{ type: "text", text: `❌ Failed to write to: ${new_path}` }] };

  const deleteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });

  const { error: embeddingError } = await supabase
    .from('note_embeddings')
    .update({ path: new_path })
    .eq('path', path);
  if (embeddingError) {
    console.warn(`⚠️ Embeddings path update failed for rename ${path} → ${new_path}:`, embeddingError.message);
  }

  const oldFilename = path.split('/').pop() || '';
  const noteFolder = path.substring(0, path.lastIndexOf('/') + 1);
  updateVaultIndex('remove', noteFolder, oldFilename).catch(() => {});
  updateVaultIndex('add', noteFolder, new_name, { type: 'unknown', purpose: 'NEEDS REVIEW', status: 'active', tags: '' }).catch(() => {});

  return {
    content: [{ type: "text", text: deleteResponse.ok
      ? `✅ Renamed to: ${new_path}`
      : `⚠️ Created ${new_path} but failed to delete original: ${path}` }]
  };
})

server.registerTool('batch_update_frontmatter', {
  title: 'Batch Update Frontmatter',
  description: "Update a single frontmatter field to the same value across multiple notes at once. Use when John wants to bulk-update status, project, or any frontmatter field.",
  inputSchema: {
    paths: z.array(z.string()).describe("Array of full note paths to update"),
    field: z.string().describe("Frontmatter field name to update, e.g. 'status'"),
    value: z.string().describe("New value for the field, e.g. 'archived'")
  }
}, async ({ paths, field, value }) => {
  const results: string[] = [];
  for (const notePath of paths) {
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (!readResponse.ok) { results.push(`❌ Not found: ${notePath}`); continue; }
    let noteContent = await readResponse.text();

    const regex = new RegExp(`^(${field}:\\s*)(.+)$`, "m");
    if (!regex.test(noteContent)) { results.push(`⚠️ Field "${field}" not found: ${notePath}`); continue; }
    noteContent = noteContent.replace(regex, `$1${value}`);

    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: noteContent,
    });
    results.push(writeResponse.ok ? `✅ Updated: ${notePath}` : `❌ Failed to write: ${notePath}`);
  }
  // Update INDEX for each affected note
  for (const notePath of paths) {
    try {
      const batchRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      });
      if (batchRes.ok) {
        const batchContent = await batchRes.text();
        const fmMatch = batchContent.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const getField = (name: string) => {
            const m = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
            return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
          };
          const batchFilename = notePath.split('/').pop() || '';
          const batchFolder = notePath.substring(0, notePath.lastIndexOf('/') + 1);
          const tags = fm.match(/^tags:\s*\[([^\]]*)\]/m);
          const tagStr = tags ? tags[1].replace(/\s/g, '') : '';
          updateVaultIndex('update', batchFolder, batchFilename, {
            type: getField('type') || getField('artifact_type'),
            purpose: getField('purpose'),
            status: getField('status'),
            tags: tagStr
          }).catch(() => {});
        }
      }
    } catch {
      // INDEX update failed silently for this note
    }
  }
  return { content: [{ type: "text", text: results.join("\n") }] };
})

server.registerTool('clean_note_structure', {
  title: 'Clean Note Structure',
  description: "Fix duplicate '## Related' sections in a note by consolidating all wikilinks into one deduplicated Related block at the end. Use when a note has scattered or repeated Related sections.",
  inputSchema: {
    path: z.string().describe("Full path to the note to clean, e.g. '01-projects/sigyls/2026-03-01-my-note.md'")
  }
}, async ({ path }) => {
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] };
  const noteContent = (await readResponse.text()).replace(/\r\n/g, '\n');

  const relatedSectionRegex = /## Related\n([\s\S]*?)(?=\n## |$)/g;
  const wikilinks = new Set<string>();
  let sectionCount = 0;
  let match;
  while ((match = relatedSectionRegex.exec(noteContent)) !== null) {
    sectionCount++;
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    let wlMatch;
    while ((wlMatch = wikilinkRegex.exec(match[1])) !== null) {
      wikilinks.add(`[[${wlMatch[1]}]]`);
    }
  }

  if (sectionCount <= 1) {
    return { content: [{ type: "text", text: `ℹ️ Only ${sectionCount} Related section found — nothing to clean in: ${path}` }] };
  }

  const cleaned = noteContent.replace(/\n## Related\n[\s\S]*?(?=\n## |$)/g, '');
  const deduped = [...wikilinks];
  const updated = cleaned.trimEnd() + '\n\n## Related\n' + (deduped.length ? deduped.join('\n') + '\n' : '');

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: updated,
  });

  return {
    content: [{ type: "text", text: writeResponse.ok
      ? `✅ Cleaned: ${path}\n  ${sectionCount} Related sections → 1\n  ${deduped.length} unique wikilink${deduped.length !== 1 ? 's' : ''} preserved`
      : `❌ Failed to write cleaned note` }]
  };
})

server.registerTool('create_folder', {
  title: 'Create Folder',
  description: "Create a new folder in John's Obsidian vault by placing a .gitkeep.md placeholder file inside it (since folders are created implicitly by file creation).",
  inputSchema: {
    folder_path: z.string().describe("Full folder path to create, e.g. '01-projects/new-folder'")
  }
}, async ({ folder_path }) => {
  const cleanPath = folder_path.replace(/\/+$/, '')
  const placeholderPath = `${cleanPath}/.gitkeep.md`
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(placeholderPath)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: "",
  })
  if (response.ok) {
    updateVaultIndexSection('create', folder_path.endsWith('/') ? folder_path : folder_path + '/').catch(() => {});
  }
  return {
    content: [{ type: "text", text: response.ok
      ? `✅ Created folder: ${cleanPath}`
      : `❌ Failed to create folder: ${cleanPath}` }]
  }
})

server.registerTool('delete_folder', {
  title: 'Delete Folder',
  description: "Delete a folder and its contents from John's Obsidian vault. Requires force=true if the folder is non-empty. Note: the empty folder itself may remain on disk since the API cannot delete folders directly.",
  inputSchema: {
    folder_path: z.string().describe("Full folder path to delete, e.g. '01-projects/old-folder'"),
    force: z.boolean().default(false).describe("Set to true to delete even if the folder has contents")
  }
}, async ({ folder_path, force }) => {
  const cleanPath = folder_path.replace(/\/+$/, '')
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanPath)}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!listResponse.ok) {
    return { content: [{ type: "text", text: `❌ Folder not found: ${cleanPath}` }] }
  }
  const listing = await listResponse.json()
  const files: string[] = listing.files ?? []
  if (files.length > 0 && !force) {
    const fileList = files.map(f => `  - ${f}`).join('\n')
    return {
      content: [{ type: "text", text: `⚠️ Folder is non-empty (${files.length} file${files.length !== 1 ? 's' : ''}):\n${fileList}\n\nRe-run with force=true to delete all contents.` }]
    }
  }
  const results: string[] = []
  for (const file of files) {
    const delResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanPath)}/${encodedVaultPath(file)}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    results.push(delResponse.ok ? `✅ Deleted: ${file}` : `❌ Failed to delete: ${file}`)
  }
  const summary = results.length > 0 ? results.join('\n') + '\n' : ''
  updateVaultIndexSection('remove', folder_path.endsWith('/') ? folder_path : folder_path + '/').catch(() => {});
  return {
    content: [{ type: "text", text: `${summary}🗑️ ${results.length} file${results.length !== 1 ? 's' : ''} deleted from ${cleanPath}\nNote: empty folder may remain on disk — the API cannot delete folders directly.` }]
  }
})

server.registerTool('rename_folder', {
  title: 'Rename Folder',
  description: "Rename a folder in place in John's Obsidian vault by moving all its contents to a new folder name in the same parent directory.",
  inputSchema: {
    folder_path: z.string().describe("Full current folder path, e.g. '01-projects/old-name'"),
    new_name: z.string().describe("New folder name only (no path), e.g. 'new-name'")
  }
}, async ({ folder_path, new_name }) => {
  const cleanPath = folder_path.replace(/\/+$/, '')
  const parent = cleanPath.substring(0, cleanPath.lastIndexOf('/'))
  const newPath = parent ? `${parent}/${new_name}` : new_name
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanPath)}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!listResponse.ok) {
    return { content: [{ type: "text", text: `❌ Folder not found: ${cleanPath}` }] }
  }
  const listing = await listResponse.json()
  const files: string[] = listing.files ?? []
  const results: string[] = []
  for (const file of files) {
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanPath)}/${encodedVaultPath(file)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!readResponse.ok) { results.push(`❌ Failed to read: ${file}`); continue }
    const content = await readResponse.text()
    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(newPath)}/${encodedVaultPath(file)}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: content,
    })
    if (!writeResponse.ok) { results.push(`❌ Failed to write: ${file}`); continue }
    const delResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanPath)}/${encodedVaultPath(file)}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    results.push(delResponse.ok ? `✅ ${file}` : `⚠️ Copied but failed to delete: ${file}`)
  }
  const summary = results.length > 0 ? '\n' + results.join('\n') : ' (empty folder)'
  const oldFolderSection = folder_path.endsWith('/') ? folder_path : folder_path + '/';
  const parentDir = folder_path.substring(0, folder_path.lastIndexOf('/') + 1);
  const newFolderSection = parentDir + new_name + '/';
  updateVaultIndexSection('rename', oldFolderSection, newFolderSection).catch(() => {});
  return {
    content: [{ type: "text", text: `✅ Renamed: ${cleanPath} → ${newPath}\nMoved ${files.length} file${files.length !== 1 ? 's' : ''}${summary}` }]
  }
})

server.registerTool('move_folder', {
  title: 'Move Folder',
  description: "Move a folder and all its contents to a new location in John's Obsidian vault.",
  inputSchema: {
    source_path: z.string().describe("Full source folder path, e.g. '01-projects/old-location/my-folder'"),
    destination_path: z.string().describe("Full destination folder path, e.g. '02-areas/my-folder'")
  }
}, async ({ source_path, destination_path }) => {
  const cleanSource = source_path.replace(/\/+$/, '')
  const cleanDest = destination_path.replace(/\/+$/, '')
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanSource)}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!listResponse.ok) {
    return { content: [{ type: "text", text: `❌ Folder not found: ${cleanSource}` }] }
  }
  const listing = await listResponse.json()
  const files: string[] = listing.files ?? []
  const results: string[] = []
  for (const file of files) {
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanSource)}/${encodedVaultPath(file)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!readResponse.ok) { results.push(`❌ Failed to read: ${file}`); continue }
    const content = await readResponse.text()
    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanDest)}/${encodedVaultPath(file)}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: content,
    })
    if (!writeResponse.ok) { results.push(`❌ Failed to write: ${file}`); continue }
    const delResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(cleanSource)}/${encodedVaultPath(file)}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    results.push(delResponse.ok ? `✅ ${file}` : `⚠️ Copied but failed to delete: ${file}`)
  }
  const summary = results.length > 0 ? '\n' + results.join('\n') : ' (empty folder)'
  const oldMoveSection = source_path.endsWith('/') ? source_path : source_path + '/';
  const newMoveSection = destination_path.endsWith('/') ? destination_path : destination_path + '/';
  updateVaultIndexSection('rename', oldMoveSection, newMoveSection).catch(() => {});
  return {
    content: [{ type: "text", text: `✅ Moved: ${cleanSource} → ${cleanDest}\nMoved ${files.length} file${files.length !== 1 ? 's' : ''}${summary}` }]
  }
})

server.registerTool('vault_health_check', {
  title: 'Vault Health Check',
  description: "Scan John's entire Obsidian vault and return a structured health report identifying: missing project frontmatter, duplicate Related sections, phantom folders (folder names that look like dated note titles), notes filed in wrong project folders, and sparse notes with minimal content.",
  inputSchema: {
    purge_stale_embeddings: z.boolean().optional().describe("When true, delete all stale embedding rows after detection. Default: false.")
  }
}, async ({ purge_stale_embeddings = false }) => {
  const allNotes = await getAllVaultNotes()

  const missingProject: string[] = []
  const duplicateRelated: { path: string, count: number }[] = []
  const phantomFolders = new Set<string>()
  const wrongFolder: { path: string, project: string, expected: string }[] = []
  const sparseNotes: string[] = []
  const zeroLinks: string[] = []
  const brokenRelated: string[] = []

  const projectFolderMap: Record<string, string> = {
    'sono': '01-projects/sono',
    'dallas-tub-fix': '01-projects/dallas-tub-fix',
    'sigyls': '01-projects/sigyls',
    'sanctum': '01-projects/sanctum',
    'turnkey': '01-projects/turnkey',
    'personal': '02-areas/personal',
    'finance': '02-areas/finance',
    'family': '02-areas/family',
  }

  for (const notePath of allNotes) {
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!res.ok) continue
    const content = await res.text()

    // a. Missing/empty project frontmatter
    const projectMatch = content.match(/^project:\s*(.*)$/m)
    if (!projectMatch || !projectMatch[1].trim()) {
      missingProject.push(notePath)
    }

    // b. Duplicate Related sections
    const relatedCount = (content.match(/^## Related/gm) || []).length
    if (relatedCount > 1) {
      duplicateRelated.push({ path: notePath, count: relatedCount })
    }

    // c. Phantom folders — any folder segment looks like a dated note title
    const folder = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : ''
    if (folder) {
      for (const seg of folder.split('/')) {
        if (/\d{4}-/.test(seg)) {
          phantomFolders.add(folder)
          break
        }
      }
    }

    // d. Notes in wrong folders
    const projMatch = content.match(/^project:\s*(.+)$/m)
    if (projMatch) {
      const proj = projMatch[1].trim()
      const expectedFolder = projectFolderMap[proj]
      if (expectedFolder && !notePath.startsWith(expectedFolder)) {
        wrongFolder.push({ path: notePath, project: proj, expected: expectedFolder })
      }
    }

    // e. Sparse notes — body after frontmatter is less than 100 chars
    const parts = content.split(/^---\s*$/m)
    const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : content.trim()
    if (body.length < 100) {
      sparseNotes.push(notePath)
    }

    // f. Zero outbound wikilinks — body has no [[...]] at all
    const filename = notePath.substring(notePath.lastIndexOf('/') + 1)
    const isLinklessByDesign = (
      filename === 'staging.md' ||
      filename.startsWith('tca-duties') ||
      /^\d{4}-\d{2}-\d{2}-.*task.*\.md$/.test(filename)
    )
    if (!isLinklessByDesign && !sparseNotes.includes(notePath) && !/\[\[/.test(body)) {
      zeroLinks.push(notePath)
    }

    // g. Broken Related placeholder — "## Related\n- " with nothing meaningful after the hyphen
    if (/^## Related\s*\n- \s*$/m.test(content)) {
      brokenRelated.push(notePath)
    }
  }

  const staleEmbeddings: string[] = []
  const { data: embeddingRows } = await supabase
    .from('note_embeddings')
    .select('path')
  if (embeddingRows) {
    const vaultSet = new Set(allNotes)
    for (const row of embeddingRows) {
      if (!vaultSet.has(row.path)) {
        staleEmbeddings.push(row.path)
      }
    }
  }

  const sections: string[] = [`🔍 Vault Health Report — ${allNotes.length} notes scanned`]

  sections.push(`\n## Missing/Empty Project Frontmatter (${missingProject.length})`)
  sections.push(missingProject.length ? missingProject.map(p => `  - ${p}`).join('\n') : '  ✅ None')

  sections.push(`\n## Duplicate Related Sections (${duplicateRelated.length})`)
  sections.push(duplicateRelated.length ? duplicateRelated.map(d => `  - ${d.path} (${d.count} sections)`).join('\n') : '  ✅ None')

  sections.push(`\n## Phantom Folders (${phantomFolders.size})`)
  sections.push(phantomFolders.size ? [...phantomFolders].map(f => `  - ${f}`).join('\n') : '  ✅ None')

  sections.push(`\n## Notes in Wrong Folders (${wrongFolder.length})`)
  sections.push(wrongFolder.length ? wrongFolder.map(w => `  - ${w.path} (project: ${w.project} → expected ${w.expected}/)`).join('\n') : '  ✅ None')

  sections.push(`\n## Sparse Notes <100 chars (${sparseNotes.length})`)
  sections.push(sparseNotes.length ? sparseNotes.map(p => `  - ${p}`).join('\n') : '  ✅ None')

  sections.push(`\n## Zero Outbound Wikilinks (${zeroLinks.length})`)
  sections.push(zeroLinks.length ? zeroLinks.map(p => `  - ${p}`).join('\n') : '  ✅ None')

  sections.push(`\n## Broken Related Placeholder (${brokenRelated.length})`)
  sections.push(brokenRelated.length ? brokenRelated.map(p => `  - ${p}`).join('\n') : '  ✅ None')

  sections.push(`\n## Stale Embedding Paths (${staleEmbeddings.length})`)
  sections.push(staleEmbeddings.length ? staleEmbeddings.map(p => `  - ${p}`).join('\n') : '  ✅ None')

  if (purge_stale_embeddings && staleEmbeddings.length > 0) {
    const { error: purgeError } = await supabase
      .from('note_embeddings')
      .delete()
      .in('path', staleEmbeddings)
    if (purgeError) {
      sections.push(`\n## Purge Result\n  ❌ Failed to delete stale embeddings: ${purgeError.message}`)
    } else {
      sections.push(`\n## Purge Result\n  ✅ Deleted ${staleEmbeddings.length} stale embedding row(s)`)
    }
  }

  return { content: [{ type: "text", text: sections.join('\n') }] }
})

server.registerTool('get_project_brief', {
  title: 'Get Project Brief',
  description: "Read a project's status note and return a structured briefing with current state, decisions, and next steps.",
  inputSchema: {
    project: z.string().describe("Project name: sigyls, dallas-tub-fix, sanctum, sono, turnkey, or other project folder name")
  }
}, async ({ project }) => {
  const folderPath = `01-projects/${project}`
  const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath)}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!listRes.ok) {
    return { content: [{ type: "text", text: `❌ Project folder not found: ${folderPath}` }] }
  }
  const data = await listRes.json()
  const statusFile = (data.files || [])
    .filter((f: string) => f.toLowerCase().includes('status') && f.endsWith('.md'))
    .sort()
    .reverse()[0]
  if (!statusFile) {
    return { content: [{ type: "text", text: `ℹ️ No status note found for project: ${project}` }] }
  }
  const notePath = `${folderPath}/${statusFile}`
  const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!noteRes.ok) {
    return { content: [{ type: "text", text: `❌ Could not read status note: ${notePath}` }] }
  }
  const content = await noteRes.text()
  const dateMatch = content.match(/^(?:updated|created|date):\s*(.+)$/m)
  const lastModified = dateMatch ? dateMatch[1].trim() : 'unknown'
  return {
    content: [{ type: "text", text: `# Project Brief: ${project}\n📄 ${notePath}\n🕐 Last modified: ${lastModified}\n\n${content}` }]
  }
})

server.registerTool('update_project_status', {
  title: 'Update Project Status',
  description: "Write or rewrite a project's status note. Use at the end of a work session to record current state, decisions, and next steps. Replaces any existing status file (including dated variants) with a clean status.md.",
  inputSchema: {
    project: z.string().describe("Project name: sigyls, dallas-tub-fix, sanctum, sono, turnkey"),
    content: z.string().describe("Full content of the status note to write")
  }
}, async ({ project, content }) => {
  const folderPath = `01-projects/${project}`
  const targetPath = `${folderPath}/status.md`

  // Find and delete any existing status file at a different path
  const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath)}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (listRes.ok) {
    const data = await listRes.json()
    const existingStatus = (data.files || [])
      .filter((f: string) => f.toLowerCase().includes('status') && f.endsWith('.md'))
      .sort()
      .reverse()[0]
    if (existingStatus && existingStatus !== 'status.md') {
      await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath)}/${encodedVaultPath(existingStatus)}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      })
    }
  }

  const relatedLinks: Record<string, string[]> = {
    sigyls: ['[[sigyls-foundry-workshop-framework-suite-v10]]', '[[sigyls-foundry-workshop-framework-suite-v11]]'],
    'dallas-tub-fix': ['[[cipher-agent-production]]'],
    sanctum: ['[[sanctum-master-build-reference--complete-state]]'],
    sono: ['[[sono-ai-agent-ecosystem]]'],
    turnkey: ['[[turnkey-foundry-timeline]]'],
  }
  const links = relatedLinks[project]
  if (links && !content.includes('## Related')) {
    content = content.trimEnd() + '\n\n## Related\n' + links.map(l => `- ${l}`).join('\n') + '\n'
  }

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(targetPath)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content,
  })
  if (writeRes.ok) {
    updateVaultIndex('update', `01-projects/${project}/`, 'status.md', { type: 'status', purpose: 'Current project status and next steps', status: 'active', tags: `${project}/status` }).catch(() => {});
  }
  return {
    content: [{ type: "text", text: writeRes.ok
      ? `✅ Status updated: ${targetPath}`
      : `❌ Failed to write status note for project: ${project}` }]
  }
})

// ─── Task system helpers ───────────────────────────────────────────────────

function extractSection(content: string, header: string): { lines: string[], startIdx: number, endIdx: number } {
  const lines = content.split('\n')
  const startIdx = lines.findIndex(l => l.trim() === `## ${header}`)
  if (startIdx === -1) return { lines: [], startIdx: -1, endIdx: -1 }
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break }
  }
  return { lines: lines.slice(startIdx + 1, endIdx), startIdx, endIdx }
}

function insertIntoSection(content: string, header: string, newLine: string): string {
  const allLines = content.split('\n')
  const { startIdx, endIdx } = extractSection(content, header)
  if (startIdx === -1) return content.trimEnd() + `\n\n## ${header}\n${newLine}\n`
  allLines.splice(endIdx, 0, newLine)
  return allLines.join('\n')
}

// ─── Task system tools ─────────────────────────────────────────────────────

server.registerTool('generate_daily_note', {
  title: 'Generate Daily Note',
  description: "Assemble today's task list from the staging backlog, TCA duties, and personal items. If no backlog items are selected, returns the staging backlog for John to choose from before generating the note.",
  inputSchema: {
    selected_backlog: z.array(z.string()).optional().describe("Specific staging backlog items to include today. If omitted, returns the backlog for selection.")
  }
}, async ({ selected_backlog }) => {
  const [stagingRes, tcaRes, personalRes] = await Promise.all([
    fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/staging.md`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
    fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/tca-duties.md`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
    fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/personal.md`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
  ])
  if (!stagingRes.ok) return { content: [{ type: "text", text: "❌ Could not read 02-areas/tasks/staging.md" }] }
  if (!tcaRes.ok) return { content: [{ type: "text", text: "❌ Could not read 02-areas/tasks/tca-duties.md" }] }
  if (!personalRes.ok) return { content: [{ type: "text", text: "❌ Could not read 02-areas/tasks/personal.md" }] }

  const [stagingContent, tcaContent, personalContent] = await Promise.all([
    stagingRes.text(), tcaRes.text(), personalRes.text()
  ])

  // Early return: no items selected — return backlog for John to pick from
  if (!selected_backlog || selected_backlog.length === 0) {
    const { lines } = extractSection(stagingContent, 'Backlog')
    const backlogItems = lines.filter(l => l.trim().startsWith('- '))
    return {
      content: [{
        type: "text",
        text: `📋 Staging Backlog — which items do you want in today's note?\n\n${backlogItems.join('\n') || '(empty)'}\n\nCall generate_daily_note again with selected_backlog listing the items to include.`
      }]
    }
  }

  const today = new Date().toISOString().split('T')[0]
  const dayOfWeek = new Date().getDay() // 0=Sun, 1=Mon
  const dayOfMonth = new Date().getDate()

  // Staging section — strip any existing checkbox prefix before re-adding
  const stagingLines = selected_backlog.map(item => `- [ ] ${item.replace(/^- \[[ x]\] /i, '')}`)

  // TCA duties: always daily, weekly on Monday, monthly on 1st
  const tcaDailyLines = extractSection(tcaContent, 'Daily').lines.filter(l => l.trim().startsWith('- '))
  const tcaWeeklyLines = dayOfWeek === 1 ? extractSection(tcaContent, 'Weekly').lines.filter(l => l.trim().startsWith('- ')) : []
  const tcaMonthlyLines = dayOfMonth === 1 ? extractSection(tcaContent, 'Monthly').lines.filter(l => l.trim().startsWith('- ')) : []
  const tcaLines = [...tcaDailyLines, ...tcaWeeklyLines, ...tcaMonthlyLines]

  // Personal upcoming items — skip placeholder lines
  const personalLines = extractSection(personalContent, 'Upcoming').lines
    .filter(l => l.trim() && l.trim() !== '(empty)')

  const note = `---
type: daily-tasks
status: active
tags: [tasks/daily]
created: ${today}
project: sanctum
---

# Daily Tasks — ${today}

## From Staging Backlog
${stagingLines.length ? stagingLines.join('\n') : '(none selected)'}

## TCA Duties
${tcaLines.length ? tcaLines.join('\n') : '(none for today)'}

## Personal
${personalLines.length ? personalLines.join('\n') : '(none)'}

## Notes
`

  const fileName = `00-inbox/${today}-daily-tasks.md`
  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(fileName)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: note,
  })
  if (writeRes.ok) {
    updateVaultIndex('add', '00-inbox/', `${today}-daily-tasks.md`, { type: 'task-note', purpose: 'Daily task list', status: 'active', tags: 'tasks/daily' }).catch(() => {});
  }

  return {
    content: [{
      type: "text",
      text: writeRes.ok
        ? `✅ Daily note created: ${fileName}\n\n${note}`
        : `❌ Failed to save daily note`
    }]
  }
})

server.registerTool('archive_task_note', {
  title: 'Archive Task Note',
  description: "Archive a daily task note to 04-archive/tasks/. Checks for unchecked items first and returns them for resolution before archiving.",
  inputSchema: {
    date: z.string().optional().describe("Date of the daily note to archive (YYYY-MM-DD). Defaults to today.")
  }
}, async ({ date }) => {
  const targetDate = date || new Date().toISOString().split('T')[0]

  const candidates = [
    `00-inbox/${targetDate}-daily-tasks.md`,
    `01-projects/sanctum/${targetDate}-daily-tasks.md`,
  ]

  let sourcePath = ''
  let noteContent = ''
  for (const p of candidates) {
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(p)}`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } })
    if (res.ok) { sourcePath = p; noteContent = await res.text(); break }
  }

  if (!sourcePath) {
    return { content: [{ type: "text", text: `❌ Daily note not found for ${targetDate}\nChecked:\n  - ${candidates.join('\n  - ')}` }] }
  }

  const unchecked = noteContent.split('\n').filter(l => /^- \[ \]/.test(l.trim()))
  if (unchecked.length > 0) {
    return {
      content: [{
        type: "text",
        text: `⚠️ ${unchecked.length} unchecked item${unchecked.length !== 1 ? 's' : ''} in ${sourcePath}:\n\n${unchecked.join('\n')}\n\nResolve these first, then call archive_task_note again.`
      }]
    }
  }

  const updated = noteContent.replace(/^(status:\s*)(.+)$/m, '$1archived')
  const archivePath = `04-archive/tasks/${targetDate}-daily-tasks.md`

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(archivePath)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: updated,
  })
  if (!writeRes.ok) return { content: [{ type: "text", text: `❌ Failed to write archive: ${archivePath}` }] }

  const deleteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(sourcePath)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })

  const completed = (noteContent.match(/^- \[x\]/gim) || []).length

  const archiveSrcFilename = sourcePath.split('/').pop() || '';
  const archiveSrcFolder = sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1);
  updateVaultIndex('remove', archiveSrcFolder, archiveSrcFilename).catch(() => {});
  updateVaultIndex('add', '04-archive/tasks/', archiveSrcFilename, { type: 'task-note', purpose: 'Archived daily task note', status: 'archived', tags: '' }).catch(() => {});

  return {
    content: [{
      type: "text",
      text: deleteRes.ok
        ? `✅ Archived: ${sourcePath} → ${archivePath}\n  ${completed} completed task${completed !== 1 ? 's' : ''} preserved`
        : `⚠️ Copied to ${archivePath} but failed to delete original: ${sourcePath}`
    }]
  }
})

server.registerTool('get_tasks', {
  title: 'Get Tasks',
  description: "Return tasks filtered by scope: today's tasks, this week, this month, or all task files.",
  inputSchema: {
    scope: z.string().describe("Scope: 'today', 'week', 'month', or 'all'")
  }
}, async ({ scope }) => {
  const today = new Date().toISOString().split('T')[0]

  const stagingRes = await fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/staging.md`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  const stagingContent = stagingRes.ok ? await stagingRes.text() : ''
  const stagingBacklog = stagingRes.ok
    ? extractSection(stagingContent, 'Backlog').lines.filter(l => l.trim().startsWith('- ')).join('\n') || '(empty)'
    : '(unavailable)'

  if (scope === 'today') {
    const dailyRes = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${today}-daily-tasks.md`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    const dailyContent = dailyRes.ok ? await dailyRes.text() : null
    return {
      content: [{
        type: "text",
        text: `## Staging Backlog\n${stagingBacklog}\n\n## Today's Daily Note (${today})\n${dailyContent || '(no daily note yet — run generate_daily_note)'}`
      }]
    }
  }

  if (scope === 'week' || scope === 'month') {
    const now = new Date()
    let rangeStart: Date
    if (scope === 'week') {
      rangeStart = new Date(now)
      const day = rangeStart.getDay()
      rangeStart.setDate(rangeStart.getDate() - (day === 0 ? 6 : day - 1))
    } else {
      rangeStart = new Date(now.getFullYear(), now.getMonth(), 1)
    }

    const [inboxRes, archiveRes] = await Promise.all([
      fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
      fetch(`${OBSIDIAN_API_URL}/vault/04-archive/tasks/`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
    ])
    const inboxFiles: string[] = inboxRes.ok ? ((await inboxRes.json()).files || []) : []
    const archiveFiles: string[] = archiveRes.ok ? ((await archiveRes.json()).files || []) : []

    const candidates = [
      ...inboxFiles.map(f => ({ file: f, folder: '00-inbox' })),
      ...archiveFiles.map(f => ({ file: f, folder: '04-archive/tasks' })),
    ]

    const dailyNotePaths = candidates
      .filter(({ file }) => /^\d{4}-\d{2}-\d{2}-daily-tasks\.md$/.test(file))
      .filter(({ file }) => {
        const fileDate = new Date(file.slice(0, 10))
        return fileDate >= rangeStart && fileDate <= now
      })
      .map(({ file, folder }) => ({ path: `${folder}/${file}`, date: file.slice(0, 10) }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const summaryLines: string[] = []
    for (const { path, date } of dailyNotePaths) {
      const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } })
      if (!res.ok) continue
      const content = await res.text()
      const completed = (content.match(/^- \[x\]/gim) || []).length
      const pending = (content.match(/^- \[ \]/gm) || []).length
      summaryLines.push(`  ${date}: ${completed} done, ${pending} pending`)
    }

    return {
      content: [{
        type: "text",
        text: `## Staging Backlog\n${stagingBacklog}\n\n## ${scope === 'week' ? 'This Week' : 'This Month'} (${dailyNotePaths.length} daily note${dailyNotePaths.length !== 1 ? 's' : ''})\n${summaryLines.join('\n') || '  (none found)'}`
      }]
    }
  }

  if (scope === 'all') {
    const [tcaRes, personalRes, dailyRes] = await Promise.all([
      fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/tca-duties.md`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
      fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/personal.md`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
      fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${today}-daily-tasks.md`, { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }),
    ])
    const tcaContent = tcaRes.ok ? await tcaRes.text() : '(unavailable)'
    const personalContent = personalRes.ok ? await personalRes.text() : '(unavailable)'
    const dailyContent = dailyRes.ok ? await dailyRes.text() : '(no daily note today)'

    return {
      content: [{
        type: "text",
        text: `## Staging Backlog\n${stagingBacklog}\n\n## TCA Duties\n${tcaContent}\n\n## Personal\n${personalContent}\n\n## Today's Daily Note (${today})\n${dailyContent}`
      }]
    }
  }

  return { content: [{ type: "text", text: `❌ Unknown scope: "${scope}". Use 'today', 'week', 'month', or 'all'.` }] }
})

server.registerTool('add_task', {
  title: 'Add Task',
  description: "Add a new task to the staging backlog, personal list, today's daily note, or TCA duties.",
  inputSchema: {
    task: z.string().describe("The task text to add"),
    destination: z.string().describe("Where to add it: 'staging', 'personal', 'daily', 'tca-daily', 'tca-weekly', 'tca-monthly'")
  }
}, async ({ task, destination }) => {
  const today = new Date().toISOString().split('T')[0]
  const destinationMap: Record<string, { file: string, section: string }> = {
    'staging':     { file: '02-areas/tasks/staging.md',   section: 'Backlog' },
    'personal':    { file: '02-areas/tasks/personal.md',  section: 'Upcoming' },
    'daily':       { file: `00-inbox/${today}-daily-tasks.md`, section: 'Notes' },
    'tca-daily':   { file: '02-areas/tasks/tca-duties.md', section: 'Daily' },
    'tca-weekly':  { file: '02-areas/tasks/tca-duties.md', section: 'Weekly' },
    'tca-monthly': { file: '02-areas/tasks/tca-duties.md', section: 'Monthly' },
  }

  const target = destinationMap[destination]
  if (!target) {
    return { content: [{ type: "text", text: `❌ Unknown destination: "${destination}". Use: staging, personal, daily, tca-daily, tca-weekly, tca-monthly` }] }
  }

  const readRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(target.file)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!readRes.ok) {
    const hint = destination === 'daily' ? ' — run generate_daily_note first' : ''
    return { content: [{ type: "text", text: `❌ File not found: ${target.file}${hint}` }] }
  }
  const content = await readRes.text()
  const updated = insertIntoSection(content, target.section, `- [ ] ${task}`)

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(target.file)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: updated,
  })

  return {
    content: [{ type: "text", text: writeRes.ok
      ? `✅ Added to ${destination}: ${task}`
      : `❌ Failed to write to ${target.file}` }]
  }
})

server.registerTool('complete_task', {
  title: 'Complete Task',
  description: "Mark a task as done in a vault note by replacing '- [ ]' with '- [x]' on the matching line.",
  inputSchema: {
    path: z.string().describe("Full path to the note, e.g. '00-inbox/2026-03-09-daily-tasks.md'"),
    task_text: z.string().describe("Text of the task to mark complete (partial match, case-insensitive)")
  }
}, async ({ path, task_text }) => {
  const readRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!readRes.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] }
  const content = await readRes.text()

  const lines = content.split('\n')
  const lowerTask = task_text.toLowerCase()
  const matchIdx = lines.findIndex(l => l.includes('- [ ]') && l.toLowerCase().includes(lowerTask))
  if (matchIdx === -1) {
    return { content: [{ type: "text", text: `❌ Unchecked task not found matching: "${task_text}" in ${path}` }] }
  }

  const matchedLine = lines[matchIdx]
  lines[matchIdx] = matchedLine.replace('- [ ]', '- [x]')

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(path)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: lines.join('\n'),
  })

  return {
    content: [{ type: "text", text: writeRes.ok
      ? `✅ Completed: ${matchedLine.trim()}`
      : `❌ Failed to write to ${path}` }]
  }
})

server.registerTool('update_staging', {
  title: 'Update Staging',
  description: "Manage the staging backlog directly: list current items, add a new item, or remove an existing one.",
  inputSchema: {
    action: z.string().describe("Action: 'list', 'add', or 'remove'"),
    task: z.string().optional().describe("Task text — required for add/remove")
  }
}, async ({ action, task }) => {
  const filePath = '02-areas/tasks/staging.md'
  const readRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(filePath)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!readRes.ok) return { content: [{ type: "text", text: `❌ Could not read ${filePath}` }] }
  const content = await readRes.text()

  if (action === 'list') {
    const { lines } = extractSection(content, 'Backlog')
    return { content: [{ type: "text", text: `## Backlog\n${lines.join('\n') || '(empty)'}` }] }
  }

  if (!task) {
    return { content: [{ type: "text", text: `❌ 'task' parameter is required for action: ${action}` }] }
  }

  let updated: string
  if (action === 'add') {
    updated = insertIntoSection(content, 'Backlog', `- [ ] ${task}`)
  } else if (action === 'remove') {
    const { startIdx, endIdx } = extractSection(content, 'Backlog')
    if (startIdx === -1) return { content: [{ type: "text", text: `❌ ## Backlog section not found in ${filePath}` }] }
    const lines = content.split('\n')
    const lowerTask = task.toLowerCase()
    const matchIdx = lines.findIndex((l, i) => i > startIdx && i < endIdx && l.toLowerCase().includes(lowerTask))
    if (matchIdx === -1) return { content: [{ type: "text", text: `❌ Task not found in backlog: "${task}"` }] }
    lines.splice(matchIdx, 1)
    updated = lines.join('\n')
  } else {
    return { content: [{ type: "text", text: `❌ Unknown action: "${action}". Use 'list', 'add', or 'remove'.` }] }
  }

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(filePath)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: updated,
  })
  if (!writeRes.ok) return { content: [{ type: "text", text: `❌ Failed to write ${filePath}` }] }

  const { lines: newLines } = extractSection(updated, 'Backlog')
  return {
    content: [{ type: "text", text: `✅ ${action === 'add' ? 'Added' : 'Removed'}: ${task}\n\n## Backlog\n${newLines.join('\n') || '(empty)'}` }]
  }
})

server.registerTool('get_youtube_transcript', {
  title: 'Get YouTube Transcript',
  description: "Fetch the transcript of a YouTube video by URL. Use when John pastes a YouTube link and wants to analyze, discuss, or extract insights from the video content.",
  inputSchema: {
    url: z.string().describe("The YouTube video URL, e.g. https://youtu.be/abc123 or https://www.youtube.com/watch?v=abc123")
  }
}, async ({ url }) => {
  const response = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(url)}&text=true`, {
    headers: {
      "x-api-key": SUPADATA_API_KEY
    }
  });
  if (!response.ok) {
    return { content: [{ type: "text", text: `❌ Failed to fetch transcript: ${response.status} ${response.statusText}` }] };
  }
  const data = await response.json();
  const transcript = data.content || data.transcript || data.text || JSON.stringify(data);
  return {
    content: [{ type: "text", text: `✅ Transcript fetched\n\n${transcript}` }]
  };
})

server.registerTool('load_session_context', {
  title: 'Load Session Context',
  description: "Load full session context: vault manifest (base orientation + optional project deep-load) plus Phase 1/2 knowledge tables (hot_context, session_log, decisions, recurring_questions). Called at the start of any session with 'load context' or 'load context [project]'. Performs TTL eviction on expired hot_context rows before serving. Returns base orientation, hot context, last session summary, open threads, recent decisions, flagged conflicts, recurring questions, all project briefs, and — when a project is given — project deep-load notes plus dead-end memory for that project.",
  inputSchema: {
    project: z.string().optional().describe("Optional project name for deep-loading: sigyls, turnkey, dallas-tub-fix, sanctum, sono, iconic-roofing")
  }
}, async ({ project }) => {
  const today = new Date().toISOString().split('T')[0]
  const nowIso = new Date().toISOString()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  // ─── TTL eviction (schema contract: clean before serving) ───────────────
  await supabase
    .from('hot_context')
    .delete()
    .not('expires_at', 'is', null)
    .lt('expires_at', nowIso)

  // ─── Manifest fetch (file-based, unchanged) ─────────────────────────────
  const manifestPath = '00-system/context-manifest.md'
  const manifestRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(manifestPath)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  let manifestContent: string
  if (!manifestRes.ok) {
    const githubManifest = await readNoteFromGitHub(manifestPath)
    if (!githubManifest) {
      return { content: [{ type: "text", text: `❌ Manifest not found at ${manifestPath}` }] }
    }
    manifestContent = githubManifest
  } else {
    manifestContent = await manifestRes.text()
  }

  function parseManifestSection(content: string, sectionName: string): string[] {
    const lines = content.split('\n')
    const startIdx = lines.findIndex(l => l.trim() === `## ${sectionName}`)
    if (startIdx === -1) return []
    const paths: string[] = []
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith('## ')) break
      if (line.endsWith('.md') && !line.startsWith('#') && !line.startsWith('(')) {
        paths.push(line)
      }
    }
    return paths
  }

  const basePaths = parseManifestSection(manifestContent, 'base')
  const projectPaths = project ? parseManifestSection(manifestContent, project) : []

  async function fetchManifestNote(notePath: string): Promise<string> {
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!res.ok) {
      const githubText = await readNoteFromGitHub(notePath)
      if (!githubText) return `\n\n---\n⚠️ Could not load: ${notePath}\n---`
      return `\n\n---\n## ${notePath}\n\n${githubText}\n*(via GitHub fallback)*`
    }
    return `\n\n---\n## ${notePath}\n\n${await res.text()}`
  }

  const allProjects = ['dallas-tub-fix', 'sigyls', 'sanctum', 'sono', 'turnkey', 'iconic-roofing']

  // ─── Fire everything in parallel ────────────────────────────────────────
  const [
    hotContextRows,
    lastSessionRows,
    recentThreadRows,
    decisionRows,
    conflictRows,
    unresolvedConflicts,
    questionRows,
    deadEndHits,
    baseNotes,
    projectDeepLoadNotes,
    briefResults,
  ] = await Promise.all([
    // 1. hot_context (post-eviction, no expires filter needed)
    (async () => {
      let q = supabase
        .from('hot_context')
        .select('context_type, project, content, relevance_score')
        .order('relevance_score', { ascending: false })
        .limit(15)
      if (project) q = q.or(`project.eq.${project},project.is.null`)
      const { data } = await q
      return data ?? []
    })(),

    // 2. last session (scoped by project if given)
    (async () => {
      let q = supabase
        .from('session_log')
        .select('session_date, projects_touched, summary, open_threads, decisions_made')
        .order('session_date', { ascending: false })
        .limit(1)
      if (project) q = q.contains('projects_touched', [project])
      const { data } = await q
      return data ?? []
    })(),

    // 3. open threads — pull last 5 sessions, union + dedupe in code
    (async () => {
      let q = supabase
        .from('session_log')
        .select('open_threads, session_date')
        .order('session_date', { ascending: false })
        .limit(5)
      if (project) q = q.contains('projects_touched', [project])
      const { data } = await q
      return data ?? []
    })(),

    // 4. recent decisions (last 7 days, status=active)
    (async () => {
      let q = supabase
        .from('decisions')
        .select('decision_text, project, decided_at')
        .eq('status', 'active')
        .gte('decided_at', sevenDaysAgo)
        .order('decided_at', { ascending: false })
        .limit(10)
      if (project) q = q.eq('project', project)
      const { data } = await q
      return data ?? []
    })(),

    // 5. flagged conflicts — urgency decay computed post-query
    (async () => {
      let q = supabase
        .from('hot_context')
        .select('content, project, created_at')
        .eq('context_type', 'flagged_conflict')
        .limit(20)
      if (project) q = q.or(`project.eq.${project},project.is.null`)
      const { data } = await q
      return data ?? []
    })(),

    // 5b. unresolved conflicts from conflicts table (C15 bridge)
    (async () => {
      const result = await internalGetConflicts('unresolved', project ?? null, 10)
      return result.conflicts
    })(),

    // 6. recurring questions (status=open, ask_count >= 3)
    (async () => {
      let q = supabase
        .from('recurring_questions')
        .select('question_text, ask_count, last_asked_at, project')
        .eq('status', 'open')
        .gte('ask_count', 3)
        .order('last_asked_at', { ascending: false })
        .limit(5)
      if (project) q = q.eq('project', project)
      const { data } = await q
      return data ?? []
    })(),

    // 7. dead-end memory (project only)
    (async () => {
      if (!project) return [] as Array<{ session_date: string; approach: string; reason_failed: string }>
      const { data } = await supabase
        .from('session_log')
        .select('session_date, abandoned_approaches')
        .contains('projects_touched', [project])
        .order('session_date', { ascending: false })
        .limit(20)
      const hits: Array<{ session_date: string; approach: string; reason_failed: string }> = []
      for (const row of data ?? []) {
        const arr = Array.isArray((row as any).abandoned_approaches) ? (row as any).abandoned_approaches : []
        for (const a of arr) {
          if (a && typeof a === 'object' && (a.project === project || !a.project)) {
            hits.push({
              session_date: (row as any).session_date,
              approach: a.approach ?? '(unspecified)',
              reason_failed: a.reason_failed ?? '(unknown)',
            })
            if (hits.length >= 5) break
          }
        }
        if (hits.length >= 5) break
      }
      return hits
    })(),

    // 8. base orientation notes (from manifest)
    Promise.all(basePaths.map(fetchManifestNote)),

    // 9. project deep-load notes (from manifest)
    Promise.all(projectPaths.map(fetchManifestNote)),

    // 10. all 6 project briefs (file-based, unchanged logic)
    Promise.all(allProjects.map(async (proj) => {
      const folderPath = `01-projects/${proj}`
      const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath)}/`, {
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      })
      let fileList: string[]
      if (!listRes.ok) {
        const githubFiles = await listFolderFromGitHub(`01-projects/${proj}`)
        if (!githubFiles) return `\n\n---\n## Project Brief: ${proj}\n⚠️ Project folder not found\n---`
        fileList = githubFiles
      } else {
        const data = await listRes.json()
        fileList = data.files || []
      }
      const statusFile = fileList
        .filter((f: string) => f.toLowerCase().includes('status') && f.endsWith('.md'))
        .sort()
        .reverse()[0]
      if (!statusFile) return `\n\n---\n## Project Brief: ${proj}\nℹ️ No status note found\n---`
      const notePath = `${folderPath}/${statusFile}`
      const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      })
      let content: string
      if (!noteRes.ok) {
        const githubContent = await readNoteFromGitHub(notePath)
        if (!githubContent) return `\n\n---\n## Project Brief: ${proj}\n❌ Could not read status note\n---`
        content = githubContent + '\n*(via GitHub fallback)*'
      } else {
        content = await noteRes.text()
      }
      return `\n\n---\n## Project Brief: ${proj}\n📄 ${notePath}\n\n${content}`
    })),
  ])

  // ─── Dedupe open threads across last 5 session rows ─────────────────────
  const openThreads: string[] = (() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of recentThreadRows as any[]) {
      for (const t of row.open_threads ?? []) {
        if (!seen.has(t)) { seen.add(t); out.push(t) }
      }
    }
    return out
  })()

  // ─── Score + sort flagged conflicts by urgency decay ────────────────────
  const scoredConflicts = (conflictRows as any[]).map(c => {
    const daysOld = c.created_at
      ? (Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24)
      : 0
    return { ...c, urgency: 1.0 / (1 + daysOld * 0.1) }
  }).sort((a, b) => b.urgency - a.urgency).slice(0, 10)

  // ─── Format sections ────────────────────────────────────────────────────
  const hotContextSection = hotContextRows.length
    ? `## Hot context\n` + (hotContextRows as any[]).map(r =>
        `- [${r.context_type}${r.project ? `|${r.project}` : ''}] ${r.content}`
      ).join('\n')
    : `## Hot context\n(empty)`

  const lastSessionSection = (() => {
    if (!lastSessionRows.length) return `## Last session${project ? ` — ${project}` : ''}\n(empty)`
    const row: any = lastSessionRows[0]
    const meta = `**${row.session_date}**${row.projects_touched?.length ? ` — ${row.projects_touched.join(', ')}` : ''}`
    const counts = [
      row.open_threads?.length ? `${row.open_threads.length} open threads` : null,
      row.decisions_made?.length ? `${row.decisions_made.length} decisions` : null,
    ].filter(Boolean).join(' · ')
    return `## Last session${project ? ` — ${project}` : ''}\n${meta}\n${row.summary || '(no summary)'}${counts ? `\n_${counts}_` : ''}`
  })()

  const openThreadsSection = openThreads.length
    ? `## Open threads\n` + openThreads.map(t => `- ${t}`).join('\n')
    : `## Open threads\n(empty)`

  const decisionsSection = decisionRows.length
    ? `## Recent decisions (last 7 days)\n` + (decisionRows as any[]).map(d =>
        `- **${d.decided_at}**${d.project ? ` (${d.project})` : ''}: ${d.decision_text}`
      ).join('\n')
    : `## Recent decisions (last 7 days)\n(empty)`

  const conflictsSection = (() => {
    const hasHot = scoredConflicts.length > 0
    const hasTable = (unresolvedConflicts as EnrichedConflict[]).length > 0
    if (!hasHot && !hasTable) return `## Flagged conflicts\n(empty)`
    const parts: string[] = ['## Flagged conflicts']
    if (hasHot) {
      parts.push('### From hot_context (by urgency decay)')
      parts.push(scoredConflicts.map(c =>
        `- [urgency ${c.urgency.toFixed(2)}${c.project ? ` | ${c.project}` : ''}] ${c.content}`
      ).join('\n'))
    }
    if (hasTable) {
      if (hasHot) parts.push('')
      parts.push('### Unresolved from conflicts table')
      const trunc = (s: string) => s.length <= 60 ? s : s.slice(0, 59) + '…'
      parts.push((unresolvedConflicts as EnrichedConflict[]).map(c => {
        const aLabel = c.decision_a
          ? `[${c.decision_a.status}] ${trunc(c.decision_a.decision_text)}`
          : 'missing'
        const bLabel = c.decision_b
          ? `[${c.decision_b.status}] ${trunc(c.decision_b.decision_text)}`
          : 'missing'
        const obsolete = c.obsolete_because ? ` ⚠️ ${c.obsolete_because}` : ''
        return `- [${c.detected_at.split('T')[0]}] ${c.conflict_description}${obsolete}\n    A: ${aLabel}\n    B: ${bLabel}`
      }).join('\n'))
    }
    return parts.join('\n')
  })()

  const questionsSection = questionRows.length
    ? `## Recurring questions (ask_count ≥ 3)\n` + (questionRows as any[]).map(q =>
        `- **(×${q.ask_count})**${q.project ? ` [${q.project}]` : ''} ${q.question_text}`
      ).join('\n')
    : `## Recurring questions (ask_count ≥ 3)\n(empty)`

  const deadEndSection = project
    ? (deadEndHits.length
      ? `## Dead-end memory — ${project}\n` + deadEndHits.map(h =>
          `- **${h.session_date}**: tried *${h.approach}* — abandoned because ${h.reason_failed}`
        ).join('\n')
      : `## Dead-end memory — ${project}\n(empty)`)
    : ''

  // ─── Summary header ─────────────────────────────────────────────────────
  const summaryParts = [
    `hot: ${hotContextRows.length}`,
    `last session: ${lastSessionRows.length ? (lastSessionRows[0] as any).session_date : 'none'}`,
    `open threads: ${openThreads.length}`,
    `decisions: ${decisionRows.length}`,
    `conflicts: ${scoredConflicts.length + (unresolvedConflicts as EnrichedConflict[]).length}`,
    `questions: ${questionRows.length}`,
    `base notes: ${basePaths.length}`,
    `project briefs: ${allProjects.length}`,
  ]
  if (project) {
    summaryParts.push(`${project} deep-load: ${projectPaths.length}`)
    summaryParts.push(`dead-ends: ${deadEndHits.length}`)
  }
  const header = `# Session Context — ${today}${project ? ` (+ ${project} deep-load)` : ''}\n${summaryParts.join(' | ')}`

  // ─── Assemble final output ──────────────────────────────────────────────
  const baseNotesBlock = baseNotes.length
    ? `\n\n# Base orientation (from manifest)` + baseNotes.join('')
    : ''

  const projectDeepLoadBlock = (project && projectDeepLoadNotes.length)
    ? `\n\n# ${project} deep-load (from manifest)` + projectDeepLoadNotes.join('')
    : ''

  const briefBlock = '\n\n# Project briefs\n' + briefResults.join('')

  const fullContext = [
    header,
    baseNotesBlock,
    '\n\n' + hotContextSection,
    '\n\n' + lastSessionSection,
    '\n\n' + openThreadsSection,
    '\n\n' + decisionsSection,
    '\n\n' + conflictsSection,
    '\n\n' + questionsSection,
    briefBlock,
    projectDeepLoadBlock,
    deadEndSection ? '\n\n' + deadEndSection : '',
  ].join('')

  return { content: [{ type: "text", text: fullContext }] }
})

server.registerTool('debug_folder_list', {
  title: 'Debug Folder List',
  description: "Debug: lists raw folder contents from Obsidian API",
  inputSchema: {
    folder: z.string().describe("Folder path to list"),
  },
}, async ({ folder }) => {
  const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folder)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  const raw = await listRes.text();
  return {
    content: [{ type: "text", text: `Status: ${listRes.status}\nRaw response:\n${raw}` }]
  };
});

server.registerTool('get_decision_history', {
  title: 'Get Decision History',
  description: "Get the full history of decisions John has made on a topic. Walks the supersession chain from each matched decision through to its current state and back to its origin. Returns a compact visualization of each decision chain with dates, status transitions, and provenance (why decisions changed). Use when the user asks 'what did I decide about X', 'how has my thinking on Y evolved', or 'what's the history of Z decision'. Note: route_query automatically delegates decision_history queries here — prefer route_query for natural language questions.",
  inputSchema: {
    topic: z.string().describe("The subject to get decision history for (e.g. 'backup strategy', 'auth flow')"),
    project: z.string().optional().describe("Optional project filter: sigyls, sanctum, sono, dallas-tub-fix, turnkey, iconic-roofing"),
    limit: z.number().optional().describe("Max chains to return, default 5"),
  },
}, async ({ topic, project, limit }) => {
  const result = await internalGetDecisionHistory(topic, project ?? null, limit ?? 5)
  return { content: [{ type: "text", text: formatDecisionHistory(result) }] }
})

server.registerTool('get_conflicts', {
  title: 'Get Conflicts',
  description: "List detected contradictions between John's decisions. Filters by status (default: unresolved) and optionally by project (conflict appears if either decision is in that project — OR semantics). Returns a compact visualization of each conflict showing both decisions, their current status, detection date, and an obsolescence hint if one of the decisions has since been superseded, abandoned, or disproven. Use when the user wants to audit conflicts, review pending contradictions, or decide which conflicts to resolve. For resolving a conflict, follow up with resolve_conflict using the ID shown in the output.",
  inputSchema: {
    status: z.enum(['unresolved', 'acknowledged', 'resolved', 'all']).optional()
      .describe("Status filter. Default 'unresolved'."),
    project: z.string().optional()
      .describe("Optional project filter (OR semantics — matches if either decision is in this project)"),
    limit: z.number().optional().describe("Max conflicts to return, default 10"),
  },
}, async ({ status, project, limit }) => {
  const result = await internalGetConflicts(status ?? 'unresolved', project ?? null, limit ?? 10)
  return { content: [{ type: "text", text: formatConflicts(result) }] }
})

server.registerTool('resolve_conflict', {
  title: 'Resolve Conflict',
  description: "Mark a detected conflict as resolved or acknowledged. For new_status='resolved' (the default), resolution_notes is required and should explain how the contradiction was settled. For new_status='acknowledged', resolution_notes is optional — this is for conflicts that are noted but parked. Returns confirmation with the before/after status transition and both decisions rendered for context.",
  inputSchema: {
    conflict_id: z.string().describe("The UUID of the conflict to resolve (from get_conflicts output)"),
    resolution_notes: z.string().describe("Explanation of how the conflict was resolved. Required when new_status='resolved'; optional when new_status='acknowledged'."),
    new_status: z.enum(['resolved', 'acknowledged']).optional().describe("New status. Default 'resolved'."),
  },
}, async ({ conflict_id, resolution_notes, new_status }) => {
  const finalStatus = new_status ?? 'resolved'

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRe.test(conflict_id)) {
    return { content: [{ type: "text", text: `❌ Invalid conflict_id — must be a UUID.` }] }
  }

  if (finalStatus === 'resolved' && (!resolution_notes || resolution_notes.trim().length === 0)) {
    return { content: [{ type: "text", text: `❌ resolution_notes is required when new_status='resolved'. Use new_status='acknowledged' to park a conflict without notes.` }] }
  }

  const { data: beforeRow, error: beforeErr } = await supabase
    .from('conflicts')
    .select(CONFLICT_COLUMNS)
    .eq('id', conflict_id)
    .maybeSingle()
  if (beforeErr || !beforeRow) {
    return { content: [{ type: "text", text: `❌ Conflict not found: ${conflict_id}` }] }
  }

  const { data: afterRow, error: updateErr } = await supabase
    .from('conflicts')
    .update({ status: finalStatus, resolution_notes: resolution_notes?.trim() || null })
    .eq('id', conflict_id)
    .select(CONFLICT_COLUMNS)
    .single()
  if (updateErr || !afterRow) {
    return { content: [{ type: "text", text: `❌ Update failed: ${updateErr?.message ?? 'unknown error'}` }] }
  }

  const { data: decisionRows } = await supabase
    .from('decisions')
    .select(DECISION_COLUMNS)
    .in('id', [afterRow.decision_id_a, afterRow.decision_id_b])
  const decisionById = new Map<string, DecisionRow>()
  for (const d of (decisionRows ?? []) as DecisionRow[]) decisionById.set(d.id, d)
  const decisionA = decisionById.get(afterRow.decision_id_a) ?? null
  const decisionB = decisionById.get(afterRow.decision_id_b) ?? null

  const today = new Date().toISOString().split('T')[0]
  const icon = finalStatus === 'resolved' ? '✅' : '📌'
  const actionLabel = finalStatus === 'resolved' ? 'resolved' : 'acknowledged'

  const renderDecision = (label: 'A' | 'B', d: DecisionRow | null) => {
    if (!d) return `  ${label}. ⚠️ decision not found`
    const proj = d.project ? ` (${d.project})` : ''
    return `  ${label}. [${d.decided_at} | ${d.status}]${proj} ${d.decision_text}`
  }

  const lines = [
    `${icon} Conflict ${actionLabel}`,
    `ID: ${afterRow.id}`,
    `Status: ${beforeRow.status} → ${afterRow.status}`,
    `Detected: ${beforeRow.detected_at.split('T')[0]}`,
    `${finalStatus === 'resolved' ? 'Resolved' : 'Acknowledged'}: ${today}`,
    '',
    `Description: ${afterRow.conflict_description}`,
  ]
  if (afterRow.resolution_notes) {
    lines.push('', `Resolution: ${afterRow.resolution_notes}`)
  }
  lines.push(
    '',
    'Decisions:',
    renderDecision('A', decisionA),
    renderDecision('B', decisionB),
  )

  return { content: [{ type: "text", text: lines.join('\n') }] }
})

server.registerTool('update_staleness_scores', {
  title: 'Update Staleness Scores',
  description: "Recompute staleness_score for every note using exponential decay from updated_at. Each note gets a half-life based on type/artifact_type (specs decay over 2 years, status notes over 2 weeks, default 90 days). Staleness feeds the retrieval_rank formula: similarity × (staleness × 0.4 + authority × 0.6). Writes are skipped when the new score drifts by less than 0.01 from the current value. Normally runs daily via cron — call manually after bulk imports or to backfill newly-added notes. Set dry_run=true to preview counts without writing.",
  inputSchema: {
    dry_run: z.boolean().optional().describe("If true, report what would change without writing. Default false."),
  },
}, async ({ dry_run }) => {
  const result = await internalUpdateStalenessScores(dry_run ?? false)
  const icon = result.errors === 0 ? (result.dry_run ? '🔍' : '✅') : '⚠️'
  const modeLabel = result.dry_run ? ' (dry run — no writes)' : ''
  const verb = result.dry_run ? 'Would update' : 'Updated'
  return {
    content: [{
      type: "text",
      text: `${icon} Staleness scores${modeLabel}\n• Total notes: ${result.total}\n• ${verb}: ${result.updated}\n• Skipped (noise floor <0.01): ${result.skipped}\n• Errors: ${result.errors}`,
    }],
  }
})

server.registerTool('get_related_notes', {
  title: 'Get Related Notes',
  description: "List notes connected to a given note via the knowledge graph (note_edges). By default returns only auto-surfaced high-confidence edges (>0.75). Set include_medium_confidence=true to also return the explicit tier (0.5-0.75) in a separate section. Edges below 0.5 are never stored. Relationship types render with directional arrows (→/←) for supersedes/is_part_of/references where direction carries meaning, and symmetric arrows (↔) for contradicts/supports/relates_to/inspired_by. Use when asking 'what's connected to this note', 'what contradicts X', 'what does Y supersede', etc.",
  inputSchema: {
    note_path: z.string().describe("Full vault path to the anchor note, e.g. '01-projects/sigyls/design.md'"),
    include_medium_confidence: z.boolean().optional().describe("If true, also return 0.5-0.75 edges in a separate section. Default false."),
    limit: z.number().optional().describe("Max related notes per tier. Default 10."),
  },
}, async ({ note_path, include_medium_confidence, limit }) => {
  const effectiveLimit = limit ?? 10

  const { data: anchorRow, error: anchorErr } = await supabase
    .from('notes')
    .select('id, path, title')
    .eq('path', note_path)
    .maybeSingle()
  if (anchorErr || !anchorRow) {
    return { content: [{ type: "text", text: `❌ Note not found: ${note_path}` }] }
  }

  let autoRows: RelatedNoteRow[] = []
  let mediumRows: RelatedNoteRow[] = []
  if (include_medium_confidence) {
    const [a, m] = await Promise.all([
      internalGetRelatedNotes(anchorRow.id, 'auto', effectiveLimit),
      internalGetRelatedNotes(anchorRow.id, 'medium', effectiveLimit),
    ])
    autoRows = a
    mediumRows = m
  } else {
    autoRows = await internalGetRelatedNotes(anchorRow.id, 'auto', effectiveLimit)
  }

  const renderRow = (r: RelatedNoteRow) => {
    const arrow = renderEdgeArrow(r.relationship_type, r.direction)
    const label = r.related_title ? `${r.related_title} (${r.related_path})` : r.related_path
    return `  ${arrow} ${label}  [${r.confidence.toFixed(2)}]`
  }

  const lines: string[] = [
    `# Related notes for: ${anchorRow.title ?? anchorRow.path}`,
    `📄 ${anchorRow.path}`,
    '',
  ]

  if (autoRows.length === 0 && mediumRows.length === 0) {
    lines.push('(no related notes found)')
  } else {
    lines.push(`## High-confidence (auto, >0.75) — ${autoRows.length}`)
    if (autoRows.length === 0) {
      lines.push('  (none)')
    } else {
      lines.push(...autoRows.map(renderRow))
    }
    if (include_medium_confidence) {
      lines.push('', `## Medium-confidence (explicit, 0.5-0.75) — ${mediumRows.length}`)
      if (mediumRows.length === 0) {
        lines.push('  (none)')
      } else {
        lines.push(...mediumRows.map(renderRow))
      }
    }
  }

  return { content: [{ type: "text", text: lines.join('\n') }] }
})

server.registerTool('close_session', {
  title: 'Close Session',
  description: "Writes a structured summary of a working session to session_log (C24), captures abandoned approaches (C32), runs the retrieval feedback loop on notes loaded vs referenced (C27), extracts recurring questions into the question bank (C34), and applies decision lifecycle updates (C23). Stateless — the caller passes a payload describing what happened. Only 'summary' is required. Reports partial success per sub-component; a failure in one area does not roll back session_log insertion. Use at the end of every working session.",
  inputSchema: {
    summary: z.string().describe("Narrative summary of the session"),
    session_date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
    projects_touched: z.array(z.string()).optional().describe("Freeform project slugs worked on this session"),
    decisions_made: z.array(z.string()).optional().describe("UUIDs of decisions created or meaningfully modified. Not FK-validated — pass-through as given."),
    notes_saved: z.array(z.string()).optional().describe("Vault paths of notes created or updated this session. Unresolved paths are dropped with warnings."),
    notes_loaded: z.array(z.string()).optional().describe("C27 input: vault paths that load_session_context served. Ephemeral — not persisted, used to compute usefulness feedback."),
    notes_referenced: z.array(z.string()).optional().describe("C27 input: vault paths actually used in session work. Ephemeral — notes here get usefulness_score bumped by 0.1."),
    open_threads: z.array(z.string()).optional().describe("Unresolved questions or tasks from this session"),
    abandoned_approaches: z.array(z.object({
      approach: z.string(),
      reason_failed: z.string(),
      project: z.string().optional(),
      related_decision_id: z.string().optional(),
    })).optional().describe("C32 dead-end memory: what was tried and abandoned, and why"),
    questions_asked: z.array(z.string()).optional().describe("C34 question bank: explicit list of questions posed. If omitted, Haiku extracts from summary."),
    decision_outcomes: z.array(z.object({
      decision_id: z.string(),
      new_status: z.enum(['proven', 'disproven', 'abandoned']),
      outcome_notes: z.string().optional(),
    })).optional().describe("C23 decision lifecycle updates. Only transitions from status='active' are applied — others are counted as rejected."),
  },
}, async (args) => {
  const {
    summary,
    session_date,
    projects_touched,
    decisions_made,
    notes_saved,
    notes_loaded,
    notes_referenced,
    open_threads,
    abandoned_approaches,
    questions_asked,
    decision_outcomes,
  } = args

  const today = session_date ?? new Date().toISOString().split('T')[0]
  const warnings: string[] = []

  // ─── 1. Resolve note paths → IDs in one bulk query ────────────────────
  const allPaths = Array.from(new Set([
    ...(notes_saved ?? []),
    ...(notes_loaded ?? []),
    ...(notes_referenced ?? []),
  ]))

  const idByPath = new Map<string, string>()
  if (allPaths.length > 0) {
    const { data: noteRows } = await supabase
      .from('notes')
      .select('id, path')
      .in('path', allPaths)
    for (const n of (noteRows ?? []) as Array<{ id: string; path: string }>) {
      idByPath.set(n.path, n.id)
    }
    for (const p of allPaths) {
      if (!idByPath.has(p)) warnings.push(`unresolved path: ${p}`)
    }
  }

  const resolveIds = (paths: string[] | undefined): string[] =>
    (paths ?? []).map(p => idByPath.get(p)).filter((x): x is string => !!x)

  const savedIds = resolveIds(notes_saved)
  const loadedIds = resolveIds(notes_loaded)
  const referencedIds = resolveIds(notes_referenced)

  // ─── 2. Insert session_log row ────────────────────────────────────────
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('session_log')
    .insert({
      session_date: today,
      projects_touched: projects_touched && projects_touched.length > 0 ? projects_touched : null,
      decisions_made: decisions_made && decisions_made.length > 0 ? decisions_made : null,
      notes_saved: savedIds.length > 0 ? savedIds : null,
      open_threads: open_threads && open_threads.length > 0 ? open_threads : null,
      summary,
      abandoned_approaches: abandoned_approaches ?? [],
    })
    .select('id')
    .single()

  if (sessionErr || !sessionRow) {
    return {
      content: [{
        type: "text",
        text: `❌ Failed to write session_log: ${sessionErr?.message ?? 'unknown error'}`,
      }],
    }
  }
  const sessionId = sessionRow.id

  // ─── 3. C27 retrieval feedback loop ───────────────────────────────────
  let bumpedCount = 0
  let decayedCount = 0
  let feedbackErrors = 0

  const referencedSet = new Set(referencedIds)
  const loadedOnly = loadedIds.filter(id => !referencedSet.has(id))

  const applyDelta = async (ids: string[], delta: number, markUseful: boolean) => {
    const CHUNK = 50
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const { data: existing } = await supabase
        .from('notes')
        .select('id, usefulness_score')
        .in('id', chunk)
      const byId = new Map<string, number>()
      for (const r of (existing ?? []) as Array<{ id: string; usefulness_score: number | null }>) {
        byId.set(r.id, r.usefulness_score ?? 0.5)
      }

      const results = await Promise.all(chunk.map(async id => {
        const current = byId.get(id) ?? 0.5
        const next = Math.max(0, Math.min(1, current + delta))
        const patch: Record<string, unknown> = { usefulness_score: next }
        if (markUseful) patch.last_useful_at = new Date().toISOString()
        const { error } = await supabase
          .from('notes')
          .update(patch)
          .eq('id', id)
        return error ? 'error' : 'ok'
      }))
      for (const r of results) {
        if (r === 'error') feedbackErrors++
        else if (markUseful) bumpedCount++
        else decayedCount++
      }
    }
  }

  if (referencedSet.size > 0) await applyDelta(Array.from(referencedSet), 0.1, true)
  if (loadedOnly.length > 0) await applyDelta(loadedOnly, -0.05, false)

  // ─── 4. C34 question bank ─────────────────────────────────────────────
  let newQuestions = 0
  let incrementedQuestions = 0
  let questionErrors = 0

  const questions: string[] = questions_asked && questions_asked.length > 0
    ? questions_asked
    : await internalExtractQuestions(summary)

  for (const q of questions) {
    const trimmed = q.trim()
    if (!trimmed) continue
    const canonical = internalNormalizeQuestion(trimmed)
    if (!canonical) continue

    try {
      const { data: existing } = await supabase
        .from('recurring_questions')
        .select('id, ask_count')
        .eq('canonical_form', canonical)
        .limit(1)
        .maybeSingle()

      if (existing) {
        const { error } = await supabase
          .from('recurring_questions')
          .update({
            ask_count: (existing.ask_count ?? 1) + 1,
            last_asked_at: today,
          })
          .eq('id', existing.id)
        if (error) questionErrors++
        else incrementedQuestions++
      } else {
        const { error } = await supabase
          .from('recurring_questions')
          .insert({
            question_text: trimmed,
            canonical_form: canonical,
            first_asked_at: today,
            last_asked_at: today,
            ask_count: 1,
          })
        if (error) questionErrors++
        else newQuestions++
      }
    } catch {
      questionErrors++
    }
  }

  // ─── 5. C23 decision outcomes ─────────────────────────────────────────
  let outcomesApplied = 0
  let outcomesRejected = 0

  for (const outcome of (decision_outcomes ?? [])) {
    const patch: Record<string, unknown> = { status: outcome.new_status }
    if (outcome.outcome_notes) patch.outcome_notes = outcome.outcome_notes
    const { data, error } = await supabase
      .from('decisions')
      .update(patch)
      .eq('id', outcome.decision_id)
      .eq('status', 'active')
      .select('id')
    if (error) {
      outcomesRejected++
      continue
    }
    if (Array.isArray(data) && data.length > 0) outcomesApplied++
    else outcomesRejected++
  }

  // ─── 6. Build response ────────────────────────────────────────────────
  const lines: string[] = [
    `✅ Session closed — ${today}`,
    `session_log ID: ${sessionId}`,
    '',
    `• Projects touched: ${(projects_touched ?? []).join(', ') || '(none)'}`,
    `• Decisions made: ${(decisions_made ?? []).length}  |  Notes saved: ${savedIds.length}  |  Open threads: ${(open_threads ?? []).length}`,
    `• Abandoned approaches: ${(abandoned_approaches ?? []).length}`,
  ]

  if ((notes_loaded ?? []).length > 0 || (notes_referenced ?? []).length > 0) {
    lines.push('', '🔁 Retrieval feedback (C27)')
    lines.push(`• Bumped usefulness: ${bumpedCount} notes`)
    lines.push(`• Decayed usefulness: ${decayedCount} notes`)
    if (feedbackErrors > 0) lines.push(`• Errors: ${feedbackErrors}`)
  }

  if (questions.length > 0) {
    lines.push('', '❓ Question bank (C34)')
    lines.push(`• New: ${newQuestions}  |  Re-asked: ${incrementedQuestions}`)
    if (questionErrors > 0) lines.push(`• Errors: ${questionErrors}`)
  }

  if ((decision_outcomes ?? []).length > 0) {
    lines.push('', '📜 Decision outcomes (C23)')
    lines.push(`• Applied: ${outcomesApplied}`)
    lines.push(`• Rejected: ${outcomesRejected}`)
  }

  if (warnings.length > 0) {
    lines.push('', '⚠️ Warnings')
    lines.push(...warnings.map(w => `• ${w}`))
  }

  return { content: [{ type: "text", text: lines.join('\n') }] }
})

server.registerTool('synthesize_thinking_on', {
  title: 'Synthesize Thinking On',
  description: "Produces a 3-5 paragraph narrative of how John's thinking on a topic has evolved over time. Traverses semantic search results, decision history chains (with supersession walks), and knowledge graph edges; merges them into a chronological timeline; then uses Claude Sonnet to synthesize a reasoning arc — not a list. Cites specific dates, calls out superseded decisions with their reasons, and identifies the current settled position or unresolved tension. Use for 'tell me everything about X', 'how has my thinking on Y evolved', or any exploratory synthesis query. This is the oracle capability — a story of reasoning, not a retrieval. Note: route_query auto-routes exploratory_synthesis queries here.",
  inputSchema: {
    topic: z.string().describe("The subject to synthesize thinking on, e.g. 'sono pricing', 'backup strategy', 'supabase vs n8n'"),
    project: z.string().optional().describe("Optional project filter: sigyls, sanctum, sono, dallas-tub-fix, turnkey, iconic-roofing"),
    since: z.string().optional().describe("Optional ISO date YYYY-MM-DD — only include thinking from this date forward. Useful for 'how has this evolved since March' queries."),
  },
}, async ({ topic, project, since }) => {
  const result = await internalSynthesizeThinking(topic, project ?? null, since ?? null)
  return { content: [{ type: "text", text: formatSynthesis(result) }] }
})

server.registerTool('cross_project_insight', {
  title: 'Cross-Project Insight',
  description: "Surfaces connections across multiple projects in John's vault. Fetches high-confidence cross-project edges from the knowledge graph (notes in DIFFERENT projects linked by relates_to / contradicts / supports / inspired_by / etc.), then uses Claude Sonnet to synthesize the themes — what patterns echo across projects, what he's learned in one and applied to another. Use for 'what do sigyls and sono have in common', 'how does my thinking on X apply across projects', or any cross-project pattern query. Note: route_query auto-routes cross_project queries here.",
  inputSchema: {
    since: z.string().optional().describe("ISO date YYYY-MM-DD — only include edges created from this date forward. Default: 7 days ago."),
    confidence_min: z.number().optional().describe("Minimum edge confidence (0-1). Default 0.6 (explicit-surface tier)."),
    projects: z.array(z.string()).optional().describe("Optional list of project names, e.g. ['sigyls','sono']. At least one endpoint of each edge must be in this set. Default: all projects."),
  },
}, async ({ since, confidence_min, projects }) => {
  const effectiveSince = since ?? isoDaysAgo(7)
  const effectiveConfMin = confidence_min ?? 0.6
  const effectiveProjects = projects && projects.length > 0 ? projects : null
  const result = await internalCrossProjectInsight(effectiveSince, effectiveConfMin, effectiveProjects)
  return { content: [{ type: "text", text: formatCrossProjectInsight(result) }] }
})

server.registerTool('route_query', {
  title: 'Route Query (Smart Search)',
  description: "PREFERRED TOOL for any natural language question about John's vault. Always try this FIRST for questions like 'what did I decide about X', 'how should I approach Y', 'what's the status of Z', 'what do I know about...', or any conceptual/exploratory query. Classifies query intent using Haiku, then automatically routes to the optimal retrieval strategy (semantic search, decision history, entity lookup, current status, synthesis, or cross-project insight). Includes dead-end memory check for 'how should I approach X' questions. Only fall back to search_vault or semantic_search if route_query returns no useful results.",
  inputSchema: {
    query: z.string().describe("The user's question or search query in natural language"),
  },
}, async ({ query }) => {
  const classification = await classifyQueryIntent(query)
  const { query_type, topic, project, confidence, classifier_error } = classification

  const headerLines = [
    `🎯 Query: ${JSON.stringify(query)}`,
    `📋 Classified as: ${query_type} (confidence ${confidence.toFixed(2)})`,
    `   topic: ${topic}${project ? ` | project: ${project}` : ''}`,
  ]
  if (classifier_error) headerLines.push(`   ⚠️ ${classifier_error} — defaulted to factual_recall`)
  if (confidence < 0.5 && !classifier_error) headerLines.push(`   ⚠️ low confidence classification`)
  const header = headerLines.join('\n') + '\n\n'

  // ─── Dead-end memory check (Component 32) for approach_recommendation ─────
  let deadEndNotice = ''
  if (query_type === 'approach_recommendation') {
    const { data: sessionRows } = await supabase
      .from('session_log')
      .select('session_date, abandoned_approaches')
      .order('session_date', { ascending: false })
      .limit(200)
    const hits: string[] = []
    for (const row of sessionRows ?? []) {
      const approaches = Array.isArray(row.abandoned_approaches) ? row.abandoned_approaches : []
      for (const a of approaches) {
        const hay = `${a.approach ?? ''} ${a.reason_failed ?? ''} ${a.project ?? ''}`.toLowerCase()
        if (hay.includes(topic.toLowerCase()) || (project && a.project === project)) {
          hits.push(`⚠️ Previously abandoned (${row.session_date}): ${a.approach}\n   Reason: ${a.reason_failed}`)
        }
      }
    }
    deadEndNotice = hits.length
      ? `## Dead-end memory\n${hits.join('\n')}\n\n`
      : `## Dead-end memory\n(no prior abandoned approaches found for this topic)\n\n`
  }

  // ─── Route execution ───────────────────────────────────────────────────────
  let body = ''

  switch (query_type) {
    case 'exploratory_synthesis': {
      const syn = await internalSynthesizeThinking(topic || query, project ?? null, null)
      body = formatSynthesis(syn)
      break
    }

    case 'factual_recall':
    case 'approach_recommendation': {
      const results = await internalSemanticSearch(topic || query, 5, project)
      if (!results.length) {
        body = `No semantic search results for: ${topic || query}`
        break
      }
      body = `## Relevant notes\n` + results.map(r =>
        `📄 ${r.path} (${Math.round(r.similarity * 100)}% match)\n${r.content.slice(0, 200)}...`
      ).join('\n\n')
      break
    }

    case 'decision_history': {
      const historyResult = await internalGetDecisionHistory(topic || query, project ?? null, 5)
      body = formatDecisionHistory(historyResult)
      break
    }

    case 'current_status': {
      const { data: hotRows, error: hotErr } = await supabase
        .from('hot_context')
        .select('context_type, project, content, relevance_score, expires_at')
        .or(project ? `project.eq.${project},project.is.null` : 'project.is.null')
        .order('relevance_score', { ascending: false })
        .limit(10)

      if (!hotErr && hotRows && hotRows.length > 0) {
        body = `## Hot context${project ? ` — ${project}` : ''}\n` +
          hotRows.map(r => `[${r.context_type}] ${r.content}`).join('\n')
      } else if (project) {
        // Fall back to get_project_brief logic when hot_context is empty and a project is named
        const folderPath = `01-projects/${project}`
        const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath)}/`, {
          headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
        })
        if (!listRes.ok) {
          body = `ℹ️ hot_context empty, showing project brief instead\n❌ Project folder not found: ${folderPath}`
        } else {
          const folderData = await listRes.json()
          const statusFile = (folderData.files || [])
            .filter((f: string) => f.toLowerCase().includes('status') && f.endsWith('.md'))
            .sort()
            .reverse()[0]
          if (!statusFile) {
            body = `ℹ️ hot_context empty, showing project brief instead\nℹ️ No status note found for project: ${project}`
          } else {
            const notePath = `${folderPath}/${statusFile}`
            const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(notePath)}`, {
              headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
            })
            if (!noteRes.ok) {
              body = `ℹ️ hot_context empty, showing project brief instead\n❌ Could not read status note: ${notePath}`
            } else {
              const briefContent = await noteRes.text()
              body = `ℹ️ hot_context empty, showing project brief instead\n\n# Project Brief: ${project}\n📄 ${notePath}\n\n${briefContent}`
            }
          }
        }
      } else {
        body = `No hot_context entries and no project specified.\n(load_session_context upgrade coming in Phase 3 C11.)`
      }
      break
    }

    case 'entity_lookup': {
      const { data: byName } = await supabase
        .from('entities')
        .select('id, name, entity_type, description, mention_count, aliases')
        .ilike('name', `%${topic}%`)
        .limit(5)
      const { data: byAlias } = await supabase
        .from('entities')
        .select('id, name, entity_type, description, mention_count, aliases')
        .contains('aliases', [topic])
        .limit(5)

      const merged = new Map<string, { id: string; name: string; entity_type: string; description: string | null; mention_count: number | null; aliases: string[] | null }>()
      for (const e of [...(byName ?? []), ...(byAlias ?? [])]) {
        merged.set(e.id, e)
      }
      const entityRows = Array.from(merged.values())
        .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0))
        .slice(0, 5)

      if (!entityRows.length) {
        body = `No entities matching "${topic}" (searched name and aliases).`
        break
      }
      body = `## Entity matches\n` + entityRows.map(e => {
        const aliasLine = e.aliases?.length ? ` (aka ${e.aliases.join(', ')})` : ''
        const descLine = e.description ? `\n  ${e.description}` : ''
        const mentionLine = e.mention_count ? `\n  ${e.mention_count} mention(s)` : ''
        return `🔹 ${e.name} [${e.entity_type}]${aliasLine}${descLine}${mentionLine}`
      }).join('\n\n')
      break
    }

    case 'cross_project': {
      const projectFilter = project ? [project] : null
      const result = await internalCrossProjectInsight(isoDaysAgo(7), 0.6, projectFilter)
      body = formatCrossProjectInsight(result)
      break
    }
  }

  return { content: [{ type: 'text', text: `${header}${deadEndNotice}${body}` }] }
})

server.registerTool('run_extraction', {
  title: 'Run Extraction',
  description: "Run the intelligence pipeline on an existing vault note by path. Reads the note from Obsidian, then runs extraction, relationship, and contradiction agents. Use for the one-time backfill of existing notes after Phase 2 deploy.",
  inputSchema: {
    note_path: z.string().describe("Full path to the note, e.g. '01-projects/sigyls/2026-02-28-ada-design.md'"),
  },
}, async ({ note_path }) => {
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(note_path)}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!readResponse.ok) {
    return { content: [{ type: "text", text: `❌ Note not found: ${note_path}` }] }
  }
  const content = await readResponse.text()

  const pipelineResponse = await fetch('https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/intelligence-pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ path: note_path, content, project: '' })
  })
  if (!pipelineResponse.ok) {
    const err = await pipelineResponse.text()
    return { content: [{ type: "text", text: `❌ Pipeline failed (${pipelineResponse.status}): ${err}` }] }
  }
  const result = await pipelineResponse.json()
  return {
    content: [{
      type: "text",
      text: `✅ Extraction complete for ${note_path}\n• Entities: ${result.entities_extracted}\n• Decisions: ${result.decisions_extracted}\n• Note ID: ${result.note_id}`
    }]
  }
})

server.registerTool('generate_vault_index', {
  title: 'Generate Vault Index',
  description: "Scans all notes across the entire vault, reads their frontmatter, and generates a fresh vault-index.md in 00-system/. Groups notes by folder matching the PARA structure. Call this when the INDEX may be stale or after bulk operations.",
  inputSchema: {},
}, async () => {
  try {
    const result = await runVaultIndexGeneration();
    const errorSummary = result.errors.length > 0 ? `\n⚠️ ${result.errors.length} errors:\n${result.errors.join('\n')}` : '';
    return {
      content: [{
        type: "text",
        text: `✅ Vault INDEX generated: ${result.totalNotes} notes indexed across ${result.folderCount} folders.${errorSummary}`
      }]
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ ${String(err)}` }]
    };
  }
});

app.get('/cron/generate-index', async (c) => {
  try {
    const result = await runVaultIndexGeneration();
    return c.json({ ok: true, notes: result.totalNotes, folders: result.folderCount, errors: result.errors });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

app.get('/cron/update-staleness', async (c) => {
  try {
    const result = await internalUpdateStalenessScores()
    return c.json({ ok: true, total: result.total, updated: result.updated, skipped: result.skipped, errors: result.errors })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500)
  }
})

app.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

Deno.serve(app.fetch)