import {
  db, json, sha256, FieldValue, sendTelegram, scheduleUpcomingForUser,
  scheduleRemindersForUser, cancelReminders, eventUrl, escapeHtml
} from './_lib.js';

async function answerCallback(id, text = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text, show_alert: false })
  }).catch(console.error);
}

async function handleStart(message) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const payload = text.split(/\s+/)[1] || '';
  if (!payload.startsWith('nexus_link_')) {
    await sendTelegram(chatId, '👋 <b>NEXUS Event</b>\n\nTelegramni sayt orqali ulang: Profile → Telegramni ulash.');
    return;
  }
  const raw = payload.slice('nexus_link_'.length);
  const hash = sha256(raw);
  const ref = db().collection('telegramLinkTokens').doc(hash);
  const snap = await ref.get();
  if (!snap.exists) {
    await sendTelegram(chatId, '❌ Ulanish havolasi noto‘g‘ri yoki eskirgan. Saytdan yangi havola yarating.');
    return;
  }
  const data = snap.data();
  const expired = !data.expiresAt || data.expiresAt.toMillis() < Date.now();
  if (data.used || expired) {
    await sendTelegram(chatId, '❌ Bu ulanish havolasi eskirgan. Saytdan yangi havola yarating.');
    return;
  }
  const uid = data.uid;
  const batch = db().batch();
  batch.set(db().collection('telegramConnections').doc(uid), {
    userId: uid,
    telegramUserId: message.from?.id || chatId,
    telegramChatId: chatId,
    telegramUsername: message.from?.username || '',
    firstName: message.from?.first_name || '',
    connectedAt: FieldValue.serverTimestamp(),
    lastVerifiedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  batch.update(ref, { used: true, usedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  await scheduleUpcomingForUser(uid);
  await sendTelegram(chatId, '✅ <b>Telegram NEXUS Event bilan ulandi!</b>\n\nEndi event takliflari va 12/6/3/2/1 soatlik eslatmalar shu yerga keladi.');
}

async function handleRsvp(callback) {
  const parts = String(callback.data || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'rsvp') return false;
  const [, eventId, status] = parts;
  if (!['going','maybe','notGoing'].includes(status)) return false;
  const tgQ = await db().collection('telegramConnections').where('telegramUserId', '==', callback.from.id).limit(1).get();
  if (tgQ.empty) {
    await answerCallback(callback.id, 'Avval sayt orqali Telegramni ulang.');
    return true;
  }
  const uid = tgQ.docs[0].id;
  const eventRef = db().collection('events').doc(eventId);
  const [eventSnap, partSnap] = await Promise.all([eventRef.get(), eventRef.collection('participants').doc(uid).get()]);
  if (!eventSnap.exists || !partSnap.exists) {
    await answerCallback(callback.id, 'Taklif topilmadi.');
    return true;
  }
  const ev = eventSnap.data();
  if (ev.status === 'cancelled') {
    await answerCallback(callback.id, 'Event bekor qilingan.');
    return true;
  }
  if (status === 'going' && ev.maxParticipants > 0 && partSnap.data().status !== 'going') {
    const going = await eventRef.collection('participants').where('status', '==', 'going').get();
    if (going.size >= ev.maxParticipants) {
      await answerCallback(callback.id, 'Event to‘lib bo‘lgan.');
      return true;
    }
  }
  const batch = db().batch();
  batch.set(eventRef.collection('participants').doc(uid), { status, respondedAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(db().collection('userEvents').doc(uid).collection('items').doc(eventId), { status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  await cancelReminders(eventId, uid);
  if (status === 'going') await scheduleRemindersForUser(eventId, uid);
  const label = status === 'going' ? '✅ Boraman' : status === 'maybe' ? '🤔 Balki' : '❌ Bormayman';
  await answerCallback(callback.id, label);
  try {
    await sendTelegram(callback.message.chat.id, `${label}\n\n<b>${escapeHtml(ev.title)}</b>`, {
      reply_markup: { inline_keyboard: [[{ text: 'EVENTNI OCHISH', url: eventUrl(eventId) }]] }
    });
  } catch (e) { console.error(e); }
  return true;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { ok: false });
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected) {
    const got = event.headers['x-telegram-bot-api-secret-token'] || event.headers['X-Telegram-Bot-Api-Secret-Token'];
    if (got !== expected) return json(403, { ok: false });
  }
  try {
    const update = JSON.parse(event.body || '{}');
    if (update.message?.text?.startsWith('/start')) await handleStart(update.message);
    if (update.callback_query) await handleRsvp(update.callback_query);
    return json(200, { ok: true });
  } catch (err) {
    console.error(err);
    return json(200, { ok: true }); // Telegram should not retry malformed updates forever.
  }
}
