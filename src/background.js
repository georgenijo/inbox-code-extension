import { httpsOrigin, validDomain, defaultSender } from './core.js';
import { findCodes, gmailRequest, clearCodeCache } from './gmail.js';
import { accessToken as token, invalidateToken, disconnectAuth, cachedToken, authConfigured as configured } from './auth.js';

const sessions = new Map();
let generation = 0, busy = false, nextFetchAt = 0, authTask;
const UI = new Set(['popup.html', 'setup.html'].map(path => chrome.runtime.getURL(path)));
const messages = {
  SETUP: 'Connect Gmail to get started.', UNCONFIGURED: 'Google sign-in has not been configured for this build.',
  RECONNECT: 'Reconnect Gmail from the extension button.', GMAIL_ACCESS: 'Gmail access was denied. Check the Gmail API and read-only permission.',
  NETWORK: 'Could not reach Gmail. Try again shortly.', RATE_LIMIT: 'Gmail is busy. Waiting a minute before trying again.',
  AUTH_CANCELLED: 'Google sign-in was closed or could not finish. Try Connect with Google again.',
  AUTH_RESPONSE: 'Google sign-in returned an invalid response. Please reconnect.',
  INTERNAL: 'This action could not finish. Reopen Inbox Code and try again.',
  DENIED: 'Inbox Code is off for this site.', INVALID: 'This request is not allowed.',
};
function fail(code) { throw Object.assign(new Error(messages[code] ?? messages.NETWORK), { code }); }
async function config() { return (await chrome.storage.local.get({ connected: false, needsReconnect: false, email: '', sites: {}, disabledSites: {} })); }
function uiSender(sender) { return sender.id === chrome.runtime.id && UI.has(sender.url); }
let registration = Promise.resolve(), siteChanges = Promise.resolve();
function senderDomain(settings, origin) {
  // Preserve intentional custom senders from existing installs, while correcting
  // the old Cloudflare default that prevented its real emails from matching.
  const saved = settings.sites[origin]?.senderDomain;
  return saved && !(defaultSender(origin) === 'notify.cloudflare.com' && ['cloudflareaccess.com', 'cloudflare.com'].includes(saved)) ? saved : defaultSender(origin);
}
function registerSites() {
  registration = registration.catch(() => {}).then(syncSites);
  return registration;
}
async function syncSites() {
  const { disabledSites } = await config();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.some(s => s.id === 'inbox-code')) await chrome.scripting.unregisterContentScripts({ ids: ['inbox-code'] });
  // Chrome applies the user's per-site grant/withheld access at injection time.
  await chrome.scripting.registerContentScripts([{ id: 'inbox-code', matches: ['https://*/*'],
      excludeMatches: Object.keys(disabledSites).filter(origin => httpsOrigin(origin) === origin).map(origin => `${origin}/*`),
      js: ['content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
}
async function pageContext(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id) fail('INVALID');
  const origin = httpsOrigin(sender.url);
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!origin || httpsOrigin(tab.url) !== origin || !tab.active || (sender.documentId && sender.documentLifecycle !== 'active')) fail('INVALID');
  const settings = await config();
  if (!settings.connected) fail('SETUP');
  if (settings.disabledSites[origin] || !senderDomain(settings, origin) || !await chrome.permissions.contains({ origins: [`${origin}/*`] })) fail('DENIED');
  return { origin, settings, key: `${sender.tab.id}:${sender.documentId ?? sender.url}` };
}
async function poll(sender) {
  const currentGeneration = generation;
  const { origin, settings, key } = await pageContext(sender);
  const now = Date.now();
  let session = sessions.get(key);
  if (!session || session.origin !== origin || now > session.endsAt) {
    session = { origin, since: now - 120_000, endsAt: now + 5 * 60_000, checkedAt: 0, candidates: [], consumed: new Set() };
    sessions.set(key, session);
  }
  if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
  const usedCodes = (await chrome.storage.session.get('usedCodes')).usedCodes ?? {};
  const unused = c => !(usedCodes[`${settings.email}|${c.id}`] > now);
  session.candidates = session.candidates.filter(x => x.expiresAt > now && !session.consumed.has(x.id) && unused(x));
  if (busy || now < nextFetchAt || now - session.checkedAt < 5_000) {
    await pageContext(sender);
    return { candidates: generation === currentGeneration ? session.candidates : [], senderDomain: senderDomain(settings, origin) };
  }
  busy = true; session.checkedAt = now;
  try {
    let accessToken = await token(), candidates;
    try { candidates = await findCodes(accessToken, senderDomain(settings, origin), session.since); }
    catch (error) {
      if (error.code !== 'RECONNECT') throw error;
      await invalidateToken(accessToken);
      accessToken = await token();
      candidates = await findCodes(accessToken, senderDomain(settings, origin), session.since);
    }
    await pageContext(sender); // Navigation, disconnect or permission removal can race the request.
    if (generation !== currentGeneration) return { candidates: [], senderDomain: senderDomain(settings, origin) };
    if (settings.needsReconnect) await chrome.storage.local.set({ needsReconnect: false });
    session.candidates = candidates.filter(x => !session.consumed.has(x.id) && x.expiresAt > Date.now() && unused(x));
    return { candidates: session.candidates, senderDomain: senderDomain(settings, origin) };
  } catch (error) {
    if (generation === currentGeneration && ['RECONNECT','GMAIL_ACCESS','AUTH_RESPONSE'].includes(error.code)) await chrome.storage.local.set({ needsReconnect: true });
    if (error.code === 'RATE_LIMIT') nextFetchAt = Date.now() + 60_000;
    throw error;
  } finally { busy = false; nextFetchAt = Math.max(nextFetchAt, Date.now() + 2_000); }
}
let consumption = Promise.resolve();
async function consume(message, sender) {
  const currentGeneration = generation;
  const { key, settings } = await pageContext(sender);
  const session = sessions.get(key), now = Date.now();
  const candidate = typeof message.id === 'string' && session?.candidates.find(c => c.id === message.id && c.expiresAt > now);
  if (!candidate) fail('INVALID');
  const saved = (await chrome.storage.session.get('usedCodes')).usedCodes ?? {};
  const usedCodes = Object.fromEntries(Object.entries(saved).filter(([, expiry]) => expiry > now).slice(-200));
  const usedKey = `${settings.email}|${candidate.id}`;
  if (usedCodes[usedKey]) fail('INVALID');
  session.consumed.add(candidate.id); session.candidates = session.candidates.filter(c => c.id !== candidate.id);
  usedCodes[usedKey] = candidate.expiresAt;
  await chrome.storage.session.set({ usedCodes });
  await pageContext(sender);
  if (generation !== currentGeneration) fail('INVALID');
  return { candidate };
}
async function dispatch(message, sender) {
  if (!message || typeof message.type !== 'string') fail('INVALID');
  if (message.type === 'POLL') return poll(sender);
  if (message.type === 'CONSUME') {
    consumption = consumption.catch(() => {}).then(() => consume(message, sender));
    return consumption;
  }
  if (!uiSender(sender)) fail('INVALID');
  if (message.type === 'STATUS') return { ...await config(), configured: configured(), extensionId: chrome.runtime.id };
  if (message.type === 'CONNECT') {
    if (authTask) return authTask;
    const currentGeneration = ++generation; sessions.clear(); clearCodeCache();
    authTask = (async () => {
      const accessToken = await token(true);
      const profile = await gmailRequest(accessToken, 'profile');
      if (currentGeneration !== generation) { await invalidateToken(accessToken); fail('INVALID'); }
      await chrome.storage.local.set({ connected: true, needsReconnect: false, email: profile.emailAddress });
      return { email: profile.emailAddress };
    })();
    try { return await authTask; } finally { authTask = undefined; }
  }
  if (message.type === 'DISCONNECT') {
    ++generation; sessions.clear(); clearCodeCache();
    await chrome.storage.local.set({ connected: false, needsReconnect: false, email: '' });
    const accessToken = await cachedToken();
    await disconnectAuth();
    let revoked = false;
    if (accessToken) {
      try {
        const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: accessToken }), credentials: 'omit', signal: AbortSignal.timeout(10_000) });
        revoked = response.ok;
      } catch { /* Local disconnect still completed. */ }
    }
    return { revoked };
  }
  if (message.type === 'SET_SITE' || message.type === 'SET_SENDER') {
    siteChanges = siteChanges.catch(() => {}).then(async () => {
      const origin = httpsOrigin(message.origin);
      if (!origin || origin !== message.origin || (!validDomain(new URL(origin).hostname) && !defaultSender(origin))) fail('INVALID');
      const settings = await config();
      if (message.type === 'SET_SITE') {
        if (typeof message.enabled !== 'boolean') fail('INVALID');
        if (message.enabled) delete settings.disabledSites[origin];
        else settings.disabledSites[origin] = true;
      } else {
        const domain = message.senderDomain?.trim().toLowerCase();
        if (typeof domain !== 'string' || (domain && !validDomain(domain))) fail('INVALID');
        if (!domain || domain === defaultSender(origin)) delete settings.sites[origin];
        else settings.sites[origin] = { senderDomain: domain };
      }
      ++generation; sessions.clear(); clearCodeCache();
      await chrome.storage.local.set({ sites: settings.sites, disabledSites: settings.disabledSites });
      await registerSites();
      // Existing documents retain their content scripts. Notify them immediately,
      // including background tabs, so disabled origins lose visible suggestions.
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) if (tab.id && httpsOrigin(tab.url) === origin) {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'SITE_CHANGED', enabled: !settings.disabledSites[origin] }, { frameId: 0 }); } catch {}
        if (!settings.disabledSites[origin]) {
          try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch {}
        }
      }
      return {};
    });
    return siteChanges;
  }
  fail('INVALID');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  dispatch(message, sender).then(data => reply({ ok: true, ...data })).catch(error => reply({ ok: false, code: error.code ?? 'INTERNAL', error: messages[error.code] ?? messages.INTERNAL }));
  return true;
});
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.runtime.onInstalled.addListener(() => { registerSites().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { registerSites().catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { registerSites().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { ++generation; sessions.clear(); clearCodeCache(); registerSites().catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { for (const key of sessions.keys()) if (key.startsWith(`${tabId}:`)) sessions.delete(key); });
