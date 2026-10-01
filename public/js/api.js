import { auth } from './firebase.js';

export async function api(action, payload = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Login session yo‘q.');
  const token = await user.getIdToken();
  const res = await fetch('/api/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}
