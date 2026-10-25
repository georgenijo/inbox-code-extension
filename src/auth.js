import { GMAIL_SCOPE } from './core.js';
import oauth from '../oauth-client.json' with { type: 'json' };
let authEpoch = 0, pending, pendingInteractive = false;
const failure = code => Object.assign(new Error(code), { code });
export function parseOAuthResponse(value, redirect, state, now = Date.now()) {
  let url;
  try { url = new URL(value); } catch { throw failure('AUTH_RESPONSE'); }
  const expected = new URL(redirect), params = new URLSearchParams(url.hash.slice(1));
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.search || params.get('state') !== state) throw failure('AUTH_RESPONSE');
  if (params.has('error')) throw failure('RECONNECT');
  const accessToken = params.get('access_token'), seconds = Number(params.get('expires_in'));
  if (!accessToken || params.get('token_type')?.toLowerCase() !== 'bearer' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw failure('AUTH_RESPONSE');
  if (!(params.get('scope') ?? '').split(' ').includes(GMAIL_SCOPE)) throw failure('GMAIL_ACCESS');
  return { accessToken, expiresAt: now + seconds * 1000 };
}
export function authConfigured() { return Boolean(oauth.webClientId || chrome.runtime.getManifest().oauth2?.client_id); }
export async function invalidateToken(accessToken) {
  ++authEpoch;
  await chrome.storage.session.remove('oauth');
  if (accessToken) await chrome.identity.removeCachedAuthToken({ token: accessToken });
}
export async function disconnectAuth() {
  await invalidateToken();
  await chrome.identity.clearAllCachedAuthTokens();
}
export async function cachedToken() {
  return (await chrome.storage.session.get('oauth')).oauth?.accessToken;
}
export async function accessToken(interactive = false) {
  if (!authConfigured()) throw failure('UNCONFIGURED');
  const epoch = authEpoch;
  if (pending) {
    if (!interactive || pendingInteractive) return pending;
    try { await pending; } catch {}
    if (epoch !== authEpoch) throw failure('RECONNECT');
    return accessToken(true);
  }
  pendingInteractive = interactive;
  pending = (async () => {
    const cache = (await chrome.storage.session.get('oauth')).oauth;
    if (cache?.expiresAt > Date.now() + 60_000 && !interactive) return cache.accessToken;
    if (!oauth.webClientId) {
      try {
        const result = await chrome.identity.getAuthToken({ interactive, enableGranularPermissions: true, scopes: [GMAIL_SCOPE] });
        if (!result?.token) throw failure('RECONNECT');
        if (result.grantedScopes && !result.grantedScopes.includes(GMAIL_SCOPE)) throw failure('GMAIL_ACCESS');
        if (epoch !== authEpoch) { await chrome.identity.removeCachedAuthToken({ token: result.token }); throw failure('RECONNECT'); }
        await chrome.storage.session.set({ oauth: { accessToken: result.token, expiresAt: Date.now() + 50 * 60_000 } });
        return result.token;
      } catch (error) { throw failure(error.code ?? (interactive ? 'AUTH_CANCELLED' : 'RECONNECT')); }
    }
    const redirect = chrome.identity.getRedirectURL();
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    const settings = await chrome.storage.local.get('email');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: oauth.webClientId, redirect_uri: redirect, response_type: 'token', scope: GMAIL_SCOPE, include_granted_scopes: 'true', state, prompt: interactive ? 'select_account' : 'none', ...(!interactive && settings.email ? { login_hint: settings.email } : {}) });
    let response;
    try { response = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive, ...(!interactive ? { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 } : {}) }); }
    catch (error) {
      const description = String(error?.message ?? '');
      if (/network|offline|timed? ?out|timeout|could not be loaded|connection/i.test(description)) throw failure('NETWORK');
      if (!interactive && /not approve|interaction required|login.required/i.test(description)) throw failure('RECONNECT');
      throw failure(interactive ? 'AUTH_CANCELLED' : 'NETWORK');
    }
    const result = parseOAuthResponse(response, redirect, state);
    if (epoch !== authEpoch) throw failure('RECONNECT');
    await chrome.storage.session.set({ oauth: result });
    if (epoch !== authEpoch) { await chrome.storage.session.remove('oauth'); throw failure('RECONNECT'); }
    return result.accessToken;
  })();
  try { return await pending; } finally { pending = undefined; pendingInteractive = false; }
}
