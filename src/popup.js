import { defaultSender, httpsOrigin, validDomain } from './core.js';
const $ = id => document.getElementById(id);
let origin, settings;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result.ok) throw new Error(result.error);
  return result;
}
function status(text) { $('status').textContent = text; }
async function refresh() {
  settings = await send({ type: 'STATUS' });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  origin = httpsOrigin(tab?.url);
  const automatic = defaultSender(origin);
  const supported = Boolean(origin && (automatic || validDomain(new URL(origin).hostname)));
  const browserAllowed = origin && await chrome.permissions.contains({ origins: [`${origin}/*`] });
  const saved = settings.sites[origin]?.senderDomain;
  const override = saved && !(automatic === 'notify.cloudflare.com' && ['cloudflareaccess.com', 'cloudflare.com'].includes(saved)) && saved !== automatic;
  const matched = override ? saved : automatic;
  $('account').textContent = settings.connected ? settings.email : 'Connect Gmail for email codes';
  $('account').title = settings.connected ? settings.email : 'Connect Gmail for email codes';
  $('connection-state').textContent = settings.needsReconnect ? 'Reconnect' : settings.connected ? 'Connected' : 'Gmail';
  $('connect').hidden = settings.connected && !settings.needsReconnect;
  $('connect').textContent = settings.needsReconnect ? 'Reconnect with Google' : 'Connect with Google';
  $('connect').disabled = !settings.configured;
  $('disconnect').hidden = !settings.connected; $('setup').hidden = settings.configured;
  $('site').textContent = origin ? new URL(origin).hostname : 'Open an HTTPS login page';
  $('site').title = origin ? new URL(origin).hostname : '';
  const enabled = Boolean(origin && matched && !settings.disabledSites[origin]);
  $('site-toggle').disabled = !supported || !matched;
  $('site-toggle').setAttribute('aria-checked', String(enabled));
  $('site-copy').textContent = supported ? matched ? enabled ? browserAllowed ? 'Suggestions on · click to fill' : 'Allow site access in the browser extension menu' : 'Suggestions off on this site' : 'Shared host · set a trusted sender to use' : 'On by default on HTTPS websites';
  $('sender').value = override ? saved : '';
  $('sender').placeholder = automatic ?? 'Automatic';
  $('sender').disabled = !supported; $('save-sender').disabled = !supported;
  $('reset-sender').hidden = !override;
  $('sender-summary').textContent = override ? saved : automatic ? 'Automatic' : 'Not available';
  $('sender-settings').hidden = !supported;
  const disabled = Object.keys(settings.disabledSites);
  $('disabled-settings').hidden = !disabled.length; $('count').textContent = disabled.length;
  $('sites').replaceChildren();
  for (const site of disabled) {
    const li = document.createElement('li'), name = document.createElement('span'), restore = document.createElement('button');
    name.textContent = new URL(site).hostname; restore.textContent = 'Turn on';
    restore.setAttribute('aria-label', `Turn on ${new URL(site).hostname}`);
    restore.onclick = () => run(restore, async () => { await send({ type: 'SET_SITE', origin: site, enabled: true }); await refresh(); });
    li.append(name, restore); $('sites').append(li);
  }
}
async function run(button, action) {
  button.disabled = true; status('');
  try { await action(); } catch (error) { status(error.message); }
  finally { button.disabled = false; await refresh().catch(error => status(error.message)); }
}
$('connect').onclick = () => run($('connect'), async () => {
  status('Opening Google sign-in…'); await send({ type: 'CONNECT' }); status('Connected. Focus a code field to get started.');
});
$('disconnect').onclick = () => run($('disconnect'), async () => {
  const result = await send({ type: 'DISCONNECT' });
  status(result.revoked ? 'Disconnected.' : 'Disconnected locally. You can also revoke access in your Google Account.');
});
$('site-toggle').onclick = () => run($('site-toggle'), () => send({ type: 'SET_SITE', origin, enabled: $('site-toggle').getAttribute('aria-checked') !== 'true' }));
$('sender-form').onsubmit = event => {
  event.preventDefault();
  const domain = $('sender').value.trim().toLowerCase();
  if (domain && !validDomain(domain)) { status('Enter an email domain, such as example.com.'); return; }
  run($('save-sender'), async () => { await send({ type: 'SET_SENDER', origin, senderDomain: domain }); status(domain ? `Checking mail from ${domain}.` : 'Automatic sender matching restored.'); });
};
$('reset-sender').onclick = () => run($('reset-sender'), () => send({ type: 'SET_SENDER', origin, senderDomain: '' }));
refresh().catch(error => status(error.message));
