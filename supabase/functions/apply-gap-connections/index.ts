import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!;
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!;

async function getNoteContent(path: string): Promise<string | null> {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  });
  if (!response.ok) return null;
  return await response.text();
}

async function writeNoteContent(path: string, content: string): Promise<boolean> {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${OBSIDIAN_API_KEY}`,
      "Content-Type": "text/markdown"
    },
    body: content
  });
  return response.ok;
}

async function findNotePath(filename: string): Promise<string | null> {
  // Search common folders for the note
  const folders = ['00-inbox/', '01-projects/sigyls/', '01-projects/dallas-tub-fix/', '01-projects/sanctum/', '01-projects/sono/', '01-projects/turnkey/', '02-areas/', '03-resources/'];
  for (const folder of folders) {
    const response = await fetch(`${OBSIDIAN_API_URL}/vault/${folder}`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    if (!response.ok) continue;
    const data = await response.json();
    const match = (data.files || []).find((f: string) => f === `${filename}.md` || f === filename);
    if (match) return `${folder}${match}`;
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    // Find the gap analysis note
    const inboxResponse = await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/`, {
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });
    const inboxData = await inboxResponse.json();
    const gapFile = (inboxData.files || []).find((f: string) => f.includes('gap-analysis'));
    
    if (!gapFile) {
      return new Response(JSON.stringify({ error: 'No gap analysis note found in inbox' }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const gapContent = await getNoteContent(`00-inbox/${gapFile}`);
    if (!gapContent) {
      return new Response(JSON.stringify({ error: 'Could not read gap analysis note' }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Parse proposed connections from note
    const connectionRegex = /\[\[([^\]]+)\]\] → \[\[([^\]]+)\]\]/g;
    const connections: {from: string, to: string}[] = [];
    let match;
    while ((match = connectionRegex.exec(gapContent)) !== null) {
      connections.push({ from: match[1], to: match[2] });
    }

    if (connections.length === 0) {
      return new Response(JSON.stringify({ error: 'No connections found in gap analysis note' }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Apply each connection
    const results: string[] = [];
    for (const conn of connections) {
      const fromPath = await findNotePath(conn.from);
      if (!fromPath) {
        results.push(`❌ Could not find note: ${conn.from}`);
        continue;
      }

      const content = await getNoteContent(fromPath);
      if (!content) {
        results.push(`❌ Could not read: ${conn.from}`);
        continue;
      }

      // Check if link already exists
      if (content.includes(`[[${conn.to}]]`)) {
        results.push(`⏭️ Already linked: ${conn.from} → ${conn.to}`);
        continue;
      }

      // Add wikilink, appending to existing ## Related section or creating one
      const relatedIndex = content.lastIndexOf('## Related');
      let updatedContent: string;
      if (relatedIndex !== -1) {
        const insertPos = content.indexOf('\n', relatedIndex) + 1;
        updatedContent = content.slice(0, insertPos) + `[[${conn.to}]]\n` + content.slice(insertPos);
      } else {
        updatedContent = content.trimEnd() + `\n\n## Related\n[[${conn.to}]]\n`;
      }
      const written = await writeNoteContent(fromPath, updatedContent);
      
      if (written) {
        results.push(`✅ Linked: [[${conn.from}]] → [[${conn.to}]]`);
      } else {
        results.push(`❌ Failed to write: ${conn.from}`);
      }
    }

    // Archive the gap analysis note
    const archiveContent = gapContent.replace(/^status:\s*.+$/m, 'status: archived');
    await writeNoteContent(`04-archive/${gapFile}`, archiveContent);
    await fetch(`${OBSIDIAN_API_URL}/vault/00-inbox/${gapFile}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
    });

    return new Response(JSON.stringify({
      success: true,
      connections_applied: results.filter(r => r.startsWith('✅')).length,
      skipped: results.filter(r => r.startsWith('⏭️')).length,
      failed: results.filter(r => r.startsWith('❌')).length,
      details: results,
      archived: `04-archive/${gapFile}`
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