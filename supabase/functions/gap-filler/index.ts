import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

function encodedVaultPath(path: string): string {
  return path.split('/').map((s: string) => s ? encodeURIComponent(s) : s).join('/');
}

// Get all notes from vault recursively
async function getAllNotes(): Promise<{path: string, content: string}[]> {
  const notes: {path: string, content: string}[] = [];
  
  async function readFolder(folderPath: string) {
    const response = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath)}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (!response.ok) return;
    const data = await response.json();
    
    for (const file of data.files || []) {
      if (file.endsWith('/')) {
        // It's a subfolder — recurse into it
        await readFolder(`${folderPath}${file}`);
      } else if (file.endsWith('.md') && !file.includes('_templates')) {
        // It's a markdown note — read it
        const noteResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(folderPath + file)}`, {
          headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
        });
        if (noteResponse.ok) {
          const content = await noteResponse.text();
          notes.push({ path: `${folderPath}${file}`, content });
        }
      }
    }
  }
  
  await readFolder('');
  return notes;
}

// Extract frontmatter summary from note content
function extractSummary(content: string, maxLength = 300): string {
  const lines = content.split('\n');
  const summaryMatch = content.match(/## Summary\n([\s\S]*?)(\n##|$)/);
  if (summaryMatch) return summaryMatch[1].trim().slice(0, maxLength);
  // Fall back to first non-frontmatter paragraph
  let inFrontmatter = false;
  for (const line of lines) {
    if (line === '---') { inFrontmatter = !inFrontmatter; continue; }
    if (!inFrontmatter && line.trim() && !line.startsWith('#')) {
      return line.slice(0, maxLength);
    }
  }
  return '';
}

Deno.serve(async (req) => {
  try {
    // Get all vault notes
    const notes = await getAllNotes();
    
    if (notes.length < 2) {
      return new Response(JSON.stringify({ message: "Not enough notes to analyze" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Build index for Claude — titles, paths, and summaries
    const noteIndex = notes.map(n => ({
      path: n.path,
      title: n.path.split('/').pop()?.replace('.md', '') || n.path,
      summary: extractSummary(n.content),
      tags: (n.content.match(/^tags:\s*\[(.+)\]/m) || [])[1] || '',
      project: (n.content.match(/^project:\s*(.+)$/m) || [])[1]?.trim() || '',
      existingLinks: [...n.content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1])
    }));
    noteIndex.sort((a, b) => a.existingLinks.length - b.existingLinks.length);
    // Send to Claude for gap analysis
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are a knowledge graph analyst for John's personal Obsidian vault. Analyze these notes and identify missing connections that would strengthen the knowledge graph. Prioritize notes with zero or very few existing links - these are the most isolated and need connections most urgently.

Note index:
${JSON.stringify(noteIndex, null, 2)}

Identify:
1. Notes that should be linked to each other but aren't yet
2. Orphaned notes with no connections
3. Missing bridging concepts that would connect clusters

Respond ONLY with a JSON object in this exact format:
{
  "proposed_connections": [
    {
      "from_note": "exact filename without .md",
      "to_note": "exact filename without .md", 
      "reason": "one sentence explaining the connection",
      "strength": "strong|medium|weak"
    }
  ],
  "orphaned_notes": ["filename1", "filename2"],
  "missing_concepts": ["concept that would bridge X and Y notes"]
}`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const analysisText = claudeData.content[0].text;
    
    // Parse Claude's response
    const cleanJson = analysisText.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(cleanJson);

    // Write gap analysis note to inbox
    const today = new Date().toISOString().split("T")[0];
    const fileName = `00-inbox/${today}-gap-analysis.md`;
    
    const gapNote = `---
type: gap-analysis
status: pending-review
tags: [sanctum/gap-analysis]
created: ${today}
source: gap-filler-agent
notes_analyzed: ${notes.length}
---

# Gap Analysis ${today}

## Proposed Connections
${analysis.proposed_connections.map((c: any) => 
  `- **${c.strength}** | [[${c.from_note}]] → [[${c.to_note}]]\n  *${c.reason}*`
).join('\n')}

## Orphaned Notes
${analysis.orphaned_notes.map((n: string) => `- [[${n}]]`).join('\n') || '- None found'}

## Missing Concepts
${analysis.missing_concepts.map((c: string) => `- ${c}`).join('\n') || '- None identified'}

## Instructions
Review each proposed connection above. Delete any connections you don't want applied.
When ready, click "Approve & Apply" in the email notification.
`;

    const writeResponse = await fetch(`${OBSIDIAN_API_URL}/vault/${encodedVaultPath(fileName)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${OBSIDIAN_API_KEY}`,
        'Content-Type': 'text/markdown'
      },
      body: gapNote
    });

    if (!writeResponse.ok) {
      return new Response(JSON.stringify({ error: 'Failed to write gap analysis note' }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // Post to Slack #digest with Block Kit message
    const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
    const obsidianLink = `obsidian://open?vault=Vault&file=00-inbox%2F${today}-gap-analysis`;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
      },
      body: JSON.stringify({
        channel: 'C0ALJT1SX6K',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🔗 Gap Analysis Ready' }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Notes analyzed:* ${notes.length}\n*Connections proposed:* ${analysis.proposed_connections.length}\n*Orphaned notes:* ${analysis.orphaned_notes.length}`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '📓 Open in Obsidian' },
                url: obsidianLink
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '✅ Approve & Apply' },
                style: 'primary',
                action_id: 'approve_gap_connections',
                value: `${today}-gap-analysis`
              }
            ]
          }
        ]
      })
    });

    return new Response(JSON.stringify({
      success: true,
      notes_analyzed: notes.length,
      connections_proposed: analysis.proposed_connections.length,
      orphaned_notes: analysis.orphaned_notes.length,
      file: fileName
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});