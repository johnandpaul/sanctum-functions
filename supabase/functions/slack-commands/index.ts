import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { postToLogs } from '../_shared/slack-logger.ts'

const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OBSIDIAN_API_URL = Deno.env.get('OBSIDIAN_API_URL')!
const OBSIDIAN_API_KEY = Deno.env.get('OBSIDIAN_API_KEY')!

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

async function getStagingBacklog(): Promise<string> {
  const response = await fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/staging.md`, {
    headers: { 'Authorization': `Bearer ${OBSIDIAN_API_KEY}` }
  })
  if (!response.ok) throw new Error(`Obsidian read failed: ${response.status}`)
  return await response.text()
}

async function generateDailyNote(): Promise<string> {
  const today = new Date().toISOString().split('T')[0]
  const dayOfWeek = new Date().getDay()
  const dayOfMonth = new Date().getDate()

  const [stagingRes, tcaRes, personalRes] = await Promise.all([
    fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/staging.md`, { headers: { 'Authorization': `Bearer ${OBSIDIAN_API_KEY}` } }),
    fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/tca-duties.md`, { headers: { 'Authorization': `Bearer ${OBSIDIAN_API_KEY}` } }),
    fetch(`${OBSIDIAN_API_URL}/vault/02-areas/tasks/personal.md`, { headers: { 'Authorization': `Bearer ${OBSIDIAN_API_KEY}` } }),
  ])

  if (!stagingRes.ok) throw new Error('Could not read staging.md')
  if (!tcaRes.ok) throw new Error('Could not read tca-duties.md')

  const stagingContent = await stagingRes.text()
  const tcaContent = await tcaRes.text()
  const personalContent = personalRes.ok ? await personalRes.text() : ''

  function extractSection(content: string, header: string): string[] {
    const lines = content.split('\n')
    const startIdx = lines.findIndex(l => l.trim() === `## ${header}`)
    if (startIdx === -1) return []
    let endIdx = lines.length
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { endIdx = i; break }
    }
    return lines.slice(startIdx + 1, endIdx).filter(l => l.trim().startsWith('- '))
  }

  const backlogItems = extractSection(stagingContent, 'Backlog').slice(0, 10)
  const stagingLines = backlogItems.map(item => `- [ ] ${item.replace(/^- \[[ x]\] /i, '')}`)

  const tcaDailyLines = extractSection(tcaContent, 'Daily')
  const tcaWeeklyLines = dayOfWeek === 1 ? extractSection(tcaContent, 'Weekly') : []
  const tcaMonthlyLines = dayOfMonth === 1 ? extractSection(tcaContent, 'Monthly') : []
  const tcaLines = [...tcaDailyLines, ...tcaWeeklyLines, ...tcaMonthlyLines]

  const personalLines = extractSection(personalContent, 'Upcoming')

  const note = `---
type: daily-tasks
status: active
tags: [tasks/daily]
created: ${today}
project: sanctum
---

# Daily Tasks — ${today}

## From Staging Backlog
${stagingLines.length ? stagingLines.join('\n') : '(none)'}

## TCA Duties
${tcaLines.length ? tcaLines.join('\n') : '(none for today)'}

## Personal
${personalLines.length ? personalLines.join('\n') : '(none)'}

## Notes
`

  const fileName = `00-inbox/${today}-daily-tasks.md`
  const writeRes = await fetch(`${OBSIDIAN_API_URL}/vault/${fileName.split('/').map(s => encodeURIComponent(s)).join('/')}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${OBSIDIAN_API_KEY}`, 'Content-Type': 'text/markdown' },
    body: note,
  })

  if (!writeRes.ok) throw new Error('Failed to write daily note')
  return `✅ Daily note created: ${fileName}\n\nTop items:\n${stagingLines.slice(0, 3).join('\n') || '(none)'}`
}

async function formatBacklogForSlack(content: string): Promise<string> {
  const lines = content.split('\n')
  const items: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- [ ]')) {
      items.push(trimmed.replace(/^- \[ \] /, '').trim())
    }
    if (items.length >= 10) break
  }
  if (!items.length) return '📋 *Staging Backlog:* Empty — nothing queued'
  return `📋 *Staging Backlog (${items.length} items):*\n${items.map(i => `• ${i}`).join('\n')}`
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
      result = await generateDailyNote()
    } else if (command === 'backlog') {
      await postToSlack(channel, '⏳ Fetching staging backlog...')
      const content = await getStagingBacklog()
      result = await formatBacklogForSlack(content)
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
