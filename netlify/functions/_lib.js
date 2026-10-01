import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';

function adminApp() {
  if (getApps().length) return getApps()[0];
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin environment variables are missing.');
  }
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}

export const db = () => getFirestore(adminApp());
export const adminAuth = () => getAuth(adminApp());
export { Timestamp, FieldValue };

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

export async function requireUser(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 });
  try {
    return await adminAuth().verifyIdToken(match[1]);
  } catch {
    throw Object.assign(new Error('Invalid login session.'), { statusCode: 401 });
  }
}

export function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }); }
}

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

export function pairId(a, b) {
  return [a, b].sort().join('__');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function getUser(uid) {
  const snap = await db().collection('users').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function isFriend(uidA, uidB) {
  const snap = await db().collection('friends').doc(pairId(uidA, uidB)).get();
  return snap.exists;
}

export async function isOrganizer(eventId, uid) {
  const snap = await db().collection('events').doc(eventId).get();
  if (!snap.exists) return { ok: false, event: null };
  const data = snap.data();
  return { ok: data.organizerId === uid, event: { id: snap.id, ...data } };
}

export async function canAccessEvent(eventId, uid) {
  const ref = db().collection('events').doc(eventId);
  const [eventSnap, participantSnap] = await Promise.all([
    ref.get(),
    ref.collection('participants').doc(uid).get()
  ]);
  if (!eventSnap.exists) return { ok: false, event: null };
  const ev = { id: eventSnap.id, ...eventSnap.data() };
  const ok = ev.visibility === 'public' || ev.organizerId === uid || participantSnap.exists;
  return { ok, event: ev, participant: participantSnap.exists ? participantSnap.data() : null };
}

export async function notify(userId, type, title, text, data = {}) {
  await db().collection('notifications').add({
    userId, type, title, text, data,
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });
}

export async function sendTelegram(chatId, text, extra = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing.');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || 'Telegram send failed.');
    err.telegram = data;
    throw err;
  }
  return data.result;
}

export function siteUrl() {
  return (process.env.SITE_URL || '').replace(/\/$/, '');
}

export function eventUrl(eventId) {
  return `${siteUrl()}/?event=${encodeURIComponent(eventId)}`;
}

export function formatEventTelegram(ev, prefix = '') {
  const starts = ev.startsAt?.toDate ? ev.startsAt.toDate() : new Date(ev.startsAtMs || ev.startsAt);
  const when = new Intl.DateTimeFormat('uz-UZ', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: ev.timezone || 'Asia/Tashkent'
  }).format(starts);
  const location = ev.locationName ? `\n📍 ${escapeHtml(ev.locationName)}` : '';
  return `${prefix}${prefix ? '\n\n' : ''}<b>${escapeHtml(ev.title || 'Event')}</b>\n📅 ${escapeHtml(when)}${location}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const REMINDER_MINUTES = [
  ['H12', 12 * 60],
  ['H6', 6 * 60],
  ['H3', 3 * 60],
  ['H2', 2 * 60],
  ['H1', 60]
];

export async function cancelReminders(eventId, userId = null) {
  const snap = await db().collection('eventReminders').where('eventId', '==', eventId).get();
  const targets = snap.docs.filter(d => {
    const x = d.data();
    return (!userId || x.userId === userId) && ['scheduled', 'failed_retryable', 'processing'].includes(x.status);
  });
  if (!targets.length) return 0;
  const batch = db().batch();
  targets.forEach(d => batch.update(d.ref, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() }));
  await batch.commit();
  return targets.length;
}

export async function scheduleRemindersForUser(eventId, userId) {
  const eventRef = db().collection('events').doc(eventId);
  const [eventSnap, partSnap, tgSnap] = await Promise.all([
    eventRef.get(),
    eventRef.collection('participants').doc(userId).get(),
    db().collection('telegramConnections').doc(userId).get()
  ]);
  if (!eventSnap.exists || !partSnap.exists || !tgSnap.exists) return 0;
  const ev = eventSnap.data();
  const participant = partSnap.data();
  if (ev.status === 'cancelled' || participant.status !== 'going') return 0;
  const startMs = ev.startsAt.toMillis();
  const now = Date.now();
  const chatId = tgSnap.data().telegramChatId;
  const batch = db().batch();
  let count = 0;
  for (const [type, mins] of REMINDER_MINUTES) {
    const at = startMs - mins * 60_000;
    if (at <= now) continue;
    const id = `${eventId}__${userId}__${type}`;
    const ref = db().collection('eventReminders').doc(id);
    batch.set(ref, {
      eventId, userId, telegramChatId: chatId, reminderType: type,
      scheduledAt: Timestamp.fromMillis(at), status: 'scheduled', attemptCount: 0,
      eventStartAt: ev.startsAt, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    count++;
  }
  if (count) await batch.commit();
  return count;
}

export async function rescheduleEventReminders(eventId) {
  await cancelReminders(eventId);
  const parts = await db().collection('events').doc(eventId).collection('participants').where('status', '==', 'going').get();
  let total = 0;
  for (const doc of parts.docs) total += await scheduleRemindersForUser(eventId, doc.id);
  return total;
}

export async function scheduleUpcomingForUser(uid) {
  const refs = await db().collection('userEvents').doc(uid).collection('items').get();
  let count = 0;
  for (const item of refs.docs) {
    const d = item.data();
    if (d.status === 'going' || d.role === 'organizer') {
      count += await scheduleRemindersForUser(item.id, uid);
    }
  }
  return count;
}
