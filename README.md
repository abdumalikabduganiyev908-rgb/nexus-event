# NEXUS EVENT

Professional event-planning app for Netlify + Firebase + Telegram.

## What is already included

- Firebase Anonymous Auth (no email/password)
- Name + surname + nickname onboarding
- Firestore shared database
- Create/edit/cancel events
- Going / Maybe / Not Going RSVP
- Real-time participants
- Real-time event group chat
- Friends, friend requests and user search
- Telegram linking with `@NexusEvent_Bot`
- Telegram event invitations with inline RSVP buttons
- Automatic 12h / 6h / 3h / 2h / 1h Telegram reminders
- Reminder duplicate protection and rescheduling after event time changes
- Polls
- Expense tracking
- Random / balanced team generator
- Result + MVP vote
- Link-based gallery (Firebase Storage is not used because this Firebase project currently requires Blaze for Storage)
- Calendar
- Website notifications
- 10 selectable professional themes
- PWA shell
- Firestore Security Rules
- Netlify Functions backend

## 1. Firebase Console

Project already used by this package:

`nexus-event-52836`

Enable these products:

### Authentication

Authentication -> Sign-in method -> Anonymous -> Enable.

### Firestore

Create Firestore in Production mode.

### Storage

Not required for this version. Gallery accepts image URLs so the project can stay on the current Firebase plan.

## 2. Firestore Rules

Copy the contents of `firestore.rules` into:

Firebase Console -> Firestore Database -> Rules

then Publish.

Or, if Firebase CLI is installed:

```bash
firebase login
firebase use nexus-event-52836
firebase deploy --only firestore:rules,firestore:indexes
```

The reminder worker uses a Firestore query that may require the included composite index. If Firebase displays a missing-index link, open it once and create the suggested index, or deploy `firestore.indexes.json` with Firebase CLI.

## 3. Create Firebase Admin credentials

Firebase Console -> Project settings -> Service accounts.

Create/get the server credentials and put them in **Netlify Environment Variables**, never in frontend JS.

Required variables:

```text
FIREBASE_PROJECT_ID=nexus-event-52836
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

For the private key, keep newline characters as `\n` in Netlify if pasted as one line. The server code converts them back.

## 4. Telegram bot

Bot username used by this project:

`@NexusEvent_Bot`

Get the bot token from BotFather, but **do not put the token in frontend files**.

Netlify environment variables:

```text
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_BOT_USERNAME=NexusEvent_Bot
TELEGRAM_WEBHOOK_SECRET=create_a_long_random_secret
SITE_URL=https://YOUR-SITE.netlify.app
CRON_SECRET=create_another_long_random_secret
```

`TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET` should be long random values.

## 5. Install and test locally

From the project folder:

```bash
npm install
npm run dev
```

Netlify Dev will serve the frontend and functions together.

## 6. Deploy to Netlify

The easiest flow:

1. Create a GitHub repository.
2. Upload this project.
3. Netlify -> Add new project -> Import from Git.
4. Select the repository.
5. Build configuration is already in `netlify.toml`.
6. Add all environment variables listed above.
7. Deploy.
8. Set `SITE_URL` to the final Netlify URL and redeploy.

## 7. Set Telegram webhook

After deploy, the webhook URL is:

```text
https://YOUR-SITE.netlify.app/.netlify/functions/telegram-webhook
```

The package contains a secure helper function `telegram-set-webhook`.

Call it once using a POST request with the same `CRON_SECRET` as the `x-setup-secret` header.

Example with PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "https://YOUR-SITE.netlify.app/.netlify/functions/telegram-set-webhook" `
  -Headers @{"x-setup-secret"="YOUR_CRON_SECRET"}
```

It registers the webhook and Telegram secret-token verification automatically.

## 8. Telegram connection flow

A user does this once:

1. Open NEXUS EVENT.
2. Profile -> Telegramni ulash.
3. Telegram opens `@NexusEvent_Bot` with a one-time link.
4. Press Start.
5. The bot links the Telegram `chat_id` to the Firebase user.

After that, they do not need to press Start for every event.

## 9. Reminder flow

A user marked `going` gets reminder records for:

- 12 hours before
- 6 hours before
- 3 hours before
- 2 hours before
- 1 hour before

`reminder-worker` runs from Netlify's scheduler every minute according to `netlify.toml`.

If your Netlify plan/environment does not execute Scheduled Functions, the same worker also supports an external cron fallback. Call this URL once per minute with `x-cron-secret`:

```text
https://YOUR-SITE.netlify.app/.netlify/functions/reminder-worker
```

Header:

```text
x-cron-secret: YOUR_CRON_SECRET
```

The reminders are server-side, so the browser and computer do not need to stay open.

## 10. Reminder safety

The worker checks before every send:

- event still exists
- event is not cancelled
- user is still Going
- Telegram is connected
- reminder has not already been sent

Changing the event time cancels old reminders and creates new future reminders. Changing Going -> Not Going cancels future reminders.

## 11. Firestore collections

Main collections:

```text
users
admins
telegramConnections
telegramLinkTokens
friends
friendRequests
userEvents
events
  /participants
  /messages
  /polls
  /expenses
  /teams
  /gallery
  /mvpVotes
eventReminders
notifications
```

## 12. Admin access

The current build focuses on the user/event experience. `firestore.rules` already reserves an `admins/{uid}` collection for secure admin identities. Do not use a frontend-only `isAdmin=true` flag.

## 13. Important security notes

Never publish or commit:

- `TELEGRAM_BOT_TOKEN`
- Firebase private key
- Firebase Admin credentials
- `CRON_SECRET`
- `TELEGRAM_WEBHOOK_SECRET`

The Firebase Web config in `public/js/firebase.js` is client configuration and is protected by Auth + Firestore Security Rules; server credentials are different and must remain private.

## 14. 10 themes

Settings includes:

1. Nexus Dark
2. Ocean
3. Purple Night
4. Emerald
5. Crimson
6. Minimal Light
7. Midnight Gold
8. Cyber Blue
9. Sunset
10. Graphite

Theme selection is saved to the Firebase profile and cached locally for fast startup.

## 15. Current gallery limitation

Firebase Console showed that Cloud Storage requires Blaze for this project. To avoid requiring billing, the included Gallery accepts normal HTTPS image links. If Storage is enabled later, replace the gallery URL flow with Firebase Storage uploads without changing the rest of the event architecture.
