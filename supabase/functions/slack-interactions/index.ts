import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;

async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get('X-Slack-Request-Timestamp');
  const signature = req.headers.get('X-Slack-Signature');
  if (!timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;
  const sigBaseString = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBaseString));
  const computed = 'v0=' + Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return computed === signature;
}

async function updateSlackMessage(channel: string, ts: string, text: string) {
  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({
      channel,
      ts,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text }
        }
      ]
    })
  });
}

async function postToSlack(channel: string, text: string) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, text })
  });
}

async function doApplyWork(channelId: string, messageTs: string) {
  try {
    const applyUrl = 'https://ozezxrmaoukpqjshimys.supabase.co/functions/v1/apply-gap-connections';
    const res = await fetch(applyUrl);
    const result = await res.json();

    if (!res.ok || result.error) {
      await updateSlackMessage(channelId, messageTs, `⚠️ Apply failed: ${result.error || 'unknown error'}`);
      return;
    }

    await updateSlackMessage(
      channelId,
      messageTs,
      `✅ *Gap connections applied*\n*Applied:* ${result.connections_applied}  |  *Skipped:* ${result.skipped}  |  *Failed:* ${result.failed}\n_Analysis archived to 04-archive/_`
    );
  } catch (err) {
    await postToSlack(channelId, `⚠️ slack-interactions error during apply: ${String(err)}`);
  }
}

Deno.serve(async (req) => {
  const rawBody = await req.text();

  const valid = await verifySlackSignature(req, rawBody);
  if (!valid) {
    return new Response('Unauthorized', { status: 403 });
  }

  // Parse URL-encoded body
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get('payload');
  if (!payloadStr) {
    return new Response('Bad Request', { status: 400 });
  }

  const payload = JSON.parse(payloadStr);

  // Handle Slack URL verification challenge
  if (payload.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Handle button actions
  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    const channelId = payload.channel?.id;
    const messageTs = payload.message?.ts;

    if (action?.action_id === 'approve_gap_connections' && channelId && messageTs) {
      // Update message immediately to remove button and show processing state
      await updateSlackMessage(channelId, messageTs, '⏳ *Applying gap connections...* This will take a moment.');

      // Schedule background work - respond to Slack before heavy lifting starts
      EdgeRuntime.waitUntil(doApplyWork(channelId, messageTs));
    }
  }

  return new Response('', { status: 200 });
});
