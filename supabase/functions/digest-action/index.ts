import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;

const FOLDER_MAP: Record<string, string> = {
  "sigyls": "01-projects/sigyls",
  "dallas-tub-fix": "01-projects/dallas-tub-fix",
  "sanctum": "01-projects/sanctum",
  "sono": "01-projects/sono",
  "turnkey": "01-projects/turnkey",
  "archive": "04-archive/digest",
  "intelligence": "02-areas/intelligence",
};

function successPage(message: string): Response {
  const redirectUrl = `https://johnandpaul.github.io/sanctum-functions/success.html?message=${encodeURIComponent(message)}`;
  return new Response(null, {
    status: 302,
    headers: { "Location": redirectUrl }
  });
}

function newTopicPage(params: URLSearchParams): Response {
  const headline = params.get('headline') || '';
  const summary = params.get('summary') || '';
  const url = params.get('url') || '';
  const category = params.get('category') || '';
  const score = params.get('score') || '';

  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>New Topic — Sanctum</title>
</head>
<body style="background:#0f172a;margin:0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:400px;margin:0 auto;">
    <h2 style="color:#f1f5f9;margin:0 0 8px;">New Topic</h2>
    <p style="color:#64748b;margin:0 0 24px;font-size:14px;">${headline}</p>
    <input id="topic" type="text" placeholder="Topic name (e.g. Quantum Computing)" 
      style="width:100%;box-sizing:border-box;background:#1e293b;border:1px solid #334155;color:#f1f5f9;padding:12px;border-radius:8px;font-size:16px;margin-bottom:16px;">
    <button onclick="save()" 
      style="width:100%;background:#6366f1;color:white;border:none;padding:14px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;">
      Save to Vault
    </button>
  </div>
  <script>
    async function save() {
      const topic = document.getElementById('topic').value.trim();
      if (!topic) return;
      const url = new URL(window.location.href);
      url.searchParams.set('action', 'new-confirmed');
      url.searchParams.set('topic', topic);
      window.location.href = url.toString();
    }
    document.getElementById('topic').addEventListener('keydown', e => {
      if (e.key === 'Enter') save();
    });
  </script>
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  const action = params.get('action') || '';
  const headline = params.get('headline') || 'Untitled';
  const summary = params.get('summary') || '';
  const articleUrl = params.get('url') || '';
  const category = params.get('category') || '';
  const score = params.get('score') || '';
  const relevance = params.get('relevance') || '';
  const whyItMatters = params.get('why') || '';
  const recommendedAction = params.get('rec') || '';

  const today = new Date().toLocaleString("en-CA", { timeZone: "America/Chicago" }).split(",")[0];
  const safeTitle = headline.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 60);
  const fileName = `${today}-digest-${safeTitle}.md`;

  // Show new topic input page
  if (action === 'new') {
    return newTopicPage(params);
  }

  // Handle archive — save to archive folder
  if (action === 'archive') {
    const content = `---
type: digest-item
status: archived
score: ${score}
category: ${category}
source_url: ${articleUrl}
date: ${today}
---

# ${headline}

${summary}

${articleUrl ? `[Read article](${articleUrl})` : ''}

## Related
- [[2026-03-16-ai-daily-digest--master-index]]
`;
    await fetch(`${OBSIDIAN_API_URL}/vault/04-archive/digest/${fileName}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: content
    });
    return successPage("Archived");
  }

  // Handle new topic confirmed
  if (action === 'new-confirmed') {
    const topic = params.get('topic') || 'new-topic';
    const folderName = topic.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const folder = `02-areas/${folderName}`;
    const content = `---
type: digest-item
status: saved
score: ${score}
category: ${category}
topic: ${topic}
source_url: ${articleUrl}
date: ${today}
---

# ${headline}

${summary}

💡 ${whyItMatters}

${articleUrl ? `[Read article](${articleUrl})` : ''}

## Related
- [[2026-03-16-ai-daily-digest--master-index]]
`;
    await fetch(`${OBSIDIAN_API_URL}/vault/${folder}/${fileName}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
      body: content
    });
    return successPage(`Saved to ${topic}`);
  }

  // Handle project saves
  const folder = FOLDER_MAP[action] || "02-areas/intelligence";
  const projectLabel = action.charAt(0).toUpperCase() + action.slice(1).replace(/-/g, ' ');

  const content = `---
type: digest-item
status: saved
score: ${score}
category: ${category}
relevance: ${relevance}
source_url: ${articleUrl}
recommended_action: ${recommendedAction}
date: ${today}
project: ${action}
---

# ${headline}

${summary}

💡 ${whyItMatters}

✅ Recommended: ${recommendedAction}

${articleUrl ? `[Read article](${articleUrl})` : ''}

## Related
- [[2026-03-16-ai-daily-digest--master-index]]
`;

  const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${folder}/${fileName}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}`, "Content-Type": "text/markdown" },
    body: content
  });

  if (!writeResponse.ok) {
    return new Response("Failed to save to vault", { status: 500 });
  }

  return successPage(`Saved to ${projectLabel}`);
});