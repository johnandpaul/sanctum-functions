import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY        = Deno.env.get('ANTHROPIC_API_KEY')!
const GEMINI_API_KEY           = Deno.env.get('GEMINI_API_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractedEntity {
  id: string
  name: string
}

interface ExtractedDecision {
  id: string
  decision_text: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    if (key && val) result[key] = val
  }
  return result
}

function authorityWeight(type: string, artifactType: string): number {
  if (type === 'resource' && artifactType === 'spec')       return 0.9
  if (type === 'resource' && artifactType === 'reference')  return 0.85
  if (type === 'status')                                    return 0.8
  if (type === 'brainstorm')                                return 0.4
  if (type === 'digest-item')                               return 0.3
  return 0.5
}

async function callHaiku(prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Haiku API ${res.status}`)
  const data = await res.json()
  return data.content[0].text
}

async function generateEmbedding(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    }
  )
  if (!res.ok) throw new Error(`Gemini embedding ${res.status}`)
  const data = await res.json()
  return data.embedding.values
}

// ─── Step 0: Upsert note ──────────────────────────────────────────────────────

async function upsertNote(
  path: string,
  content: string,
  fm: Record<string, string>,
  project: string
): Promise<string> {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    ?? path.split('/').pop()?.replace('.md', '')
    ?? path

  const rawTags = (fm.tags ?? '').replace(/[\[\]]/g, '')
  const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : []

  const { data, error } = await supabase
    .from('notes')
    .upsert({
      path,
      title,
      type:           fm.type          ?? null,
      artifact_type:  fm.artifact_type ?? null,
      purpose:        fm.purpose       ?? null,
      status:         fm.status        ?? null,
      project:        project          || null,
      tags,
      created_at:     fm.created       ?? new Date().toISOString().split('T')[0],
      updated_at:     new Date().toISOString(),
      word_count:     content.split(/\s+/).filter(Boolean).length,
      authority_weight: authorityWeight(fm.type ?? '', fm.artifact_type ?? ''),
    }, { onConflict: 'path' })
    .select('id')
    .single()

  if (error) throw new Error(`upsertNote: ${error.message}`)
  return data.id
}

// ─── Step 1: Extraction Agent ─────────────────────────────────────────────────

async function runExtractionAgent(
  noteId: string,
  content: string,
  project: string,
  fm: Record<string, string>
): Promise<{ entities: ExtractedEntity[]; decisions: ExtractedDecision[] }> {
  const decidedAt = fm.created ?? new Date().toISOString().split('T')[0]

  const prompt = `You are an information extraction system for a personal knowledge vault. Extract structured data from this note.

Return ONLY valid JSON matching this exact schema — no other text:
{
  "entities": [
    {
      "name": "string",
      "entity_type": "person|company|technology|concept|project",
      "description": "one sentence describing this entity in context"
    }
  ],
  "decisions": [
    {
      "decision_text": "string - the full decision statement"
    }
  ]
}

Rules:
- Entities: extract people (full names preferred), companies, technologies/tools/libraries/frameworks, key concepts, and projects explicitly and clearly named in the note.
- Decisions: extract clear commitment or choice statements — sentences containing "decided", "will use", "going with", "chose", "confirmed", "we'll", "switching to", "dropping", "using X instead of Y", or any explicit architectural, strategic, or product choice. Do not extract vague intentions or aspirations.
- Do not list "${project || 'this project'}" itself as an entity.
- If nothing qualifies, return empty arrays.

Note metadata:
type: ${fm.type ?? ''}
project: ${project}
created: ${decidedAt}

Note content:
${content.slice(0, 6000)}`

  let parsed: {
    entities: Array<{ name: string; entity_type: string; description: string }>
    decisions: Array<{ decision_text: string }>
  }

  try {
    const raw = await callHaiku(prompt)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch?.[0] ?? '{"entities":[],"decisions":[]}')
  } catch {
    return { entities: [], decisions: [] }
  }

  const extractedEntities: ExtractedEntity[] = []
  const extractedDecisions: ExtractedDecision[] = []

  for (const e of parsed.entities ?? []) {
    if (!e.name?.trim() || !e.entity_type) continue
    try {
      const entityId = await findOrCreateEntity(
        noteId, e.name.trim(), e.entity_type, e.description ?? '', decidedAt
      )
      if (entityId) extractedEntities.push({ id: entityId, name: e.name })
    } catch {
      // Entity failure is non-fatal — pipeline continues
    }
  }

  for (const d of parsed.decisions ?? []) {
    if (!d.decision_text?.trim()) continue
    try {
      const decisionText = d.decision_text.trim()

      // Exact match duplicate check — skip insert if (note_id, decision_text) already exists
      const { data: existing } = await supabase
        .from('decisions')
        .select('id')
        .eq('note_id', noteId)
        .eq('decision_text', decisionText)
        .maybeSingle()

      if (existing) {
        extractedDecisions.push({ id: existing.id, decision_text: d.decision_text })
        continue
      }

      const { data, error } = await supabase
        .from('decisions')
        .insert({
          note_id:       noteId,
          decision_text: decisionText,
          project:       project || null,
          decided_at:    decidedAt,
          status:        'active',
        })
        .select('id')
        .single()
      if (!error && data) extractedDecisions.push({ id: data.id, decision_text: d.decision_text })
    } catch {
      // Decision failure is non-fatal — pipeline continues
    }
  }

  return { entities: extractedEntities, decisions: extractedDecisions }
}

// ─── Entity deduplication ─────────────────────────────────────────────────────

async function findOrCreateEntity(
  noteId: string,
  name: string,
  entityType: string,
  description: string,
  mentionedAt: string
): Promise<string | null> {
  const { data: candidates } = await supabase.rpc('find_similar_entity', {
    p_name: name,
    p_entity_type: entityType,
  })

  let entityId: string | null = null

  if (candidates?.length) {
    const best = candidates[0] as { id: string; name: string; sim: number }

    if (best.sim >= 0.85) {
      // High confidence match — no Haiku call needed
      entityId = best.id
    } else {
      // Ambiguous — ask Haiku to classify
      try {
        const verdict = (await callHaiku(
          `Are these the same entity?\n\nA: "${name}" (${entityType})\nB: "${best.name}" (${entityType})\n\nReturn ONLY one of: same, different, parent-child`
        )).trim().toLowerCase()

        if (verdict === 'same') {
          entityId = best.id
        } else if (verdict === 'parent-child') {
          const { data: child } = await supabase
            .from('entities')
            .insert({ name, entity_type: entityType, description, first_mentioned_at: mentionedAt, parent_entity_id: best.id })
            .select('id')
            .single()
          entityId = child?.id ?? null
        }
        // 'different' falls through — a new entity will be created below
      } catch {
        // Haiku failure: create new entity rather than silently merge
      }
    }

    if (entityId === best.id) {
      // Increment mention_count on the matched entity
      const { data: row } = await supabase
        .from('entities').select('mention_count').eq('id', entityId).single()
      await supabase
        .from('entities').update({ mention_count: (row?.mention_count ?? 1) + 1 }).eq('id', entityId)
    }
  }

  // No match found — create new entity
  if (!entityId) {
    const { data: created } = await supabase
      .from('entities')
      .insert({ name, entity_type: entityType, description, first_mentioned_at: mentionedAt })
      .select('id')
      .single()
    entityId = created?.id ?? null
  }

  // Record the mention regardless of whether entity was found or created
  if (entityId) {
    await supabase.from('entity_mentions').insert({
      entity_id:    entityId,
      note_id:      noteId,
      context:      description,
      mentioned_at: mentionedAt,
    })
  }

  return entityId
}

// ─── Step 2: Relationship Agent ───────────────────────────────────────────────

async function runRelationshipAgent(
  noteId: string,
  content: string,
  entityIds: string[]
): Promise<void> {
  const embedding = await generateEmbedding(content.slice(0, 8000))

  const { data: similar } = await supabase.rpc('match_notes', {
    query_embedding:  embedding,
    match_count:      20,
    filter_project:   null,  // Edges are intentionally cross-project
  })

  if (!similar?.length) return

  const VALID_TYPES = ['relates_to', 'contradicts', 'supersedes', 'supports', 'is_part_of', 'references', 'inspired_by']

  for (const candidate of similar as Array<{ path: string; content: string; similarity: number }>) {
    if (candidate.similarity < 0.7) continue

    // Candidates not yet in the notes table are skipped — they get edges after
    // the run_extraction backfill populates them.
    const { data: candidateNote } = await supabase
      .from('notes')
      .select('id')
      .eq('path', candidate.path)
      .maybeSingle()

    if (!candidateNote || candidateNote.id === noteId) continue

    // Entity overlap ratio
    let entityOverlapRatio = 0
    if (entityIds.length > 0) {
      const { data: candidateMentions } = await supabase
        .from('entity_mentions')
        .select('entity_id')
        .eq('note_id', candidateNote.id)

      if (candidateMentions?.length) {
        const candidateSet = new Set(candidateMentions.map((m: { entity_id: string }) => m.entity_id))
        const shared = entityIds.filter(id => candidateSet.has(id)).length
        entityOverlapRatio = shared / Math.max(entityIds.length, candidateSet.size)
      }
    }

    const confidence = (candidate.similarity * 0.6) + (entityOverlapRatio * 0.4)
    if (confidence < 0.5) continue

    // Classify relationship type for high-confidence edges
    let relationshipType = 'relates_to'
    if (confidence > 0.75) {
      try {
        const raw = (await callHaiku(
          `What is the relationship between these two notes?\n\nNote A:\n${content.slice(0, 300)}\n\nNote B:\n${(candidate.content ?? '').slice(0, 300)}\n\nChoose exactly one: relates_to, contradicts, supersedes, supports, is_part_of, references, inspired_by\n\nReturn ONLY the relationship type.`
        )).trim().toLowerCase().replace(/[^a-z_]/g, '')
        if (VALID_TYPES.includes(raw)) relationshipType = raw
      } catch {
        // Haiku failure: keep 'relates_to'
      }
    }

    await supabase
      .from('note_edges')
      .upsert(
        { note_id_a: noteId, note_id_b: candidateNote.id, relationship_type: relationshipType, confidence, source: 'auto' },
        { onConflict: 'note_id_a,note_id_b,relationship_type' }
      )
  }
}

// ─── Step 3: Contradiction Agent ──────────────────────────────────────────────

async function runContradictionAgent(
  noteId: string,
  project: string,
  newDecisions: ExtractedDecision[]
): Promise<void> {
  if (!newDecisions.length || !project) return

  const { data: existing } = await supabase
    .from('decisions')
    .select('id, decision_text')
    .eq('project', project)
    .eq('status', 'active')
    .neq('note_id', noteId)
    .order('decided_at', { ascending: false })
    .limit(30)

  if (!existing?.length) return

  const newList      = newDecisions.map((d, i) => `${i + 1}. "${d.decision_text}"`).join('\n')
  const existingList = existing.map(d => `(id: ${d.id}) "${d.decision_text}"`).join('\n')

  const prompt = `You are auditing a decision log for contradictions.

New decisions just recorded:
${newList}

Existing active decisions for project "${project}":
${existingList}

A contradiction means two decisions cannot both be true simultaneously — direct conflicts only, not just unrelated choices on different topics.

Return ONLY valid JSON, no other text:
{
  "contradictions": [
    {
      "new_decision_index": 1,
      "existing_decision_id": "uuid",
      "description": "one sentence describing the specific contradiction"
    }
  ]
}

If no contradictions, return: {"contradictions": []}`

  let result: {
    contradictions: Array<{ new_decision_index: number; existing_decision_id: string; description: string }>
  }

  try {
    const raw = await callHaiku(prompt)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    result = JSON.parse(jsonMatch?.[0] ?? '{"contradictions":[]}')
  } catch {
    return
  }

  for (const c of result.contradictions ?? []) {
    const idx = c.new_decision_index - 1
    if (idx < 0 || idx >= newDecisions.length) continue

    const { data: conflict } = await supabase
      .from('conflicts')
      .insert({
        decision_id_a:         newDecisions[idx].id,
        decision_id_b:         c.existing_decision_id,
        conflict_description:  c.description,
        status:                'unresolved',
      })
      .select('id')
      .single()

    if (conflict) {
      await supabase.from('hot_context').insert({
        context_type:    'flagged_conflict',
        project,
        content:         `Conflict detected: ${c.description}`,
        relevance_score: 1.0,
        urgency_score:   1.0,
        source_note_id:  noteId,
      })
    }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const { path, content, project } = await req.json()

    if (!path || !content) {
      return new Response(JSON.stringify({ error: 'path and content are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const fm               = parseFrontmatter(content)
    const effectiveProject = (project ?? fm.project ?? '').trim()

    // Step 0: establish the note in the notes table
    const noteId = await upsertNote(path, content, fm, effectiveProject)

    // Step 1: extract entities and decisions
    const { entities, decisions } = await runExtractionAgent(noteId, content, effectiveProject, fm)

    // Step 2: find and write semantic relationships
    await runRelationshipAgent(noteId, content, entities.map(e => e.id))

    // Step 3: detect and record contradictions
    await runContradictionAgent(noteId, effectiveProject, decisions)

    return new Response(JSON.stringify({
      success:             true,
      note_id:             noteId,
      entities_extracted:  entities.length,
      decisions_extracted: decisions.length,
    }), { headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('[intelligence-pipeline]', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
