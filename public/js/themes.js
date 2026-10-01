export const THEMES = [
  ['nexus-dark','Nexus Dark','#08101f','#3b82f6'],
  ['ocean','Ocean','#06141b','#12b8c8'],
  ['purple-night','Purple Night','#100b1f','#a855f7'],
  ['emerald','Emerald','#071712','#10b981'],
  ['crimson','Crimson','#16090c','#e11d48'],
  ['minimal-light','Minimal Light','#f5f7fb','#2563eb'],
  ['midnight-gold','Midnight Gold','#090b10','#c89b3c'],
  ['cyber-blue','Cyber Blue','#050c19','#00bfe8'],
  ['sunset','Sunset','#131021','#f97316'],
  ['graphite','Graphite','#0f1216','#5c89ff']
];

export function applyTheme(id) {
  const valid = THEMES.some(t => t[0] === id) ? id : 'nexus-dark';
  document.documentElement.dataset.theme = valid;
  localStorage.setItem('nexusEventTheme', valid);
  return valid;
}

export function applyCachedTheme() {
  applyTheme(localStorage.getItem('nexusEventTheme') || 'nexus-dark');
}
