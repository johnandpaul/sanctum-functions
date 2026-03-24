import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { postToLogs } from '../_shared/slack-logger.ts'

const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MCP_URL = 'https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/mcp-server'
const MCP_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

async function postToSlack(channel: string, text: string) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, text })
  })
}

async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MCP_ANON_KEY}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
  })
  if (!response.ok) throw new Error(`MCP call failed: ${response.status}`)
  const data = await response.json()
  return data?.result?.content?.[0]?.text ?? '(no response)'
}

async function getUnprocessedInbox(): Promise<string> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/capture_inbox?processed=eq.false&select=id,raw_text,category,project,created_at&order=created_at.desc&limit=10`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  )
  if (!response.ok) throw new Error(`Supabase query failed: ${response.status}`)
  const rows = await response.json()
  if (!rows.length) return '✅ No unprocessed items in capture inbox.'
  const lines = rows.map((r: { category: string; project: string; raw_text: string }) =>
    `• [${r.category}/${r.project}] ${r.raw_text.slice(0, 80)}${r.raw_text.length > 80 ? '…' : ''}`
  )
  return `📥 *${rows.length} unprocessed item${rows.length !== 1 ? 's' : ''}:*\n${lines.join('\n')}`
}

function matchCommand(text: string): string {
  const t = text.toLowerCase().trim()
  if (t.includes('daily note') || t.includes('generate daily')) return 'daily_note'
  if (t.includes('backlog') || t.includes('staging')) return 'backlog'
  if (t.includes('unprocessed') || t.includes('inbox')) return 'inbox'
  if (t.includes('help') || t === '?') return 'help'
  return 'unknown'
}

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    // Slack URL verification
    if (body.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const event = body.event
    if (!event || event.bot_id) return new Response('OK', { status: 200 })
    if (event.type !== 'message' || !event.text) return new Response('OK', { status: 200 })

    const channel = event.channel
    const command = matchCommand(event.text)

    let result = ''

    if (command === 'daily_note') {
      await postToSlack(channel, '⏳ Generating daily note...')
      result = await callMcpTool('generate_daily_note', {})
    } else if (command === 'backlog') {
      await postToSlack(channel, '⏳ Fetching staging backlog...')
      result = await callMcpTool('get_tasks', { scope: 'today' })
    } else if (command === 'inbox') {
      await postToSlack(channel, '⏳ Checking capture inbox...')
      result = await getUnprocessedInbox()
    } else if (command === 'help') {
      result = `*Available commands:*\n• "daily note" — generate today's task note\n• "backlog" — show staging backlog and today's tasks\n• "inbox" — show unprocessed capture inbox items\n• "help" — show this message`
    } else {
      result = `❓ Command not recognized. Type "help" to see available commands.`
    }

    await postToSlack(channel, result)
    await postToLogs(`*slack-commands* ✓ ${command} — executed`)

    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('slack-commands error:', err)
    await postToLogs(`*slack-commands* ⚠️ Error: ${err instanceof Error ? err.message : String(err)}`)
    return new Response('OK', { status: 200 })
  }
})
