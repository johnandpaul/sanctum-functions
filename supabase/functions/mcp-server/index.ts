import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'
import { Hono } from 'npm:hono@^4.9.7'
import { z } from 'npm:zod@^4.1.13'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;

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
- 
`;
  const fileName = `00-inbox/${today}-${title.toLowerCase().replace(/\s+/g, "-")}.md`;
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${fileName}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown",
    },
    body: note,
  });
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

server.registerTool('get_inbox', {
  title: 'Get Inbox',
  description: "Get recent notes from John's vault inbox.",
  inputSchema: { limit: z.number().optional().describe("Number of notes to return, default 5") }
}, async ({ limit = 5 }) => {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!response.ok) return { content: [{ type: "text", text: "Inbox is empty" }] };
  const data = await response.json();
  const files = (data.files || []).slice(0, limit).join("\n");
  return { content: [{ type: "text", text: files || "Inbox is empty" }] };
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
  return {
    content: [{ type: "text", text: response.ok ? `✅ Artifact saved to: ${fileName}` : `❌ Failed to save artifact` }]
  };
})

server.registerTool('file_note', {
  title: 'File Note',
  description: "Move a note from the inbox to the correct PARA folder based on its project. Use when saving a note that belongs to a specific project rather than dropping it in inbox.",
  inputSchema: {
    filename: z.string().describe("The filename without path, e.g. 2026-02-28-my-note.md"),
    project: z.string().describe("Project name: sigyls, dallas-tub-fix, sanctum, or area name like personal/finance")
  }
}, async ({ filename, project }) => {
  // Read the note from inbox
  const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${filename}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!readResponse.ok) return { content: [{ type: "text", text: `❌ Note not found in inbox: ${filename}` }] };
  const content = await readResponse.text();

  // Determine destination folder
  const folderMap: Record<string, string> = {
    "sigyls": "01-projects/sigyls",
    "dallas-tub-fix": "01-projects/dallas-tub-fix",
    "sanctum": "01-projects/sanctum",
    "personal": "02-areas/personal",
    "finance": "02-areas/finance",
    "family": "02-areas/family",
  };
  const folder = folderMap[project] || `02-areas/${project}`;

  // Write to destination
  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${folder}/${filename}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown",
    },
    body: content,
  });
  if (!writeResponse.ok) return { content: [{ type: "text", text: `❌ Failed to write to ${folder}` }] };

  // Delete from inbox
  const deleteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${filename}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });

  return {
    content: [{ type: "text", text: deleteResponse.ok ? `✅ Filed to ${folder}/${filename}` : `⚠️ Copied to ${folder} but inbox copy remains` }]
  };
})

server.registerTool('organize_inbox', {
  title: 'Organize Inbox',
  description: "Automatically file all notes in the vault inbox to their correct PARA folders based on their project frontmatter tags. Use when John says 'organize my inbox' or 'file my notes'.",
  inputSchema: {}
}, async () => {
  // Get inbox contents
  const listResponse = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!listResponse.ok) return { content: [{ type: "text", text: "❌ Could not read inbox" }] };
  const data = await listResponse.json();
  const files = (data.files || []).filter((f: string) => f.endsWith('.md'));

  if (!files.length) return { content: [{ type: "text", text: "✅ Inbox is already empty" }] };

  const results: string[] = [];
  const folderMap: Record<string, string> = {
    "sigyls": "01-projects/sigyls",
    "dallas-tub-fix": "01-projects/dallas-tub-fix",
    "sanctum": "01-projects/sanctum",
    "personal": "02-areas/personal",
    "finance": "02-areas/finance",
    "family": "02-areas/family",
  };

  for (const filename of files) {
    // Read note content
    const readResponse = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${filename}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (!readResponse.ok) { results.push(`❌ Could not read: ${filename}`); continue; }
    const content = await readResponse.text();

    // Extract project from frontmatter
    const projectMatch = content.match(/^project:\s*(.+)$/m);
    const project = projectMatch ? projectMatch[1].trim() : "";

    if (!project) { results.push(`⏭️ Skipped (no project): ${filename}`); continue; }

    const folder = folderMap[project] || `02-areas/${project}`;

    // Write to destination
    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${folder}/${filename}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
        "Content-Type": "text/markdown",
      },
      body: content,
    });
    if (!writeResponse.ok) { results.push(`❌ Failed to file: ${filename}`); continue; }

    // Delete from inbox
    await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${filename}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });

    results.push(`✅ ${filename} → ${folder}`);
  }

  return { content: [{ type: "text", text: results.join("\n") }] };
})

app.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

Deno.serve(app.fetch)