import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
        outputDimensionality: 768
      })
    }
  )
  const data = await response.json()
  return data.embedding.values
}

Deno.serve(async (req) => {
  try {
    const { path, content, project } = await req.json()

    if (!path || !content) {
      return new Response(JSON.stringify({ error: 'path and content are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const embedding = await generateEmbedding(content)

    const { error } = await supabase
      .from('note_embeddings')
      .upsert({
        path,
        content,
        embedding,
        project: project || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'path' })

    if (error) throw error

    return new Response(JSON.stringify({ success: true, path }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})