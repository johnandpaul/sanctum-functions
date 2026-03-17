const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') ?? ''
const LOGS_CHANNEL_ID = 'C0AMUEUQUBA'

export async function postToLogs(message: string): Promise<void> {
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: LOGS_CHANNEL_ID,
        text: message,
      }),
    })
  } catch (err) {
    console.error('slack-logger: failed to post to #logs', err)
  }
}
