import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'
import { Hono } from 'npm:hono@^4.9.7'
import { z } from 'npm:zod@^4.1.13'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const app = new Hono()
const server = new McpServer({ name: 'sanctum-vault', version: '1.0.0' })

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
    tags: z.array(z.string()).optional().describe("Hierarchical tags like sigyls/strategy")
  }
}, async ({ title, summary, insights, actions, raw, project, tags }) => {
  const today = new Date().toISOString().split("T")[0];
  const tagList = tags ? tags.join(", ") : "";
  const note = `---
type: brainstorm
status: active
tags: [${tagList}]
created: ${today}
source: claude-chat
project: ${project || ""}
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
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${fileName}`, {
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
  }

  return {
    content: [{ type: "text", text: response.ok ? `✅ Saved to vault: ${fileName}` : `❌ Failed to save note` }]
  };
})

server.registerTool('search_vault', {
  title: 'Search Vault',
  description: "Search John's Obsidian vault for notes related to a topic.",
  inputSchema: { query: z.string().describe("Search term or topic") }
}, async ({ query }) => {
  const response = await fetch(
    `${OBSIDIAN_API_URL}/search/simple/?query=${encodeURIComponent(query)}&contextLength=100`,
    { headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` } }
  );
  if (!response.ok) return { content: [{ type: "text", text: "Search failed" }] };
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
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!response.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] };
  const content = await response.text();
  return {
    content: [{ type: "text", text: `📄 ${path}\n\n${content}` }]
  };
})

server.registerTool('save_artifact', {
  title: 'Save Artifact',
  description: "Save an artifact, document, specification, or reference material to John's Obsidian vault. Use when John wants to save a document, spec, design, diagram description, or any structured reference content. Files to 03-resources unless a project is specified.",
  inputSchema: {
    title: z.string().describe("Short descriptive title for the artifact"),
    content: z.string().describe("The full content of the artifact"),
    summary: z.string().describe("2-3 sentence description of what this artifact is and why it matters"),
    project: z.string().optional().describe("Project: sigyls, dallas-tub-fix, sanctum, or leave empty for general resources"),
    tags: z.array(z.string()).optional().describe("Hierarchical tags like sigyls/architecture or sigyls/ux-design"),
    artifact_type: z.string().optional().describe("Type of artifact: spec, design, diagram, research, template, other")
  }
}, async ({ title, summary, content, project, tags, artifact_type }) => {
  const today = new Date().toISOString().split("T")[0];
  const tagList = tags ? tags.join(", ") : "";
  const folder = project
    ? `01-projects/${project}`
    : `03-resources`;

  const note = `---
type: resource
artifact_type: ${artifact_type || "other"}
status: active
tags: [${tagList}]
created: ${today}
source: claude-chat
project: ${project || ""}
---

# ${title}

## Summary
${summary}

## Content
${content}
`;

  const fileName = `${folder}/${today}-${title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}.md`;
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${fileName}`, {
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
  }

  return {
    content: [{ type: "text", text: response.ok ? `✅ Artifact saved to: ${fileName}` : `❌ Failed to save artifact` }]
  };
})

server.registerTool('semantic_search', {
  title: 'Semantic Search',
  description: "Search John's Obsidian vault by meaning rather than keywords. Finds notes that are conceptually related to the query even if they don't contain the exact words.",
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
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
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
    value: z.string().optional().describe("New value for the frontmatter field (for frontmatter mode)")
  }
}, async ({ path, mode, content, find, replace, field, value }) => {
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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
    const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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
      const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${source_path}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Source not found: ${source_path}` }] };
  const content = await readResponse.text();

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${destination_path}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content,
  });
  if (!writeResponse.ok) return { content: [{ type: "text", text: `❌ Failed to write to: ${destination_path}` }] };

  const deleteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${source_path}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });

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

  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] };
  const content = await readResponse.text();

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${new_path}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content,
  });
  if (!writeResponse.ok) return { content: [{ type: "text", text: `❌ Failed to write to: ${new_path}` }] };

  const deleteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });

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
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${notePath}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (!readResponse.ok) { results.push(`❌ Not found: ${notePath}`); continue; }
    let noteContent = await readResponse.text();

    const regex = new RegExp(`^(${field}:\\s*)(.+)$`, "m");
    if (!regex.test(noteContent)) { results.push(`⚠️ Field "${field}" not found: ${notePath}`); continue; }
    noteContent = noteContent.replace(regex, `$1${value}`);

    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${notePath}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: noteContent,
    });
    results.push(writeResponse.ok ? `✅ Updated: ${notePath}` : `❌ Failed to write: ${notePath}`);
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
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Note not found: ${path}` }] };
  const noteContent = await readResponse.text();

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

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
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
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${placeholderPath}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: "",
  })
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
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanPath}/`, {
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
    const delResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanPath}/${file}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    results.push(delResponse.ok ? `✅ Deleted: ${file}` : `❌ Failed to delete: ${file}`)
  }
  const summary = results.length > 0 ? results.join('\n') + '\n' : ''
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
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanPath}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!listResponse.ok) {
    return { content: [{ type: "text", text: `❌ Folder not found: ${cleanPath}` }] }
  }
  const listing = await listResponse.json()
  const files: string[] = listing.files ?? []
  const results: string[] = []
  for (const file of files) {
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanPath}/${file}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!readResponse.ok) { results.push(`❌ Failed to read: ${file}`); continue }
    const content = await readResponse.text()
    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${newPath}/${file}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: content,
    })
    if (!writeResponse.ok) { results.push(`❌ Failed to write: ${file}`); continue }
    const delResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanPath}/${file}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    results.push(delResponse.ok ? `✅ ${file}` : `⚠️ Copied but failed to delete: ${file}`)
  }
  const summary = results.length > 0 ? '\n' + results.join('\n') : ' (empty folder)'
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
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanSource}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!listResponse.ok) {
    return { content: [{ type: "text", text: `❌ Folder not found: ${cleanSource}` }] }
  }
  const listing = await listResponse.json()
  const files: string[] = listing.files ?? []
  const results: string[] = []
  for (const file of files) {
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanSource}/${file}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    if (!readResponse.ok) { results.push(`❌ Failed to read: ${file}`); continue }
    const content = await readResponse.text()
    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanDest}/${file}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: content,
    })
    if (!writeResponse.ok) { results.push(`❌ Failed to write: ${file}`); continue }
    const delResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${cleanSource}/${file}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    })
    results.push(delResponse.ok ? `✅ ${file}` : `⚠️ Copied but failed to delete: ${file}`)
  }
  const summary = results.length > 0 ? '\n' + results.join('\n') : ' (empty folder)'
  return {
    content: [{ type: "text", text: `✅ Moved: ${cleanSource} → ${cleanDest}\nMoved ${files.length} file${files.length !== 1 ? 's' : ''}${summary}` }]
  }
})

server.registerTool('vault_health_check', {
  title: 'Vault Health Check',
  description: "Scan John's entire Obsidian vault and return a structured health report identifying: missing project frontmatter, duplicate Related sections, phantom folders (folder names that look like dated note titles), notes filed in wrong project folders, and sparse notes with minimal content.",
  inputSchema: {}
}, async () => {
  async function getAllVaultNotes(folderPath = ''): Promise<string[]> {
    const urlPath = folderPath ? `${folderPath}/` : ''
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${urlPath}`, {
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

  const allNotes = await getAllVaultNotes()

  const missingProject: string[] = []
  const duplicateRelated: { path: string, count: number }[] = []
  const phantomFolders = new Set<string>()
  const wrongFolder: { path: string, project: string, expected: string }[] = []
  const sparseNotes: string[] = []

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
    const res = await fetch(`${OBSIDIAN_API_URL}/vault/${notePath}`, {
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
  const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${folderPath}/`, {
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
  const noteRes = await fetch(`${OBSIDIAN_API_URL}/vault/${notePath}`, {
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
  const listRes = await fetch(`${OBSIDIAN_API_URL}/vault/${folderPath}/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (listRes.ok) {
    const data = await listRes.json()
    const existingStatus = (data.files || [])
      .filter((f: string) => f.toLowerCase().includes('status') && f.endsWith('.md'))
      .sort()
      .reverse()[0]
    if (existingStatus && existingStatus !== 'status.md') {
      await fetch(`${OBSIDIAN_API_URL}/vault/${folderPath}/${existingStatus}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
      })
    }
  }

  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${targetPath}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content,
  })
  return {
    content: [{ type: "text", text: writeRes.ok
      ? `✅ Status updated: ${targetPath}`
      : `❌ Failed to write status note for project: ${project}` }]
  }
})

app.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

Deno.serve(app.fetch)