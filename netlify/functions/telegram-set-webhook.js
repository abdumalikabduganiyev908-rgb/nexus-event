import { json } from './_lib.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  const setupSecret = process.env.CRON_SECRET;
  const supplied = event.headers['x-setup-secret'];
  if (!setupSecret || supplied !== setupSecret) return json(403, { ok: false, error: 'Forbidden' });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const site = (process.env.SITE_URL || '').replace(/\/$/, '');
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !site || !secret) return json(500, { ok: false, error: 'Missing Telegram/SITE environment variables.' });
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${site}/.netlify/functions/telegram-webhook`, secret_token: secret, allowed_updates: ['message','callback_query'] })
  });
  const data = await response.json();
  return json(data.ok ? 200 : 500, data);
}
