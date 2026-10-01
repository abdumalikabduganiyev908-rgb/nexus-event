import {
  db, json, requireUser, parseBody, cleanText, pairId, randomToken, sha256,
  Timestamp, FieldValue, getUser, isFriend, isOrganizer, canAccessEvent,
  notify, sendTelegram, eventUrl, formatEventTelegram, escapeHtml,
  cancelReminders, scheduleRemindersForUser, rescheduleEventReminders
} from './_lib.js';

function errResponse(err) {
  console.error(err);
  return json(err.statusCode || 500, { ok: false, error: err.statusCode ? err.message : 'Server error.' });
}

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === '') {
      throw Object.assign(new Error(`${f} is required.`), { statusCode: 400 });
    }
  }
}

async function ensureProfile(uid) {
  const u = await getUser(uid);
  if (!u) throw Object.assign(new Error('Create your profile first.'), { statusCode: 400 });
  return u;
}

async function makePublicId(nickname) {
  const base = (nickname || 'user').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18) || 'user';
  for (let i = 0; i < 20; i++) {
    const id = `${base}#${Math.floor(1000 + Math.random() * 9000)}`;
    const q = await db().collection('users').where('publicId', '==', id).limit(1).get();
    if (q.empty) return id;
  }
  return `${base}#${Date.now().toString().slice(-6)}`;
}

async function initProfile(uid, body) {
  requireFields(body, ['firstName', 'lastName', 'nickname']);
  const ref = db().collection('users').doc(uid);
  const old = await ref.get();
  if (old.exists) return { profile: { id: uid, ...old.data() } };
  const profile = {
    firstName: cleanText(body.firstName, 40),
    lastName: cleanText(body.lastName, 50),
    nickname: cleanText(body.nickname, 30),
    publicId: await makePublicId(cleanText(body.nickname, 30)),
    avatarUrl: '', themeId: 'nexus-dark', language: 'uz',
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  };
  await ref.set(profile);
  return { profile: { id: uid, ...profile } };
}

async function updateProfile(uid, body) {
  await ensureProfile(uid);
  const patch = { updatedAt: FieldValue.serverTimestamp() };
  for (const [key, max] of [['firstName',40],['lastName',50],['nickname',30],['avatarUrl',500],['themeId',40],['language',10]]) {
    if (body[key] !== undefined) patch[key] = cleanText(body[key], max);
  }
  await db().collection('users').doc(uid).update(patch);
  return { ok: true };
}

async function createEvent(uid, body) {
  const user = await ensureProfile(uid);
  requireFields(body, ['title', 'startsAtMs']);
  const startsAtMs = Number(body.startsAtMs);
  if (!Number.isFinite(startsAtMs) || startsAtMs <= Date.now() - 60_000) {
    throw Object.assign(new Error('Event start time is invalid.'), { statusCode: 400 });
  }
  const endMs = body.endsAtMs ? Number(body.endsAtMs) : null;
  if (endMs && endMs <= startsAtMs) throw Object.assign(new Error('End time must be after start time.'), { statusCode: 400 });
  const ref = db().collection('events').doc();
  const joinCode = String(Math.floor(100000 + Math.random() * 900000));
  const ev = {
    organizerId: uid,
    organizerName: `${user.firstName} ${user.lastName}`.trim(),
    title: cleanText(body.title, 100),
    description: cleanText(body.description, 2000),
    category: cleanText(body.category || 'other', 30),
    coverUrl: cleanText(body.coverUrl || '', 500),
    startsAt: Timestamp.fromMillis(startsAtMs),
    endsAt: endMs ? Timestamp.fromMillis(endMs) : null,
    timezone: cleanText(body.timezone || 'Asia/Tashkent', 80),
    locationName: cleanText(body.locationName || '', 120),
    address: cleanText(body.address || '', 250),
    mapUrl: cleanText(body.mapUrl || '', 500),
    visibility: ['private','friends','public'].includes(body.visibility) ? body.visibility : 'private',
    joinCode,
    maxParticipants: Math.max(0, Math.min(500, Number(body.maxParticipants) || 0)),
    cost: Math.max(0, Math.floor(Number(body.cost) || 0)),
    currency: 'UZS', status: 'upcoming',
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  };
  const batch = db().batch();
  batch.set(ref, ev);
  batch.set(ref.collection('participants').doc(uid), {
    userId: uid, displayName: `${user.firstName} ${user.lastName}`.trim(), nickname: user.nickname,
    status: 'going', role: 'organizer', skill: 3, invitedAt: FieldValue.serverTimestamp(), respondedAt: FieldValue.serverTimestamp()
  });
  batch.set(db().collection('userEvents').doc(uid).collection('items').doc(ref.id), {
    eventId: ref.id, role: 'organizer', status: 'going', startsAt: ev.startsAt, title: ev.title, updatedAt: FieldValue.serverTimestamp()
  });
  await batch.commit();
  await scheduleRemindersForUser(ref.id, uid);
  return { eventId: ref.id, joinCode };
}

async function updateEvent(uid, body) {
  requireFields(body, ['eventId']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can edit this event.'), { statusCode: 403 });
  const patch = { updatedAt: FieldValue.serverTimestamp() };
  const changedTime = body.startsAtMs !== undefined;
  for (const [key, max] of [['title',100],['description',2000],['category',30],['coverUrl',500],['locationName',120],['address',250],['mapUrl',500],['visibility',20]]) {
    if (body[key] !== undefined) patch[key] = cleanText(body[key], max);
  }
  if (changedTime) {
    const ms = Number(body.startsAtMs);
    if (!Number.isFinite(ms) || ms <= Date.now() - 60_000) throw Object.assign(new Error('Invalid start time.'), { statusCode: 400 });
    patch.startsAt = Timestamp.fromMillis(ms);
  }
  if (body.endsAtMs !== undefined) patch.endsAt = body.endsAtMs ? Timestamp.fromMillis(Number(body.endsAtMs)) : null;
  if (body.timezone !== undefined) patch.timezone = cleanText(body.timezone, 80);
  if (body.cost !== undefined) patch.cost = Math.max(0, Math.floor(Number(body.cost) || 0));
  if (body.maxParticipants !== undefined) patch.maxParticipants = Math.max(0, Math.min(500, Number(body.maxParticipants) || 0));
  await db().collection('events').doc(body.eventId).update(patch);
  if (changedTime) await rescheduleEventReminders(body.eventId);
  const participants = await db().collection('events').doc(body.eventId).collection('participants').get();
  for (const p of participants.docs) {
    if (p.id === uid) continue;
    await notify(p.id, 'event_updated', 'Event yangilandi', check.event.title, { eventId: body.eventId });
    const tg = await db().collection('telegramConnections').doc(p.id).get();
    if (tg.exists) {
      const fresh = await db().collection('events').doc(body.eventId).get();
      await sendTelegram(tg.data().telegramChatId, formatEventTelegram({ id: fresh.id, ...fresh.data() }, '⚠️ <b>Event yangilandi</b>'), {
        reply_markup: { inline_keyboard: [[{ text: 'EVENTNI OCHISH', url: eventUrl(body.eventId) }]] }
      }).catch(console.error);
    }
  }
  return { ok: true };
}

async function cancelEvent(uid, body) {
  requireFields(body, ['eventId']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can cancel this event.'), { statusCode: 403 });
  await db().collection('events').doc(body.eventId).update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await cancelReminders(body.eventId);
  const participants = await db().collection('events').doc(body.eventId).collection('participants').get();
  for (const p of participants.docs) {
    if (p.id === uid) continue;
    await notify(p.id, 'event_cancelled', 'Event bekor qilindi', check.event.title, { eventId: body.eventId });
    const tg = await db().collection('telegramConnections').doc(p.id).get();
    if (tg.exists) {
      await sendTelegram(tg.data().telegramChatId, `❌ <b>Event bekor qilindi</b>\n\n${escapeHtml(check.event.title)}`).catch(console.error);
    }
  }
  return { ok: true };
}

async function inviteToEvent(uid, body) {
  requireFields(body, ['eventId', 'toUid']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can invite users.'), { statusCode: 403 });
  if (body.toUid === uid) throw Object.assign(new Error('You are already organizer.'), { statusCode: 400 });
  if (!(await isFriend(uid, body.toUid))) throw Object.assign(new Error('You can invite only friends.'), { statusCode: 403 });
  const target = await getUser(body.toUid);
  if (!target) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  const eventRef = db().collection('events').doc(body.eventId);
  const existing = await eventRef.collection('participants').doc(body.toUid).get();
  if (!existing.exists) {
    const batch = db().batch();
    batch.set(eventRef.collection('participants').doc(body.toUid), {
      userId: body.toUid, displayName: `${target.firstName} ${target.lastName}`.trim(), nickname: target.nickname,
      status: 'invited', role: 'participant', skill: 3, invitedAt: FieldValue.serverTimestamp(), respondedAt: null
    });
    batch.set(db().collection('userEvents').doc(body.toUid).collection('items').doc(body.eventId), {
      eventId: body.eventId, role: 'participant', status: 'invited', startsAt: check.event.startsAt, title: check.event.title,
      updatedAt: FieldValue.serverTimestamp()
    });
    await batch.commit();
  }
  await notify(body.toUid, 'event_invite', 'Yangi event taklifi', check.event.title, { eventId: body.eventId });
  const tg = await db().collection('telegramConnections').doc(body.toUid).get();
  if (tg.exists) {
    const txt = formatEventTelegram(check.event, '🎉 <b>Yangi event taklifi</b>');
    await sendTelegram(tg.data().telegramChatId, txt, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Boraman', callback_data: `rsvp:${body.eventId}:going` },
            { text: '🤔 Balki', callback_data: `rsvp:${body.eventId}:maybe` }
          ],
          [{ text: '❌ Bormayman', callback_data: `rsvp:${body.eventId}:notGoing` }],
          [{ text: 'EVENTNI OCHISH', url: eventUrl(body.eventId) }]
        ]
      }
    });
  }
  return { ok: true, telegramSent: tg.exists };
}

async function rsvp(uid, body) {
  requireFields(body, ['eventId', 'status']);
  if (!['going','maybe','notGoing'].includes(body.status)) throw Object.assign(new Error('Invalid RSVP.'), { statusCode: 400 });
  const access = await canAccessEvent(body.eventId, uid);
  if (!access.ok) throw Object.assign(new Error('You do not have access to this event.'), { statusCode: 403 });
  const eventRef = db().collection('events').doc(body.eventId);
  const participantRef = eventRef.collection('participants').doc(uid);
  const participant = await participantRef.get();
  if (!participant.exists && access.event.visibility !== 'public') throw Object.assign(new Error('Invitation required.'), { statusCode: 403 });
  if (body.status === 'going' && access.event.maxParticipants > 0) {
    const going = await eventRef.collection('participants').where('status', '==', 'going').get();
    if (!participant.exists || participant.data().status !== 'going') {
      if (going.size >= access.event.maxParticipants) throw Object.assign(new Error('Event is full.'), { statusCode: 409 });
    }
  }
  const user = await ensureProfile(uid);
  const batch = db().batch();
  batch.set(participantRef, {
    userId: uid, displayName: `${user.firstName} ${user.lastName}`.trim(), nickname: user.nickname,
    role: access.event.organizerId === uid ? 'organizer' : 'participant', status: body.status,
    respondedAt: FieldValue.serverTimestamp(), skill: participant.exists ? (participant.data().skill || 3) : 3
  }, { merge: true });
  batch.set(db().collection('userEvents').doc(uid).collection('items').doc(body.eventId), {
    eventId: body.eventId, role: access.event.organizerId === uid ? 'organizer' : 'participant', status: body.status,
    startsAt: access.event.startsAt, title: access.event.title, updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();
  await cancelReminders(body.eventId, uid);
  if (body.status === 'going') await scheduleRemindersForUser(body.eventId, uid);
  return { ok: true };
}

async function telegramCreateLink(uid) {
  await ensureProfile(uid);
  const raw = randomToken(20);
  const hash = sha256(raw);
  await db().collection('telegramLinkTokens').doc(hash).set({ uid, expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60_000), used: false, createdAt: FieldValue.serverTimestamp() });
  const username = process.env.TELEGRAM_BOT_USERNAME || 'NexusEvent_Bot';
  return { url: `https://t.me/${username}?start=nexus_link_${raw}` };
}


async function telegramStatus(uid) {
  const snap = await db().collection('telegramConnections').doc(uid).get();
  if (!snap.exists) return { connected: false };
  const d = snap.data();
  return { connected: true, username: d.telegramUsername || '', connectedAt: d.connectedAt || null };
}

async function friendRequest(uid, body) {
  requireFields(body, ['toUid']);
  if (body.toUid === uid) throw Object.assign(new Error('Cannot add yourself.'), { statusCode: 400 });
  await ensureProfile(uid); await ensureProfile(body.toUid);
  const pid = pairId(uid, body.toUid);
  if ((await db().collection('friends').doc(pid).get()).exists) throw Object.assign(new Error('Already friends.'), { statusCode: 409 });
  const id = `${uid}__${body.toUid}`;
  const reverse = await db().collection('friendRequests').doc(`${body.toUid}__${uid}`).get();
  if (reverse.exists && reverse.data().status === 'pending') {
    return friendRespond(uid, { requestId: reverse.id, decision: 'accept' });
  }
  await db().collection('friendRequests').doc(id).set({ fromUid: uid, toUid: body.toUid, status: 'pending', createdAt: FieldValue.serverTimestamp() }, { merge: true });
  const from = await getUser(uid);
  await notify(body.toUid, 'friend_request', 'Do‘stlik so‘rovi', from?.nickname || from?.firstName || 'User', { requestId: id });
  return { ok: true };
}

async function friendRespond(uid, body) {
  requireFields(body, ['requestId', 'decision']);
  const ref = db().collection('friendRequests').doc(body.requestId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().toUid !== uid) throw Object.assign(new Error('Friend request not found.'), { statusCode: 404 });
  if (!['accept','decline'].includes(body.decision)) throw Object.assign(new Error('Invalid decision.'), { statusCode: 400 });
  const req = snap.data();
  if (body.decision === 'decline') {
    await ref.update({ status: 'declined', respondedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  const p = pairId(req.fromUid, req.toUid);
  const batch = db().batch();
  batch.set(db().collection('friends').doc(p), { userA: [req.fromUid, req.toUid].sort()[0], userB: [req.fromUid, req.toUid].sort()[1], createdAt: FieldValue.serverTimestamp() });
  batch.update(ref, { status: 'accepted', respondedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  await notify(req.fromUid, 'friend_accepted', 'Do‘stlik so‘rovi qabul qilindi', '', { userId: uid });
  return { ok: true };
}

async function friendRemove(uid, body) {
  requireFields(body, ['otherUid']);
  await db().collection('friends').doc(pairId(uid, body.otherUid)).delete();
  return { ok: true };
}

async function createPoll(uid, body) {
  requireFields(body, ['eventId', 'question', 'options']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can create polls.'), { statusCode: 403 });
  const options = Array.isArray(body.options) ? body.options.map((x, i) => ({ id: `o${i+1}`, text: cleanText(x, 100) })).filter(o => o.text) : [];
  if (options.length < 2 || options.length > 10) throw Object.assign(new Error('Poll needs 2-10 options.'), { statusCode: 400 });
  const ref = db().collection('events').doc(body.eventId).collection('polls').doc();
  await ref.set({ question: cleanText(body.question, 200), options, multiple: !!body.multiple, createdBy: uid, createdAt: FieldValue.serverTimestamp(), closed: false });
  return { pollId: ref.id };
}

async function votePoll(uid, body) {
  requireFields(body, ['eventId', 'pollId', 'optionIds']);
  const access = await canAccessEvent(body.eventId, uid);
  if (!access.ok) throw Object.assign(new Error('No event access.'), { statusCode: 403 });
  const pollRef = db().collection('events').doc(body.eventId).collection('polls').doc(body.pollId);
  const poll = await pollRef.get();
  if (!poll.exists || poll.data().closed) throw Object.assign(new Error('Poll unavailable.'), { statusCode: 400 });
  const validIds = new Set(poll.data().options.map(o => o.id));
  let ids = Array.isArray(body.optionIds) ? body.optionIds.filter(x => validIds.has(x)) : [];
  if (!poll.data().multiple) ids = ids.slice(0, 1);
  if (!ids.length) throw Object.assign(new Error('Choose an option.'), { statusCode: 400 });
  await pollRef.collection('votes').doc(uid).set({ userId: uid, optionIds: ids, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
}

async function addExpense(uid, body) {
  requireFields(body, ['eventId', 'title', 'amount', 'paidByUid']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can edit expenses.'), { statusCode: 403 });
  const amount = Math.max(0, Math.floor(Number(body.amount) || 0));
  if (!amount) throw Object.assign(new Error('Amount must be greater than 0.'), { statusCode: 400 });
  const going = await db().collection('events').doc(body.eventId).collection('participants').where('status', '==', 'going').get();
  const defaultUids = going.docs.map(d => d.id);
  const splitAmong = Array.isArray(body.splitAmong) && body.splitAmong.length ? body.splitAmong.filter(x => defaultUids.includes(x)) : defaultUids;
  if (!splitAmong.length) throw Object.assign(new Error('No participants to split expense.'), { statusCode: 400 });
  const ref = db().collection('events').doc(body.eventId).collection('expenses').doc();
  await ref.set({ title: cleanText(body.title, 100), amount, paidByUid: body.paidByUid, splitAmong, createdAt: FieldValue.serverTimestamp() });
  return { expenseId: ref.id };
}

async function setPayment(uid, body) {
  requireFields(body, ['eventId', 'participantUid', 'amountPaid']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can update payments.'), { statusCode: 403 });
  await db().collection('events').doc(body.eventId).collection('participants').doc(body.participantUid).set({ amountPaid: Math.max(0, Math.floor(Number(body.amountPaid) || 0)), paymentUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
}

async function generateTeams(uid, body) {
  requireFields(body, ['eventId']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can generate teams.'), { statusCode: 403 });
  const snap = await db().collection('events').doc(body.eventId).collection('participants').where('status', '==', 'going').get();
  let players = snap.docs.map(d => ({ uid: d.id, ...d.data(), skill: Number(d.data().skill || 3) }));
  if (players.length < 2) throw Object.assign(new Error('At least 2 Going participants required.'), { statusCode: 400 });
  const teamCount = Math.max(2, Math.min(8, Number(body.teamCount) || 2));
  const teams = Array.from({ length: teamCount }, (_, i) => ({ name: `Team ${String.fromCharCode(65+i)}`, members: [], skill: 0 }));
  if (body.mode === 'balanced') {
    players.sort((a,b) => b.skill - a.skill);
    for (const p of players) {
      teams.sort((a,b) => a.skill - b.skill || a.members.length - b.members.length);
      teams[0].members.push(p.uid); teams[0].skill += p.skill;
    }
  } else {
    players = players.sort(() => Math.random() - 0.5);
    players.forEach((p, i) => teams[i % teamCount].members.push(p.uid));
  }
  const col = db().collection('events').doc(body.eventId).collection('teams');
  const old = await col.get();
  const batch = db().batch();
  old.docs.forEach(d => batch.delete(d.ref));
  teams.forEach((t, i) => batch.set(col.doc(`team${i+1}`), { name: t.name, memberUids: t.members, totalSkill: t.skill, createdAt: FieldValue.serverTimestamp() }));
  await batch.commit();
  return { teams };
}

async function saveResult(uid, body) {
  requireFields(body, ['eventId']);
  const check = await isOrganizer(body.eventId, uid);
  if (!check.ok) throw Object.assign(new Error('Only organizer can save result.'), { statusCode: 403 });
  await db().collection('events').doc(body.eventId).collection('meta').doc('result').set({
    teamA: cleanText(body.teamA || 'Team A', 50), scoreA: Number(body.scoreA) || 0,
    teamB: cleanText(body.teamB || 'Team B', 50), scoreB: Number(body.scoreB) || 0,
    notes: cleanText(body.notes || '', 1000), updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
}

async function mvpVote(uid, body) {
  requireFields(body, ['eventId', 'candidateUid']);
  const access = await canAccessEvent(body.eventId, uid);
  if (!access.ok) throw Object.assign(new Error('No event access.'), { statusCode: 403 });
  const candidate = await db().collection('events').doc(body.eventId).collection('participants').doc(body.candidateUid).get();
  if (!candidate.exists) throw Object.assign(new Error('Candidate is not participant.'), { statusCode: 400 });
  await db().collection('events').doc(body.eventId).collection('mvpVotes').doc(uid).set({ voterUid: uid, candidateUid: body.candidateUid, createdAt: FieldValue.serverTimestamp() });
  return { ok: true };
}

async function addGalleryLink(uid, body) {
  requireFields(body, ['eventId', 'url']);
  const access = await canAccessEvent(body.eventId, uid);
  if (!access.ok) throw Object.assign(new Error('No event access.'), { statusCode: 403 });
  if (!/^https?:\/\//i.test(body.url)) throw Object.assign(new Error('Image URL must start with http/https.'), { statusCode: 400 });
  const ref = db().collection('events').doc(body.eventId).collection('gallery').doc();
  await ref.set({ url: cleanText(body.url, 800), caption: cleanText(body.caption || '', 200), userId: uid, createdAt: FieldValue.serverTimestamp() });
  return { itemId: ref.id };
}

async function searchUsers(uid, body) {
  const term = cleanText(body.term || '', 40);
  if (term.length < 2) return { users: [] };
  // Exact publicId first; nickname prefix search second.
  const exact = await db().collection('users').where('publicId', '==', term).limit(5).get();
  const found = new Map();
  exact.docs.forEach(d => found.set(d.id, { id: d.id, ...d.data() }));
  const lower = term.toLowerCase();
  const all = await db().collection('users').limit(100).get();
  all.docs.forEach(d => {
    const u = d.data();
    if (d.id !== uid && (String(u.nickname || '').toLowerCase().includes(lower) || String(u.firstName || '').toLowerCase().includes(lower))) {
      found.set(d.id, { id: d.id, ...u });
    }
  });
  return { users: [...found.values()].filter(u => u.id !== uid).slice(0, 20).map(u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, nickname: u.nickname, publicId: u.publicId, avatarUrl: u.avatarUrl || '' })) };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only.' });
  try {
    const user = await requireUser(event);
    const body = parseBody(event);
    const action = body.action;
    let data;
    switch (action) {
      case 'profile:init': data = await initProfile(user.uid, body); break;
      case 'profile:update': data = await updateProfile(user.uid, body); break;
      case 'event:create': data = await createEvent(user.uid, body); break;
      case 'event:update': data = await updateEvent(user.uid, body); break;
      case 'event:cancel': data = await cancelEvent(user.uid, body); break;
      case 'event:invite': data = await inviteToEvent(user.uid, body); break;
      case 'event:rsvp': data = await rsvp(user.uid, body); break;
      case 'telegram:createLink': data = await telegramCreateLink(user.uid); break;
      case 'telegram:status': data = await telegramStatus(user.uid); break;
      case 'friend:request': data = await friendRequest(user.uid, body); break;
      case 'friend:respond': data = await friendRespond(user.uid, body); break;
      case 'friend:remove': data = await friendRemove(user.uid, body); break;
      case 'poll:create': data = await createPoll(user.uid, body); break;
      case 'poll:vote': data = await votePoll(user.uid, body); break;
      case 'expense:add': data = await addExpense(user.uid, body); break;
      case 'payment:set': data = await setPayment(user.uid, body); break;
      case 'teams:generate': data = await generateTeams(user.uid, body); break;
      case 'result:save': data = await saveResult(user.uid, body); break;
      case 'mvp:vote': data = await mvpVote(user.uid, body); break;
      case 'gallery:addLink': data = await addGalleryLink(user.uid, body); break;
      case 'users:search': data = await searchUsers(user.uid, body); break;
      default: throw Object.assign(new Error('Unknown action.'), { statusCode: 400 });
    }
    return json(200, { ok: true, ...data });
  } catch (err) {
    return errResponse(err);
  }
}
