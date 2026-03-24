import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const SLACK_SIGNING_SECRET = Deno.env.get('SLACK_SIGNING_SECRET')!
const CAPTURE_URL = 'https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/slack-capture'
const COMMANDS_URL = 'https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/slack-commands'

const CHANNEL_COMMANDS = 'C0ANAJF5S3F'

async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get('X-Slack-Request-Timestamp')
  const signature = req.headers.get('X-Slack-Signature')
  if (!timestamp || !signature) return false
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) return false
  const sigBaseString = `v0:${timestamp}:${rawBody}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBaseString))
  const computed = 'v0=' + Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return computed === signature
}

Deno.serve(async (req) => {
  const rawBody = await req.text()

  // Verify Slack signature once here — downstream functions trust this router
  const valid = await verifySlackSignature(req, rawBody)
  if (!valid) return new Response('Unauthorized', { status: 403 })

  // Parse body to determine routing
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Handle Slack URL verification challenge
  if (body.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Ignore Slack retries
  if (req.headers.get('X-Slack-Retry-Num')) {
    return new Response('OK', { status: 200 })
  }

  // Route based on channel
  const channelId = (body.event as Record<string, unknown>)?.channel as string | undefined
  const targetUrl = channelId === CHANNEL_COMMANDS ? COMMANDS_URL : CAPTURE_URL

  // Forward the request to the appropriate function
  fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody
  }).catch(err => console.error('Router forward error:', err))

  // Respond to Slack immediately
  return new Response('OK', { status: 200 })
})
