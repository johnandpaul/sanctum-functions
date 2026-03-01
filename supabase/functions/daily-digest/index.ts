import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const DIGEST_FROM_EMAIL = Deno.env.get("DIGEST_FROM_EMAIL")!;
const DIGEST_TO_EMAIL = Deno.env.get("DIGEST_TO_EMAIL")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Get recent vault notes for context
async function getRecentVaultContext(): Promise<string> {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!response.ok) return "No recent vault context available.";
  const data = await response.json();
  const files = (data.files || []).filter((f: string) => f.endsWith('.md')).slice(0, 5);
  
  const notes: string[] = [];
  for (const file of files) {
    const noteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${file}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (noteResponse.ok) {
      const content = await noteResponse.text();
      const title = file.replace('.md', '');
      const summary = content.match(/## Summary\n([\s\S]*?)(\n##|$)/)?.[1]?.trim().slice(0, 200) || '';
      notes.push(`- ${title}: ${summary}`);
    }
  }
  return notes.join('\n') || "No recent notes found.";
}

// Generate digest using Claude
async function generateDigest(vaultContext: string): Promise<any[]> {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      tools: [{
        type: "web_search_20250305",
        name: "web_search"
      }],
      messages: [{
        role: 'user',
        content: `You are John's personal AI intelligence assistant running a daily AI news digest.

John's profile based on his vault context:
${vaultContext}

Additional context:
- Runs Dallas Tub Fix (bathtub repair business in DFW area, Lavon TX)
- Building Sigyls (AI-native SaaS platform with Ada conversational UX, ARIA framework)
- Runs Sono AI (automation consultancy)
- Deep interest in AI agents, MCP protocol, edge computing, entrepreneurship, small business AI
- Family man with infant child, limited dev time on weekdays

Today is ${today}. Search the web for AI news, tools, technologies, and announcements published yesterday between 12:00am and 11:59pm only. No exceptions on the date range.

Filter for anything relevant to John's businesses, interests, and goals. Include everything that scores 4 or above. Sort results highest score first.

After the main items, identify any Foresight Flags — items that may not be immediately useful today but signal a meaningful shift coming in the next 6 months.

Respond ONLY with a valid JSON object in this exact format, no preamble, no markdown fences:

{
  "items": [
    {
      "headline": "article title",
      "summary": "2-3 sentence summary of what happened",
      "why_it_matters": "one sentence specific to John's businesses and goals — never generic",
      "score": 7.5,
      "category": "Automation | AI Agents | Small Business AI | Tools & Platforms | AI Infrastructure | Other",
      "relevance": "Dallas Tub Fix | Sono AI | Sigyls | General Interest",
      "availability": "Available now | Coming soon | Announced only",
      "source_type": "Primary | Secondary",
      "recommended_action": "Read now | Bookmark for later | Share with clients | Watch and wait",
      "source": "publication name",
      "url": "article url",
      "is_foresight_flag": false,
      "six_month_signal": ""
    }
  ]
}`
      }]
    })
  });

  const data = await response.json();
  
  // Extract text from response — may contain tool use blocks
  const textBlock = data.content?.find((b: any) => b.type === 'text');
  if (!textBlock) throw new Error('No text response from Claude');
  
  const clean = textBlock.text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Build HTML email
function buildEmailHTML(items: any[], date: string, baseUrl: string): string {
  const itemsHTML = items.map((item, i) => {
    const scoreColor = item.score >= 8 ? '#22c55e' : item.score >= 6 ? '#f59e0b' : '#94a3b8';
    const actionUrl = (action: string) => `${baseUrl}/functions/v1/digest-action?item=${i}&action=${action}&headline=${encodeURIComponent(item.headline)}&summary=${encodeURIComponent(item.summary)}&url=${encodeURIComponent(item.url || '')}&category=${encodeURIComponent(item.category)}`;
    
    return `
    <div style="background:#1e293b;border-radius:12px;padding:20px;margin-bottom:16px;border-left:4px solid ${scoreColor};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <span style="background:#334155;color:#94a3b8;font-size:11px;padding:3px 8px;border-radius:4px;">${item.category}</span>
        <span style="color:${scoreColor};font-weight:700;font-size:16px;">${item.score}/10</span>
      </div>
      <h3 style="color:#f1f5f9;margin:8px 0;font-size:16px;line-height:1.4;">${item.headline}</h3>
      <p style="color:#94a3b8;margin:0 0 8px;font-size:14px;line-height:1.6;">${item.summary}</p>
      <p style="color:#60a5fa;margin:0 0 16px;font-size:13px;font-style:italic;">💡 ${item.relevance}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="${actionUrl('sigyls')}" style="background:#6366f1;color:white;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">→ Sigyls</a>
        <a href="${actionUrl('dallas-tub-fix')}" style="background:#0ea5e9;color:white;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">→ DTF</a>
        <a href="${actionUrl('sanctum')}" style="background:#8b5cf6;color:white;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">→ Sanctum</a>
        <a href="${actionUrl('new')}" style="background:#334155;color:#e2e8f0;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">+ New Topic</a>
        <a href="${actionUrl('archive')}" style="background:#1e293b;color:#64748b;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;border:1px solid #334155;">Archive</a>
        ${item.url ? `<a href="${item.url}" style="background:#1e293b;color:#64748b;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;border:1px solid #334155;">Read →</a>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0f172a;margin:0;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="text-align:center;margin-bottom:24px;">
      <h1 style="color:#f1f5f9;margin:0;font-size:24px;">⚡ Daily Intelligence Digest</h1>
      <p style="color:#64748b;margin:4px 0 0;">${date}</p>
    </div>
    ${itemsHTML}
    <div style="text-align:center;margin-top:24px;">
      <p style="color:#334155;font-size:12px;">Sanctum Intelligence Layer · Dallas Tub Fix · Sigyls · Sono AI</p>
    </div>
  </div>
</body>
</html>`;
}

Deno.serve(async (req) => {
  try {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const baseUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co');

    // Get vault context
    const vaultContext = await getRecentVaultContext();

    // Generate digest
    const items = await generateDigest(vaultContext);

    // Build email
    const html = buildEmailHTML(items, today, baseUrl);

    // Send via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: DIGEST_FROM_EMAIL,
        to: DIGEST_TO_EMAIL,
        subject: `⚡ Daily Digest — ${today}`,
        html
      })
    });

    if (!emailResponse.ok) {
      const err = await emailResponse.json();
      return new Response(JSON.stringify({ error: 'Email failed', details: err }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: true, items_sent: items.length, date: today }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});