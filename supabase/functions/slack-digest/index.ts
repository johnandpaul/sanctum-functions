import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { postToLogs } from '../_shared/slack-logger.ts'

const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CHANNEL_DIGEST = 'C0ANAJF5S3F'
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

async function getUnprocessedCount(): Promise<number> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/capture_inbox?processed=eq.false&select=id`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  )
  if (!response.ok) return 0
  const rows = await response.json()
  return rows.length
}

function formatDate(): string {
  const now = new Date()
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago'
  })
}

function extractBacklogItems(tasksText: string): string[] {
  const lines = tasksText.split('\n')
  const items: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]')) {
      const text = trimmed.replace(/^- \[[ x]\] /, '').trim()
      if (text) items.push(text)
    }
    if (items.length >= 5) break
  }
  return items
}

Deno.serve(async (req) => {
  try {
    const tasksText = await callMcpTool('get_tasks', { scope: 'today' })
    const unprocessedCount = await getUnprocessedCount()
    const backlogItems = extractBacklogItems(tasksText)

    const dateStr = formatDate()
    const topPriority = backlogItems[0] ?? 'Nothing in backlog — add tasks to staging'

    const lines: string[] = [
      `🌅 *Good morning, John — ${dateStr}*`,
      '',
    ]

    if (backlogItems.length > 0) {
      lines.push(`📋 *Staging Backlog (top ${backlogItems.length}):*`)
      backlogItems.forEach(item => lines.push(`• ${item}`))
    } else {
      lines.push(`📋 *Staging Backlog:* Empty — nothing queued`)
    }

    lines.push('')
    lines.push(`📥 *Capture Inbox:* ${unprocessedCount === 0 ? '✅ All clear' : `${unprocessedCount} unprocessed item${unprocessedCount !== 1 ? 's' : ''}`}`)
    lines.push('')
    lines.push(`⚡ *Top priority:* ${topPriority}`)

    const message = lines.join('\n')
    await postToSlack(CHANNEL_DIGEST, message)
    await postToLogs(`*slack-digest* ✓ Morning digest posted — ${backlogItems.length} backlog items, ${unprocessedCount} unprocessed`)

    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('slack-digest error:', err)
    await postToLogs(`*slack-digest* ⚠️ Error: ${err instanceof Error ? err.message : String(err)}`)
    return new Response('OK', { status: 200 })
  }
})
