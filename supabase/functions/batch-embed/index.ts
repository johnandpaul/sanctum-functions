import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const OBSIDIAN_API_URL = Deno.env.get("OBSIDIAN_API_URL")!
const OBSIDIAN_API_KEY = Deno.env.get("OBSIDIAN_API_KEY")!
const EMBED_URL = "https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/embed-note"

async function getAllNotes(folder = ""): Promise<string[]> {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${folder}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!response.ok) return []
  const data = await response.json()
  const files = data.files || []
  
  const notes: string[] = []
  for (const file of files) {
    if (file.endsWith('/')) {
      const subNotes = await getAllNotes(folder ? `${folder}${file}` : file)
      notes.push(...subNotes)
    } else if (file.endsWith('.md')) {
      notes.push(folder ? `${folder}${file}` : file)
    }
  }
  return notes
}

async function readNote(path: string): Promise<string> {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/${path}`, {
    headers: { "Authorization": `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!response.ok) return ""
  return await response.text()
}

function extractProject(content: string): string {
  const match = content.match(/^project:\s*(.+)$/m)
  return match ? match[1].trim() : ""
}

Deno.serve(async () => {
  try {
    const allNotes = await getAllNotes()
    const results = { success: 0, failed: 0, skipped: 0 }

    for (const path of allNotes) {
      const content = await readNote(path)
      if (!content || content.length < 50) { results.skipped++; continue }

      const project = extractProject(content)

      const response = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, project })
      })

      if (response.ok) {
        results.success++
      } else {
        results.failed++
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200))
    }

    return new Response(JSON.stringify({
      total: allNotes.length,
      ...results
    }), { headers: { 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})