import {
  auth, db, signInAnonymously, onAuthStateChanged,
  collection, doc, getDoc, getDocs, addDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp
} from './firebase.js';
import { api } from './api.js';
import { THEMES, applyTheme, applyCachedTheme } from './themes.js';

applyCachedTheme();

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { user: null, profile: null, currentView: 'home', events: [], friends: [], unsubs: [], currentEventId: null };
const cats = {football:'⚽',gaming:'🎮',birthday:'🎂',cinema:'🎬',trip:'🚗',food:'🍔',study:'📚',tournament:'🏆',meeting:'👥',party:'🎉',other:'➕'};

function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function toast(text, type=''){const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=text;$('#toast-root').append(el);setTimeout(()=>el.remove(),3200)}
function initials(p=state.profile){return ((p?.firstName?.[0]||'N')+(p?.lastName?.[0]||'')).toUpperCase()}
function fmtDate(v){const d=v?.toDate?v.toDate():new Date(v);return new Intl.DateTimeFormat('uz-UZ',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d)}
function dateInputToday(){const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().slice(0,10)}
function countdown(ts){const t=ts?.toDate?ts.toDate().getTime():new Date(ts).getTime(), diff=t-Date.now();if(diff<=0)return 'Boshlangan';const h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000);const d=Math.floor(h/24);return d?`${d} kun ${h%24} soat`:`${h} soat ${m} daqiqa`}
function clearUnsubs(){state.unsubs.forEach(fn=>{try{fn()}catch{}});state.unsubs=[]}
function setTitle(title, sub=''){ $('#view-title').textContent=title; $('#view-subtitle').textContent=sub; }

async function loadProfile(){
  const snap=await getDoc(doc(db,'users',state.user.uid));
  state.profile=snap.exists()?{id:snap.id,...snap.data()}:null;
  if(state.profile){ applyTheme(state.profile.themeId||localStorage.getItem('nexusEventTheme')||'nexus-dark'); renderUserMini(); }
}
function renderUserMini(){
  const p=state.profile;if(!p)return;
  $('#user-mini').innerHTML=`<div class="avatar">${p.avatarUrl?`<img src="${esc(p.avatarUrl)}">`:initials(p)}</div><div><b>${esc(p.nickname)}</b><small>${esc(p.publicId||'')}</small></div>`;
}

async function init(){
  $('#event-form [name=date]').value=dateInputToday();
  $('#event-form [name=time]').value='16:00';
  if(!auth.currentUser) await signInAnonymously(auth);
}

onAuthStateChanged(auth, async user=>{
  if(!user)return;
  state.user=user;
  await loadProfile();
  $('#app-loader').classList.add('hidden');
  if(!state.profile){$('#onboarding').classList.remove('hidden');return}
  $('#shell').classList.remove('hidden');
  await loadBaseData();
  const eventId=new URL(location.href).searchParams.get('event');
  if(eventId) openEvent(eventId); else navigate('home');
});

$('#onboarding-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=new FormData(e.currentTarget);const btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;$('#onboarding-error').textContent='';
  try{await api('profile:init',{firstName:f.get('firstName'),lastName:f.get('lastName'),nickname:f.get('nickname')});await loadProfile();$('#onboarding').classList.add('hidden');$('#shell').classList.remove('hidden');await loadBaseData();navigate('home')}
  catch(err){$('#onboarding-error').textContent=err.message}finally{btn.disabled=false}
});

async function loadBaseData(){ await Promise.all([loadMyEvents(),loadFriends()]); watchNotifications(); }

async function loadMyEvents(){
  const refs=await getDocs(collection(db,'userEvents',state.user.uid,'items'));
  const rows=[];
  for(const r of refs.docs){const es=await getDoc(doc(db,'events',r.id));if(es.exists())rows.push({id:es.id,...es.data(),myStatus:r.data().status,role:r.data().role})}
  rows.sort((a,b)=>(a.startsAt?.toMillis?.()||0)-(b.startsAt?.toMillis?.()||0)); state.events=rows;
}

async function loadFriends(){
  const uid=state.user.uid;const [a,b]=await Promise.all([getDocs(query(collection(db,'friends'),where('userA','==',uid))),getDocs(query(collection(db,'friends'),where('userB','==',uid)))]);
  const ids=[...a.docs.map(d=>d.data().userB),...b.docs.map(d=>d.data().userA)];
  const out=[];for(const id of ids){const s=await getDoc(doc(db,'users',id));if(s.exists())out.push({id:s.id,...s.data()})}state.friends=out;
}

function watchNotifications(){
  const q=query(collection(db,'notifications'),where('userId','==',state.user.uid),orderBy('createdAt','desc'),limit(40));
  const u=onSnapshot(q,s=>{state.notifications=s.docs.map(d=>({id:d.id,...d.data()}));const unread=state.notifications.filter(x=>!x.read).length;const b=$('#notif-badge');b.textContent=unread;b.classList.toggle('hidden',!unread);if(state.currentView==='notifications')renderNotifications()});state.unsubs.push(u);
}

function navigate(view){
  clearEventSubscriptions();state.currentView=view;state.currentEventId=null;history.replaceState({},'',location.pathname);
  $$('#main-nav button[data-view],.bottom-nav button[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  if(view==='home')renderHome();if(view==='events')renderEvents();if(view==='calendar')renderCalendar();if(view==='friends')renderFriends();if(view==='notifications')renderNotifications();if(view==='profile')renderProfile();if(view==='settings')renderSettings();
}

$$('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
['#create-event-side','#create-event-top','#create-event-mobile'].forEach(s=>$(s).addEventListener('click',()=>$('#event-dialog').showModal()));
$$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('#theme-quick').addEventListener('click',()=>navigate('settings'));

$('#event-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=new FormData(e.currentTarget);const btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;$('#event-form-error').textContent='';
  try{
    const local=new Date(`${f.get('date')}T${f.get('time')}`);if(Number.isNaN(local.getTime()))throw new Error('Sana yoki vaqt noto‘g‘ri.');
    const res=await api('event:create',{title:f.get('title'),category:f.get('category'),description:f.get('description'),startsAtMs:local.getTime(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Tashkent',locationName:f.get('locationName'),cost:Number(f.get('cost')||0),visibility:f.get('visibility'),maxParticipants:Number(f.get('maxParticipants')||0)});
    e.currentTarget.reset();$('#event-form [name=date]').value=dateInputToday();$('#event-form [name=time]').value='16:00';$('#event-dialog').close();toast('Event yaratildi ✅');await loadMyEvents();openEvent(res.eventId)
  }catch(err){$('#event-form-error').textContent=err.message}finally{btn.disabled=false}
});

function eventCard(e){
  return `<article class="card event-card"><div class="event-top"><div class="event-icon">${cats[e.category]||'📌'}</div><span class="chip ${e.myStatus||''}">${esc(e.myStatus||e.status)}</span></div><div><h4>${esc(e.title)}</h4><div class="event-meta"><span>📅 ${fmtDate(e.startsAt)}</span>${e.locationName?`<span>📍 ${esc(e.locationName)}</span>`:''}</div></div><div class="event-actions"><button class="btn primary open-event" data-id="${e.id}">Ochish</button><span class="chip">⏳ ${countdown(e.startsAt)}</span></div></article>`
}
function bindEventCards(){ $$('.open-event').forEach(b=>b.addEventListener('click',()=>openEvent(b.dataset.id))) }

function renderHome(){
  setTitle('Home','Bugungi rejalaringiz');const upcoming=state.events.filter(e=>e.status!=='cancelled'&&(e.startsAt?.toMillis?.()||0)>Date.now());const going=upcoming.filter(e=>e.myStatus==='going').length;const next=upcoming[0];
  $('#view').innerHTML=`<section class="hero-card"><h1>Salom, ${esc(state.profile.firstName)} 👋</h1><p>Do‘stlaringiz bilan rejalarni bir joyda boshqaring. Event yarating, Telegram eslatmalarini ulang va kim kelishini real vaqtda ko‘ring.</p><button class="btn primary" id="hero-create">＋ Yangi event</button></section><div class="grid cols-4" style="margin-top:16px"><div class="card stat-card"><b>${upcoming.length}</b><span>Upcoming</span></div><div class="card stat-card"><b>${going}</b><span>Boradigan eventlar</span></div><div class="card stat-card"><b>${state.friends.length}</b><span>Do‘stlar</span></div><div class="card stat-card"><b>${next?countdown(next.startsAt):'—'}</b><span>Eng yaqin event</span></div></div><div class="section-title"><h3>Yaqin eventlar</h3><button class="btn ghost" id="all-events">Hammasi</button></div><div class="grid cols-3">${upcoming.slice(0,6).map(eventCard).join('')||'<div class="empty">Hozircha event yo‘q.</div>'}</div>`;
  $('#hero-create').onclick=()=>$('#event-dialog').showModal();$('#all-events').onclick=()=>navigate('events');bindEventCards();
}

function renderEvents(){
  setTitle('Eventlar','Barcha eventlaringiz');
  $('#view').innerHTML=`<div class="section-title"><h3>${state.events.length} ta event</h3><button class="btn primary" id="events-create">＋ Event yaratish</button></div><div class="grid cols-3">${state.events.map(eventCard).join('')||'<div class="empty">Event yo‘q.</div>'}</div>`;$('#events-create').onclick=()=>$('#event-dialog').showModal();bindEventCards();
}

function renderCalendar(){
  setTitle('Calendar','Eventlarni oy bo‘yicha ko‘ring');const now=new Date(),y=now.getFullYear(),m=now.getMonth(),first=new Date(y,m,1),days=new Date(y,m+1,0).getDate(),offset=(first.getDay()+6)%7;let cells='';for(let i=0;i<offset;i++)cells+='<div></div>';for(let d=1;d<=days;d++){const matches=state.events.filter(e=>{const x=e.startsAt?.toDate?.();return x&&x.getFullYear()===y&&x.getMonth()===m&&x.getDate()===d});cells+=`<div class="cal-cell"><span class="day">${d}</span>${matches.map(e=>`<button class="cal-event open-event" data-id="${e.id}">${esc(e.title)}</button>`).join('')}</div>`}$('#view').innerHTML=`<div class="card"><h3>${new Intl.DateTimeFormat('uz-UZ',{month:'long',year:'numeric'}).format(now)}</h3><div class="calendar-grid"><b>Dush</b><b>Sesh</b><b>Chor</b><b>Pay</b><b>Jum</b><b>Shan</b><b>Yak</b>${cells}</div></div>`;bindEventCards();
}

async function renderFriends(){
  setTitle('Do‘stlar','Qidiring, qo‘shing va eventga chaqiring');
  const reqs=await getDocs(query(collection(db,'friendRequests'),where('toUid','==',state.user.uid),where('status','==','pending')));
  $('#view').innerHTML=`<div class="card"><form id="friend-search" class="chat-form"><input name="term" placeholder="Nickname yoki Public ID"><button class="btn primary">Qidirish</button></form><div id="search-results" class="list" style="margin-top:12px"></div></div><div class="section-title"><h3>So‘rovlar (${reqs.size})</h3></div><div class="list" id="friend-requests">${reqs.docs.map(d=>friendRequestRow(d)).join('')||'<div class="empty">Yangi so‘rov yo‘q.</div>'}</div><div class="section-title"><h3>Do‘stlar (${state.friends.length})</h3></div><div class="list">${state.friends.map(friendRow).join('')||'<div class="empty">Hozircha do‘st yo‘q.</div>'}</div>`;
  $('#friend-search').onsubmit=async e=>{e.preventDefault();const term=new FormData(e.currentTarget).get('term');const box=$('#search-results');box.innerHTML='<div class="empty">Qidirilmoqda...</div>';try{const r=await api('users:search',{term});box.innerHTML=r.users.map(u=>`<div class="list-row"><div class="left"><div class="avatar">${esc((u.firstName?.[0]||'U').toUpperCase())}</div><div><b>${esc(u.nickname)}</b><small>${esc(u.publicId)} · ${esc(u.firstName)} ${esc(u.lastName)}</small></div></div><button class="btn primary add-friend" data-id="${u.id}">＋ Add</button></div>`).join('')||'<div class="empty">Topilmadi.</div>';$$('.add-friend').forEach(b=>b.onclick=async()=>{try{await api('friend:request',{toUid:b.dataset.id});toast('Do‘stlik so‘rovi yuborildi');b.disabled=true}catch(err){toast(err.message,'error')}})}catch(err){box.innerHTML=`<div class="empty">${esc(err.message)}</div>`}};
  $$('.friend-respond').forEach(b=>b.onclick=async()=>{try{await api('friend:respond',{requestId:b.dataset.id,decision:b.dataset.decision});toast('Yangilandi');await loadFriends();renderFriends()}catch(err){toast(err.message,'error')}});
  $$('.remove-friend').forEach(b=>b.onclick=async()=>{if(!confirm('Do‘stni olib tashlaysizmi?'))return;try{await api('friend:remove',{otherUid:b.dataset.id});await loadFriends();renderFriends();toast('Do‘st olib tashlandi')}catch(err){toast(err.message,'error')}})
}
function friendRow(u){return `<div class="list-row"><div class="left"><div class="avatar">${u.avatarUrl?`<img src="${esc(u.avatarUrl)}">`:esc((u.firstName?.[0]||'U').toUpperCase())}</div><div><b>${esc(u.nickname)}</b><small>${esc(u.publicId)} · ${esc(u.firstName)} ${esc(u.lastName)}</small></div></div><button class="btn ghost remove-friend" data-id="${u.id}">Remove</button></div>`}
function friendRequestRow(d){const x=d.data();return `<div class="list-row"><div class="left"><div class="avatar">?</div><div><b>Yangi so‘rov</b><small>${esc(x.fromUid)}</small></div></div><div><button class="btn primary friend-respond" data-id="${d.id}" data-decision="accept">Accept</button> <button class="btn ghost friend-respond" data-id="${d.id}" data-decision="decline">Decline</button></div></div>`}

function renderNotifications(){
  setTitle('Bildirishnomalar','Takliflar va yangilanishlar');const items=state.notifications||[];$('#view').innerHTML=`<div class="list">${items.map(n=>`<div class="list-row notif ${n.read?'':'unread'}"><div class="left"><div class="event-icon">🔔</div><div><b>${esc(n.title)}</b><small>${esc(n.text||'')} · ${n.createdAt?fmtDate(n.createdAt):''}</small></div></div>${n.data?.eventId?`<button class="btn ghost open-event" data-id="${n.data.eventId}">Ochish</button>`:''}</div>`).join('')||'<div class="empty">Bildirishnoma yo‘q.</div>'}</div>`;bindEventCards();
}

async function renderProfile(){
  setTitle('Profile','Sizning NEXUS profilingiz');let tg={connected:false};try{tg=await api('telegram:status')}catch{}
  const p=state.profile;$('#view').innerHTML=`<div class="grid cols-2"><div class="card"><div style="display:flex;gap:16px;align-items:center"><div class="avatar" style="width:72px;height:72px;font-size:24px">${p.avatarUrl?`<img src="${esc(p.avatarUrl)}">`:initials()}</div><div><h2 style="margin:0">${esc(p.firstName)} ${esc(p.lastName)}</h2><p class="muted">${esc(p.nickname)} · ${esc(p.publicId)}</p></div></div><form id="profile-form" style="margin-top:20px"><label>Ism<input name="firstName" value="${esc(p.firstName)}"></label><label>Familiya<input name="lastName" value="${esc(p.lastName)}"></label><label>Nickname<input name="nickname" value="${esc(p.nickname)}"></label><label>Avatar URL<input name="avatarUrl" value="${esc(p.avatarUrl||'')}" placeholder="https://..."></label><button class="btn primary" style="margin-top:14px">Saqlash</button></form></div><div class="card"><h3>Telegram</h3><p>${tg.connected?'✅ Ulangan':'⚠️ Ulanmagan'}</p>${tg.connected&&tg.username?`<p class="muted">@${esc(tg.username)}</p>`:''}<button class="btn primary" id="connect-tg">${tg.connected?'Qayta ulash':'Telegramni ulash'}</button><p class="muted">Bot: @NexusEvent_Bot. Bir marta ulangandan keyin event takliflari va 12/6/3/2/1 soatlik eslatmalar avtomatik keladi.</p></div></div>`;
  $('#profile-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('profile:update',{firstName:f.get('firstName'),lastName:f.get('lastName'),nickname:f.get('nickname'),avatarUrl:f.get('avatarUrl')});await loadProfile();toast('Profile saqlandi')}catch(err){toast(err.message,'error')}};
  $('#connect-tg').onclick=async()=>{try{const r=await api('telegram:createLink');window.open(r.url,'_blank','noopener');toast('Telegram ochildi. Botda Start bosing.')}catch(err){toast(err.message,'error')}};
}

function renderSettings(){
  setTitle('Settings','Dizayn va ko‘rinish');const active=document.documentElement.dataset.theme;$('#view').innerHTML=`<div class="card"><h3>10 xil professional theme</h3><p class="muted">Tanlangan theme darhol ishlaydi va keyingi kirishda ham saqlanadi.</p><div class="grid theme-grid">${THEMES.map(([id,name,c1,c2])=>`<button class="theme-card ${id===active?'active':''}" data-theme-id="${id}" style="--tp1:${c1};--tp2:${c2}"><div class="theme-preview"></div><b>${esc(name)}</b><small>${id===active?'Tanlangan':'Apply'}</small></button>`).join('')}</div></div>`;
  $$('.theme-card').forEach(b=>b.onclick=async()=>{const id=applyTheme(b.dataset.themeId);try{await api('profile:update',{themeId:id});state.profile.themeId=id}catch{}renderSettings();toast('Theme o‘zgardi')});
}

let eventUnsubs=[];function clearEventSubscriptions(){eventUnsubs.forEach(fn=>{try{fn()}catch{}});eventUnsubs=[]}
async function openEvent(eventId){
  clearEventSubscriptions();state.currentEventId=eventId;history.replaceState({},'',`/?event=${encodeURIComponent(eventId)}`);setTitle('Event','Real-time event boshqaruvi');
  const es=await getDoc(doc(db,'events',eventId));if(!es.exists()){toast('Event topilmadi','error');return navigate('events')}const ev={id:es.id,...es.data()};
  $('#view').innerHTML=`<div id="event-shell"><div class="card"><div class="event-detail-header"><div><span class="chip">${cats[ev.category]||'📌'} ${esc(ev.category)}</span><h2 style="margin-top:10px">${esc(ev.title)}</h2><p class="muted">${esc(ev.description||'')}</p><div class="event-meta"><span>📅 ${fmtDate(ev.startsAt)}</span>${ev.locationName?`<span>📍 ${esc(ev.locationName)}</span>`:''}${ev.cost?`<span>💰 ${Number(ev.cost).toLocaleString('uz-UZ')} UZS</span>`:''}<span>🔐 Code: ${esc(ev.joinCode||'')}</span></div></div><div><div class="countdown" id="countdown">${countdown(ev.startsAt)}</div><div id="my-rsvp" style="margin-top:12px"></div></div></div><div class="tabs" id="event-tabs"><button data-tab="overview" class="active">Overview</button><button data-tab="people">People</button><button data-tab="chat">Chat</button><button data-tab="polls">Polls</button><button data-tab="money">Money</button><button data-tab="teams">Teams</button><button data-tab="gallery">Gallery</button><button data-tab="results">Results</button></div><div id="event-tab"></div></div></div>`;
  const timer=setInterval(()=>{const c=$('#countdown');if(c)c.textContent=countdown(ev.startsAt);else clearInterval(timer)},30000);eventUnsubs.push(()=>clearInterval(timer));
  const partQ=query(collection(db,'events',eventId,'participants'),orderBy('displayName'));eventUnsubs.push(onSnapshot(partQ,s=>{state.currentParticipants=s.docs.map(d=>({id:d.id,...d.data()}));renderRsvp(ev);renderEventTab(ev)}));
  const msgQ=query(collection(db,'events',eventId,'messages'),orderBy('createdAt','asc'),limit(200));eventUnsubs.push(onSnapshot(msgQ,s=>{state.currentMessages=s.docs.map(d=>({id:d.id,...d.data()}));if(state.eventTab==='chat')renderEventTab(ev)}));
  eventUnsubs.push(onSnapshot(collection(db,'events',eventId,'polls'),s=>{state.currentPolls=s.docs.map(d=>({id:d.id,...d.data()}));if(state.eventTab==='polls')renderEventTab(ev)}));
  eventUnsubs.push(onSnapshot(collection(db,'events',eventId,'expenses'),s=>{state.currentExpenses=s.docs.map(d=>({id:d.id,...d.data()}));if(state.eventTab==='money')renderEventTab(ev)}));
  eventUnsubs.push(onSnapshot(collection(db,'events',eventId,'teams'),s=>{state.currentTeams=s.docs.map(d=>({id:d.id,...d.data()}));if(state.eventTab==='teams')renderEventTab(ev)}));
  eventUnsubs.push(onSnapshot(collection(db,'events',eventId,'gallery'),s=>{state.currentGallery=s.docs.map(d=>({id:d.id,...d.data()}));if(state.eventTab==='gallery')renderEventTab(ev)}));
  state.eventTab='overview';renderEventTab(ev);$('#event-tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(!b)return;state.eventTab=b.dataset.tab;$$('#event-tabs button').forEach(x=>x.classList.toggle('active',x===b));renderEventTab(ev)};
}

function renderRsvp(ev){
  const mine=(state.currentParticipants||[]).find(p=>p.id===state.user.uid);const box=$('#my-rsvp');if(!box)return;box.innerHTML=`<div class="event-actions"><button class="btn ${mine?.status==='going'?'primary':'ghost'} rsvp" data-status="going">✅ Boraman</button><button class="btn ${mine?.status==='maybe'?'primary':'ghost'} rsvp" data-status="maybe">🤔 Balki</button><button class="btn ${mine?.status==='notGoing'?'danger':'ghost'} rsvp" data-status="notGoing">❌ Bormayman</button></div>`;$$('.rsvp').forEach(b=>b.onclick=async()=>{try{await api('event:rsvp',{eventId:ev.id,status:b.dataset.status});toast('Javob saqlandi')}catch(err){toast(err.message,'error')}})
}

function renderEventTab(ev){
  const box=$('#event-tab');if(!box)return;const ps=state.currentParticipants||[],isOrg=ev.organizerId===state.user.uid;
  if(state.eventTab==='overview'){
    const going=ps.filter(p=>p.status==='going').length,maybe=ps.filter(p=>p.status==='maybe').length;
    box.innerHTML=`<div class="grid cols-3"><div class="card stat-card"><b>${going}</b><span>Boradi</span></div><div class="card stat-card"><b>${maybe}</b><span>Balki</span></div><div class="card stat-card"><b>${ps.length}</b><span>Jami</span></div></div>${isOrg?`<div class="section-title"><h3>Organizer tools</h3></div><div class="event-actions"><button class="btn primary" id="invite-friends">Do‘stlarni chaqirish</button><button class="btn ghost" id="edit-event">Eventni tahrirlash</button><button class="btn ghost" id="new-poll">Poll yaratish</button><button class="btn danger" id="cancel-event">Eventni bekor qilish</button></div>`:''}`;
    if(isOrg){$('#invite-friends').onclick=()=>showInviteFriends(ev);$('#edit-event').onclick=()=>showEditEvent(ev);$('#new-poll').onclick=()=>showPollForm(ev);$('#cancel-event').onclick=async()=>{if(confirm('Eventni bekor qilasizmi?'))try{await api('event:cancel',{eventId:ev.id});toast('Event bekor qilindi');await loadMyEvents();navigate('events')}catch(err){toast(err.message,'error')}}}
  }
  if(state.eventTab==='people') box.innerHTML=`<div class="list">${ps.map(p=>`<div class="list-row"><div class="left"><div class="avatar">${esc((p.displayName||'?')[0])}</div><div><b>${esc(p.displayName||p.nickname)}</b><small>${esc(p.nickname||'')}</small></div></div><span class="chip ${p.status}">${esc(p.status)}</span></div>`).join('')||'<div class="empty">Qatnashchilar yo‘q.</div>'}</div>`;
  if(state.eventTab==='chat'){
    const msgs=state.currentMessages||[];box.innerHTML=`<div class="chat-box" id="chat-box">${msgs.map(m=>`<div class="msg ${m.userId===state.user.uid?'me':''}"><b>${esc(m.userName||'User')}</b><div>${esc(m.text)}</div><small>${m.createdAt?fmtDate(m.createdAt):'hozir'}</small></div>`).join('')}</div><form id="chat-form" class="chat-form"><input name="text" maxlength="1500" placeholder="Xabar yozing..." required><button class="btn primary">Yuborish</button></form>`;const cb=$('#chat-box');cb.scrollTop=cb.scrollHeight;$('#chat-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),text=String(f.get('text')||'').trim();if(!text)return;try{await addDoc(collection(db,'events',ev.id,'messages'),{userId:state.user.uid,userName:state.profile.nickname,text,createdAt:serverTimestamp()});e.currentTarget.reset()}catch(err){toast(err.message,'error')}};
  }
  if(state.eventTab==='polls'){
    const polls=state.currentPolls||[];box.innerHTML=`${isOrg?'<button class="btn primary" id="poll-add">＋ Poll</button>':''}<div class="list" style="margin-top:12px">${polls.map(p=>`<div class="card"><b>${esc(p.question)}</b>${p.options.map(o=>`<label class="poll-option"><input type="radio" name="poll-${p.id}" value="${o.id}">${esc(o.text)}</label>`).join('')}<button class="btn ghost vote-poll" data-id="${p.id}">Vote</button></div>`).join('')||'<div class="empty">Poll yo‘q.</div>'}</div>`;if(isOrg)$('#poll-add').onclick=()=>showPollForm(ev);$$('.vote-poll').forEach(b=>b.onclick=async()=>{const selected=$(`input[name="poll-${b.dataset.id}"]:checked`);if(!selected)return toast('Variant tanlang','error');try{await api('poll:vote',{eventId:ev.id,pollId:b.dataset.id,optionIds:[selected.value]});toast('Ovoz saqlandi')}catch(err){toast(err.message,'error')}})
  }
  if(state.eventTab==='money'){
    const ex=state.currentExpenses||[],total=ex.reduce((s,x)=>s+Number(x.amount||0),0),going=ps.filter(p=>p.status==='going'),share=going.length?Math.floor(total/going.length):0;box.innerHTML=`<div class="grid cols-3"><div class="card"><span class="muted">Jami xarajat</span><div class="money-summary">${total.toLocaleString('uz-UZ')}</div><small>UZS</small></div><div class="card"><span class="muted">1 kishiga taxminan</span><div class="money-summary">${share.toLocaleString('uz-UZ')}</div><small>UZS</small></div><div class="card"><span class="muted">Going</span><div class="money-summary">${going.length}</div></div></div>${isOrg?'<button class="btn primary" id="expense-add" style="margin-top:14px">＋ Xarajat</button>':''}<div class="list" style="margin-top:12px">${ex.map(x=>`<div class="list-row"><div><b>${esc(x.title)}</b><small class="muted">Paid by ${esc((ps.find(p=>p.id===x.paidByUid)?.displayName)||x.paidByUid)}</small></div><b>${Number(x.amount).toLocaleString('uz-UZ')} UZS</b></div>`).join('')||'<div class="empty">Xarajat yo‘q.</div>'}</div>`;if(isOrg)$('#expense-add').onclick=()=>showExpenseForm(ev,going)
  }
  if(state.eventTab==='teams'){
    const teams=state.currentTeams||[];box.innerHTML=`${isOrg?'<div class="event-actions"><button class="btn primary team-gen" data-mode="balanced">Balanced teams</button><button class="btn ghost team-gen" data-mode="random">Random teams</button></div>':''}<div class="grid cols-2" style="margin-top:12px">${teams.map(t=>`<div class="card team-card"><h3>${esc(t.name)}</h3>${(t.memberUids||[]).map(id=>`<div>• ${esc(ps.find(p=>p.id===id)?.displayName||id)}</div>`).join('')}</div>`).join('')||'<div class="empty">Teamlar hali yaratilmagan.</div>'}</div>`;$$('.team-gen').forEach(b=>b.onclick=async()=>{try{await api('teams:generate',{eventId:ev.id,mode:b.dataset.mode,teamCount:2});toast('Teamlar yaratildi')}catch(err){toast(err.message,'error')}})
  }
  if(state.eventTab==='gallery'){
    const items=state.currentGallery||[];box.innerHTML=`<p class="muted">Firebase Storage Blaze talab qilgani uchun hozircha rasm URL orqali qo‘shiladi.</p><form id="gallery-form" class="chat-form"><input name="url" placeholder="https://... rasm URL" required><input name="caption" placeholder="Izoh"><button class="btn primary">Qo‘shish</button></form><div class="grid cols-3" style="margin-top:12px">${items.map(i=>`<div class="card"><img src="${esc(i.url)}" alt="" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:14px"><p>${esc(i.caption||'')}</p></div>`).join('')||'<div class="empty">Rasm yo‘q.</div>'}</div>`;$('#gallery-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('gallery:addLink',{eventId:ev.id,url:f.get('url'),caption:f.get('caption')});e.currentTarget.reset();toast('Rasm qo‘shildi')}catch(err){toast(err.message,'error')}}
  }
  if(state.eventTab==='results') box.innerHTML=`${isOrg?`<form id="result-form" class="card form-grid"><label>Team A<input name="teamA" value="Team A"></label><label>Score A<input name="scoreA" type="number" value="0"></label><label>Team B<input name="teamB" value="Team B"></label><label>Score B<input name="scoreB" type="number" value="0"></label><label class="full">Izoh<textarea name="notes"></textarea></label><button class="btn primary full">Natijani saqlash</button></form>`:'<div class="empty">Natijani organizer kiritadi.</div>'}<div class="section-title"><h3>MVP vote</h3></div><div class="list">${ps.filter(p=>p.status==='going').map(p=>`<div class="list-row"><b>${esc(p.displayName)}</b><button class="btn ghost mvp-vote" data-id="${p.id}">MVP</button></div>`).join('')}</div>`;if(isOrg)$('#result-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('result:save',{eventId:ev.id,teamA:f.get('teamA'),scoreA:f.get('scoreA'),teamB:f.get('teamB'),scoreB:f.get('scoreB'),notes:f.get('notes')});toast('Natija saqlandi')}catch(err){toast(err.message,'error')}};$$('.mvp-vote').forEach(b=>b.onclick=async()=>{try{await api('mvp:vote',{eventId:ev.id,candidateUid:b.dataset.id});toast('MVP ovozi saqlandi')}catch(err){toast(err.message,'error')}})
}

function showEditEvent(ev){
  const d=ev.startsAt?.toDate?.()||new Date();
  const ymd=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const hm=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const body=$('#generic-dialog-body');
  body.innerHTML=`<header><div><h3>Eventni tahrirlash</h3><p>Vaqt o‘zgarsa Telegram reminderlar avtomatik qayta tuziladi.</p></div><button class="icon-btn" id="gclose">×</button></header><form id="edit-event-form" class="form-grid"><label class="full">Nomi<input name="title" value="${esc(ev.title)}" required></label><label>Sana<input name="date" type="date" value="${ymd}" required></label><label>Vaqt<input name="time" type="time" value="${hm}" required></label><label>Joy<input name="locationName" value="${esc(ev.locationName||'')}"></label><label>Narx<input name="cost" type="number" min="0" value="${Number(ev.cost||0)}"></label><label class="full">Tavsif<textarea name="description">${esc(ev.description||'')}</textarea></label><button class="btn primary full">Saqlash</button></form>`;
  $('#generic-dialog').showModal();$('#gclose').onclick=()=>$('#generic-dialog').close();
  $('#edit-event-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),local=new Date(`${f.get('date')}T${f.get('time')}`);try{await api('event:update',{eventId:ev.id,title:f.get('title'),description:f.get('description'),locationName:f.get('locationName'),cost:Number(f.get('cost')||0),startsAtMs:local.getTime(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Tashkent'});$('#generic-dialog').close();toast('Event yangilandi');await loadMyEvents();openEvent(ev.id)}catch(err){toast(err.message,'error')}};
}

function showInviteFriends(ev){
  const body=$('#generic-dialog-body');body.innerHTML=`<header><div><h3>Do‘stlarni chaqirish</h3><p>${esc(ev.title)}</p></div><button class="icon-btn" id="gclose">×</button></header><div class="list">${state.friends.map(f=>`<div class="list-row"><div class="left"><div class="avatar">${esc((f.firstName?.[0]||'U').toUpperCase())}</div><div><b>${esc(f.nickname)}</b><small>${esc(f.publicId)}</small></div></div><button class="btn primary invite-one" data-id="${f.id}">Invite</button></div>`).join('')||'<div class="empty">Avval do‘st qo‘shing.</div>'}</div>`;$('#generic-dialog').showModal();$('#gclose').onclick=()=>$('#generic-dialog').close();$$('.invite-one').forEach(b=>b.onclick=async()=>{try{const r=await api('event:invite',{eventId:ev.id,toUid:b.dataset.id});toast(r.telegramSent?'Taklif + Telegram yuborildi':'Taklif yuborildi (Telegram ulanmagan)');b.disabled=true}catch(err){toast(err.message,'error')}})
}
function showPollForm(ev){
  const body=$('#generic-dialog-body');body.innerHTML=`<header><div><h3>Poll yaratish</h3></div><button class="icon-btn" id="gclose">×</button></header><form id="poll-form"><label>Savol<input name="question" required maxlength="200"></label><label>Variantlar (har qatorda bittadan)<textarea name="options" rows="6" required placeholder="Stadion A\nStadion B\nStadion C"></textarea></label><button class="btn primary" style="margin-top:14px">Yaratish</button></form>`;$('#generic-dialog').showModal();$('#gclose').onclick=()=>$('#generic-dialog').close();$('#poll-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),options=String(f.get('options')).split('\n').map(x=>x.trim()).filter(Boolean);try{await api('poll:create',{eventId:ev.id,question:f.get('question'),options});$('#generic-dialog').close();toast('Poll yaratildi')}catch(err){toast(err.message,'error')}}
}
function showExpenseForm(ev,going){
  const body=$('#generic-dialog-body');body.innerHTML=`<header><div><h3>Xarajat qo‘shish</h3></div><button class="icon-btn" id="gclose">×</button></header><form id="expense-form"><label>Nomi<input name="title" required placeholder="Maydon puli"></label><label>Summa<input name="amount" type="number" min="1" required></label><label>Kim to‘ladi?<select name="paidByUid">${going.map(p=>`<option value="${p.id}">${esc(p.displayName)}</option>`).join('')}</select></label><button class="btn primary" style="margin-top:14px">Qo‘shish</button></form>`;$('#generic-dialog').showModal();$('#gclose').onclick=()=>$('#generic-dialog').close();$('#expense-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('expense:add',{eventId:ev.id,title:f.get('title'),amount:Number(f.get('amount')),paidByUid:f.get('paidByUid')});$('#generic-dialog').close();toast('Xarajat qo‘shildi')}catch(err){toast(err.message,'error')}}
}

window.addEventListener('popstate',()=>{const id=new URL(location.href).searchParams.get('event');if(id)openEvent(id);else navigate('home')});
window.addEventListener('beforeunload',()=>{clearUnsubs();clearEventSubscriptions()});
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
init().catch(err=>{console.error(err);$('#app-loader').innerHTML=`<div class="card">Xatolik: ${esc(err.message)}</div>`});
