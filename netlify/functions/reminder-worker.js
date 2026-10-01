import { db, json, FieldValue, sendTelegram, eventUrl, formatEventTelegram } from './_lib.js';

const LABELS = {
  H12: '⏰ <b>12 soat qoldi</b>',
  H6: '⏰ <b>6 soat qoldi</b>',
  H3: '⏳ <b>3 soat qoldi</b>',
  H2: '⏳ <b>2 soat qoldi</b>',
  H1: '🔥 <b>1 soat qoldi</b>'
};

async function processDue() {
  const now = new Date();
  const snap = await db().collection('eventReminders')
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '<=', now)
    .orderBy('scheduledAt', 'asc')
    .limit(100)
    .get();

  let sent = 0, skipped = 0, failed = 0;
  for (const doc of snap.docs) {
    const claim = await db().runTransaction(async tx => {
      const fresh = await tx.get(doc.ref);
      if (!fresh.exists || fresh.data().status !== 'scheduled') return null;
      tx.update(doc.ref, { status: 'processing', processingAt: FieldValue.serverTimestamp(), attemptCount: FieldValue.increment(1) });
      return fresh.data();
    });
    if (!claim) { skipped++; continue; }
    try {
      const eventRef = db().collection('events').doc(claim.eventId);
      const [eventSnap, partSnap, tgSnap] = await Promise.all([
        eventRef.get(), eventRef.collection('participants').doc(claim.userId).get(), db().collection('telegramConnections').doc(claim.userId).get()
      ]);
      if (!eventSnap.exists || !partSnap.exists || !tgSnap.exists || eventSnap.data().status === 'cancelled' || partSnap.data().status !== 'going') {
        await doc.ref.update({ status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
        skipped++;
        continue;
      }
      const ev = { id: eventSnap.id, ...eventSnap.data() };
      const prefix = LABELS[claim.reminderType] || '⏰ <b>Event eslatmasi</b>';
      await sendTelegram(tgSnap.data().telegramChatId, formatEventTelegram(ev, prefix), {
        reply_markup: { inline_keyboard: [[{ text: 'EVENTNI OCHISH', url: eventUrl(claim.eventId) }]] }
      });
      await doc.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastError: null });
      sent++;
    } catch (err) {
      console.error('Reminder failed', doc.id, err);
      const attempts = Number(claim.attemptCount || 0) + 1;
      await doc.ref.update({ status: attempts >= 4 ? 'failed_permanent' : 'scheduled', lastError: String(err.message || err).slice(0, 500), updatedAt: FieldValue.serverTimestamp() });
      failed++;
    }
  }
  return { due: snap.size, sent, skipped, failed };
}

export async function handler(event) {
  // Netlify scheduled invocation or optional external cron fallback.
  if (event.httpMethod === 'GET' && process.env.CRON_SECRET) {
    const supplied = event.headers['x-cron-secret'] || new URL(event.rawUrl || 'http://local').searchParams.get('secret');
    if (supplied !== process.env.CRON_SECRET) return json(403, { ok: false, error: 'Forbidden' });
  }
  try {
    const stats = await processDue();
    return json(200, { ok: true, ...stats });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: 'Reminder worker failed.' });
  }
}
