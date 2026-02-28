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

app.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

Deno.serve(app.fetch)