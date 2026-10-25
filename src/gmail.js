import { candidateFromMessage, MAX_AGE_MS, senderOf, domainMatches, authenticatedSender } from './core.js';
const codeCache = new Map();
let cacheEpoch = 0;
export function clearCodeCache() { ++cacheEpoch; codeCache.clear(); }
export class GmailError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export async function gmailRequest(token, path, fetcher = fetch) {
  let response;
  try { response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit',
    signal: AbortSignal.timeout(12_000),
  }); } catch { throw new GmailError('NETWORK'); }
  if (!response.ok) {
    let limited = response.status === 429;
    if (response.status === 403) {
      try { limited = (await response.json()).error?.errors?.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason)); } catch {}
    }
    throw new GmailError(limited ? 'RATE_LIMIT' : response.status === 401 ? 'RECONNECT' : response.status === 403 ? 'GMAIL_ACCESS' : 'NETWORK');
  }
  return response.json();
}
export async function findCodes(token, senderDomain, since, fetcher = fetch, now = Date.now()) {
  const epoch = cacheEpoch;
  const after = Math.floor(Math.max(since, now - MAX_AGE_MS) / 1000);
  const q = `after:${after} -in:spam -in:trash -in:sent -in:drafts {subject:code subject:verification subject:OTP subject:passcode subject:login subject:sign-in subject:security subject:password subject:authentication subject:one-time}`;
  const query = new URLSearchParams({ q, maxResults: '10' });
  const list = await gmailRequest(token, `messages?${query}`, fetcher);
  const candidates = [];
  for (const item of (list.messages ?? []).slice(0, 10)) {
    // Fetch metadata first; do not download bodies from unrelated senders.
    const metadata = await gmailRequest(token, `messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Authentication-Results`, fetcher);
    const sender = senderOf(metadata.payload?.headers);
    if (!sender || !domainMatches(sender.domain, senderDomain) || !authenticatedSender(metadata.payload.headers, sender.domain)) continue;
    const cacheKey = `${senderDomain}:${item.id}`;
    const cached = epoch === cacheEpoch ? codeCache.get(cacheKey) : null;
    if (cached?.expiresAt > now && cached.receivedAt >= since && !metadata.labelIds?.some(x => ['SPAM','TRASH','SENT','DRAFT'].includes(x))) { candidates.push(cached); continue; }
    const full = await gmailRequest(token, `messages/${encodeURIComponent(item.id)}?format=full`, fetcher);
    const candidate = candidateFromMessage(full, senderDomain, now, since);
    if (candidate) { candidates.push(candidate); if (epoch === cacheEpoch) codeCache.set(cacheKey, candidate); }
    if (codeCache.size > 100) codeCache.delete(codeCache.keys().next().value);
  }
  return candidates.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 3);
}
