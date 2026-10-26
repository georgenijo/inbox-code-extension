import { getDomain } from 'tldts';

export const MAX_AGE_MS = 5 * 60_000;
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.origin;
  } catch { return null; }
}
export function validDomain(value) {
  return typeof value === 'string' && value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) &&
    Boolean(getDomain(value, { allowPrivateDomains: true }));
}
// These services host other people's content under their own mail domain.
// PSL tenant isolation alone is insufficient here. Require an explicit sender
// override before offering platform-account codes on a shared-content host.
const sharedContentHosts = ['docs.google.com', 'sites.google.com', 'script.google.com', 'forms.office.com'];
const sharedContentSuffixes = ['squarespace.com', 'wordpress.com', 'weebly.com', 'typeform.com', 'glitch.me'];
export function defaultSender(origin) {
  const safe = httpsOrigin(origin);
  if (!safe) return null;
  const hostname = new URL(safe).hostname;
  if (sharedContentHosts.some(host => hostname === host || hostname.endsWith(`.${host}`)) ||
      sharedContentSuffixes.some(host => hostname.endsWith(`.${host}`))) return null;
  // Cloudflare Access uses a dedicated email sender on a different domain.
  if (hostname.endsWith('.cloudflareaccess.com')) return 'notify.cloudflare.com';
  return getDomain(hostname, { allowPrivateDomains: true });
}
export function domainMatches(actual, expected) {
  return validDomain(actual) && validDomain(expected) && (actual === expected || actual.endsWith(`.${expected}`));
}
export function senderOf(headers = []) {
  const from = headers.filter(h => h.name.toLowerCase() === 'from');
  if (from.length !== 1) return null;
  const raw = from[0].value;
  // A single mailbox only. Ignore display names when an angle address exists.
  const address = raw.includes('<') ? raw.match(/<([^<>]+)>\s*$/)?.[1] : raw.trim();
  if (!address || !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(address)) return null;
  const domain = address.split('@')[1].toLowerCase();
  return validDomain(domain) ? { address, domain } : null;
}
export function authenticatedSender(headers, domain) {
  const result = headers.find(h => h.name.toLowerCase() === 'authentication-results' && /^mx\.google\.com\s*;/i.test(h.value));
  if (!result) return false;
  // Remove RFC comments and quoted strings before interpreting methods/properties.
  // Semicolons inside attacker-controlled quoted mailbox names are not separators.
  let clean = '', depth = 0, quoted = false, escaped = false;
  for (const char of result.value) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (depth) { if (char === '(') depth++; if (char === ')') depth--; continue; }
    if (char === '"') { quoted = !quoted; clean += ' '; continue; }
    if (quoted) continue;
    if (char === '(') { depth++; clean += ' '; continue; }
    clean += char;
  }
  if (depth || quoted || escaped) return false;
  const dmarc = clean.split(';').map(x => x.trim()).filter(x => /^dmarc\s*=/i.test(x));
  if (dmarc.length !== 1) return false;
  const match = dmarc[0].match(/^dmarc=pass\b[^;]*\bheader\.from=([a-z0-9.-]+)(?:\s|$)/i);
  return Boolean(match && match[1].toLowerCase() === domain);
}
function decode(data) {
  if (typeof data !== 'string' || data.length > 180_000) return '';
  try { return new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))); }
  catch { return ''; }
}
function htmlText(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    }).replace(/&nbsp;/gi, ' ').replace(/&(?:lt|gt|amp|quot|apos);/gi, ' ');
}
export function messageText(payload) {
  const plain = [], html = [];
  function visit(part, depth = 0) {
    if (!part || depth > 12 || part.filename) return;
    if (part.mimeType === 'text/plain') plain.push(decode(part.body?.data));
    if (part.mimeType === 'text/html') html.push(htmlText(decode(part.body?.data)));
    for (const child of (part.parts ?? []).slice(0, 30)) visit(child, depth + 1);
  }
  visit(payload);
  return (plain.some(t => t.trim()) ? plain : html).join('\n').slice(0, 100_000);
}
export function extractCode(text) {
  // Require explicit code language next to a bounded token. Never grab arbitrary numbers.
  const value = text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ');
  const token = '([0-9]{3}[ -][0-9]{3}|[A-Z0-9]{4,10})';
  const authLabel = '(?:(?:verification|security|authentication|confirmation|login|sign[ -]?in|one[ -]?time|access) (?:code|password|passcode)|OTP|passcode)';
  const label = `(?:${authLabel}|code)`;
  const patterns = [new RegExp(`\\b${label}\\b(?: is(?: below)?|:| =| reads)?[ :\\-]*${token}\\b`, 'gi'),
    new RegExp(`\\b${token}[ :\\-]+is your ${label}\\b`, 'gi'),
    // Subject-first codes, e.g. "482913 - Your Spotify login code".
    // Anchor at the start and require authentication language, not a bare code.
    new RegExp(`^${token}\\b[ :\\-–—|]+your (?:[A-Z][A-Z0-9&.'-]{0,31} ){0,4}${authLabel}\\b`, 'gi')];
  const found = new Set();
  for (const pattern of patterns) for (const match of value.matchAll(pattern)) {
    if (/\b(?:zip|postal|promo|coupon|discount) $/i.test(value.slice(Math.max(0, match.index - 16), match.index))) continue;
    const raw = match[1];
    // Strip only numeric grouping, not arbitrary words following a code.
    let code = raw.split(' ')[0];
    if (/^[0-9]{3}[ -][0-9]{3}$/.test(raw)) code = raw.replace(/[ -]/g, '');
    if (/^\d{4,8}$/.test(code) || (/^[A-Z0-9]{6,10}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code))) found.add(code);
  }
  return found.size === 1 ? [...found][0] : null;
}
export function candidateFromMessage(message, senderDomain, now, since = now - MAX_AGE_MS) {
  const receivedAt = Number(message.internalDate);
  if (!Number.isFinite(receivedAt) || receivedAt < Math.max(since, now - MAX_AGE_MS) || receivedAt > now + 10_000) return null;
  if (message.labelIds?.some(x => x === 'SPAM' || x === 'TRASH' || x === 'SENT' || x === 'DRAFT')) return null;
  const headers = message.payload?.headers ?? [];
  const sender = senderOf(headers);
  if (!sender || !domainMatches(sender.domain, senderDomain) || !authenticatedSender(headers, sender.domain)) return null;
  const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? '';
  const code = extractCode(`${subject}\n${messageText(message.payload)}`);
  return code ? { id: message.id, code, sender: sender.address, receivedAt, expiresAt: receivedAt + MAX_AGE_MS } : null;
}
