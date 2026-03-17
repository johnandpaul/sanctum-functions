import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { postToLogs } from '../_shared/slack-logger.ts'

const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    // 1. Slack URL verification
    if (body.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const event = body.event

    // 2. Ignore bot messages
    if (event?.bot_id) {
      return new Response('OK', { status: 200 })
    }

    // 3. Only process message events with text or files
    if (event?.type !== 'message' || (!event.text && !event.files)) {
      return new Response('OK', { status: 200 })
    }

    let transcript = ''

    // 4. Voice/audio messages
    if (event.files && event.files[0]?.mimetype?.startsWith('audio/')) {
      try {
        const file = event.files[0]

        const audioResponse = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        })

        if (!audioResponse.ok) {
          throw new Error(`Failed to download audio: ${audioResponse.status}`)
        }

        const audioBlob = await audioResponse.blob()
        const formData = new FormData()
        formData.append('file', audioBlob, file.name || 'audio.m4a')
        formData.append('model', 'whisper-1')

        const whisperResponse = await fetch(
          'https://api.openai.com/v1/audio/transcriptions',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
            body: formData,
          }
        )

        if (!whisperResponse.ok) {
          throw new Error(`Whisper API error: ${whisperResponse.status}`)
        }

        const whisperData = await whisperResponse.json()
        transcript = whisperData.text
      } catch (err) {
        console.error('Audio transcription error:', err)
        return new Response('OK', { status: 200 })
      }
    } else {
      // 5. Text messages
      transcript = event.text
    }

    // Guard: skip empty or hallucinated transcripts
    const WHISPER_HALLUCINATIONS = [
      'thank you for watching',
      'thanks for watching',
      'please subscribe',
      'like and subscribe',
    ]
    const trimmed = transcript.trim()
    const isHallucination = WHISPER_HALLUCINATIONS.some(p => trimmed.toLowerCase().includes(p))
    if (!trimmed || trimmed.length < 3 || isHallucination) {
      return new Response('OK', { status: 200 })
    }

    // 6. Classification with Claude Haiku
    let category = 'general'
    let project = 'none'

    try {
      const classifyResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system:
            `You are a classifier for John's personal capture system. Given a personal note, return ONLY a JSON object with two fields: category and project. No explanation, no markdown, just the JSON object.\n\nCategories:\n- dtf: anything about Dallas Tub Fix (bathtub repair business, customers, jobs, suppliers, materials, scheduling, DTF)\n- turnkey: anything about TurnKey (make-ready coordination tool for property managers)\n- sigyls: anything about Sigyls (AI-native platform, Foundry, Workshop, The Loom)\n- personal: personal life, family, health, faith, finances\n- task: a to-do or action item not clearly tied to a specific project\n- general: anything that doesn't fit the above\n\nProject field: use the most specific project name (dallas-tub-fix, turnkey, sigyls, sanctum, sono) or 'none' if unclear.`,
          messages: [{ role: 'user', content: transcript }],
        }),
      })

      if (!classifyResponse.ok) {
        throw new Error(`Classification API error: ${classifyResponse.status}`)
      }

      const classifyData = await classifyResponse.json()
      const rawText = classifyData.content[0].text.trim()
      const cleanText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(cleanText)
      category = parsed.category ?? 'general'
      project = parsed.project ?? 'none'
    } catch (err) {
      console.error('Classification error:', err)
    }

    // 7. Insert to Supabase capture_inbox
    try {
      const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/capture_inbox`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          raw_text: transcript,
          category,
          project,
          source: 'slack',
          processed: false,
        }),
      })

      if (!insertResponse.ok) {
        const errorText = await insertResponse.text()
        throw new Error(`Supabase insert error: ${insertResponse.status} — ${errorText}`)
      }
    } catch (err) {
      console.error('Supabase insert error:', err)
    }

    // Log success to #logs
    await postToLogs(`*slack-capture* ✓ ${category} — ${project} | "${transcript.slice(0, 60)}${transcript.length > 60 ? '…' : ''}"`)

    // 8. Post confirmation back to Slack
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
          channel: event.channel,
          text: `✓ Logged as ${category} — ${project}`,
        }),
      })
    } catch (err) {
      console.error('Slack post error:', err)
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('Unhandled error:', err)
    await postToLogs(`*slack-capture* ⚠️ Unhandled error: ${err instanceof Error ? err.message : String(err)}`)
    return new Response('OK', { status: 200 })
  }
})
