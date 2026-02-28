import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;
const SANCTUM_WEBHOOK_SECRET = Deno.env.get("SANCTUM_WEBHOOK_SECRET")!;

serve(async (req) => {
  // Verify webhook secret
  const authHeader = req.headers.get("x-webhook-secret");
  if (authHeader !== SANCTUM_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse incoming brainstorm data
  const body = await req.json();
  const { title, summary, insights, actions, raw, project, tags } = body;

  // Build the date
  const today = new Date().toISOString().split("T")[0];

  // Format tags for frontmatter
  const tagList = tags ? tags.join(", ") : "";

  // Build the markdown note
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
${summary || ""}

## Key Insights
${insights ? insights.map((i: string) => `- ${i}`).join("\n") : "- "}

## Action Items
${actions ? actions.map((a: string) => `- [ ] ${a}`).join("\n") : "- [ ] "}

## Raw Notes
${raw || ""}

## Related
- 
`;

  // Write to Obsidian via Local REST API
  const fileName = `00-inbox/${today}-${title.toLowerCase().replace(/\s+/g, "-")}.md`;

  const obsidianResponse = await fetch(
    `${OBSIDIAN_API_URL}/vault/${fileName}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
        "Content-Type": "text/markdown",
      },
      body: note,
    }
  );

  if (!obsidianResponse.ok) {
    return new Response(
      JSON.stringify({ error: "Failed to write to Obsidian" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ 
      success: true, 
      file: fileName,
      message: `Note saved to vault: ${fileName}`
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});