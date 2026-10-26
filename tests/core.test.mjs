import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateFromMessage, extractCode, defaultSender, domainMatches, httpsOrigin, senderOf, messageText } from '../src/core.js';
import { findCodes, gmailRequest } from '../src/gmail.js';
const now = 1_800_000_000_000;
const body = text => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } });
function message(overrides = {}) {
  return { id: 'mail-1', internalDate: String(now - 30_000), labelIds: ['INBOX'], payload: { ...body('Your verification code is: 482913. Expires in 5 minutes.'), headers: [
    { name: 'From', value: 'Example <security@login.example.com>' },
    { name: 'Subject', value: 'Your sign-in code' },
    { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass; dmarc=pass (p=REJECT) header.from=login.example.com' },
  ] }, ...overrides };
}
test('extracts numeric, alphanumeric, reverse and grouped codes', () => {
  for (const [text, expected] of [['Your verification code is: 482913.', '482913'], ['OTP: AB12CD', 'AB12CD'], ['123456 is your login code', '123456'], ['Verification code: 123 456', '123456'], ['Security code: 123-456', '123456']]) assert.equal(extractCode(text), expected, text);
});
test('rejects unrelated numbers, words, ambiguous codes and short/long tokens', () => {
  for (const value of ['Order 123456 ships tomorrow', 'Your verification code is pending', 'Code: 123456. Backup code: 654321', 'Code: 123', 'Code: 12345678901', 'Code: password']) assert.equal(extractCode(value), null, value);
});
test('private suffixes and boundary-safe domain matching', () => {
  assert.equal(defaultSender('https://login.example.co.uk'), 'example.co.uk');
  assert.equal(defaultSender('https://tenant.github.io'), 'tenant.github.io');
  assert.equal(defaultSender('https://accounts.google.com'), 'google.com');
  assert.equal(domainMatches('mail.example.com','example.com'), true);
  for (const d of ['evil-example.com','example.com.evil.org']) assert.equal(domainMatches(d,'example.com'), false);
});
test('restricts supported origins to normal HTTPS', () => {
  assert.equal(httpsOrigin('https://example.com/a'), 'https://example.com');
  for (const url of ['http://example.com','file:///tmp/test','https://user:pw@example.com','https://example.com:444','garbage']) assert.equal(httpsOrigin(url), null);
});
test('mailbox parser ignores a forged display-name domain', () => {
  assert.equal(senderOf([{ name:'From',value:'security@example.com <attacker@evil.org>' }]).domain, 'evil.org');
  assert.equal(senderOf([{ name:'From',value:'a@example.com, b@example.com' }]), null);
});
test('authenticated matching email yields a short-lived candidate only', () => {
  assert.deepEqual(candidateFromMessage(message(), 'example.com', now), {id:'mail-1',code:'482913',sender:'security@login.example.com',receivedAt:now-30_000,expiresAt:now+270_000});
});
test('rejects stale, future, spam, sent, drafts and foreign-sender emails', () => {
  for (const update of [{ internalDate: String(now-301_000) },{ internalDate:'NaN' },{internalDate:String(now+20_000)},{labelIds:['SPAM']},{labelIds:['SENT']},{labelIds:['DRAFT']},{labelIds:['TRASH']}]) assert.equal(candidateFromMessage(message(update),'example.com',now),null);
  assert.equal(candidateFromMessage(message(),'evil.org',now),null);
});
test('does not trust unauthenticated or misaligned email', () => {
  for (const value of ['mx.google.com; dmarc=fail header.from=login.example.com','evil.org; dmarc=pass header.from=login.example.com','mx.google.com; dmarc=pass header.from=evil.org','mx.google.com; spf=pass']) {
    const item = message(); item.payload.headers[2].value = value;
    assert.equal(candidateFromMessage(item,'example.com',now),null);
  }
});
test('MIME parsing prefers plain text and excludes attachments', () => {
  const payload = { mimeType:'multipart/mixed', parts:[body('Code: 123456'),{...body('Code: 654321'),filename:'attachment.txt'},{mimeType:'text/html',body:{data:Buffer.from('<p>Code: 999999</p>').toString('base64url')}}] };
  assert.equal(messageText(payload),'Code: 123456');
});
test('HTML-only email strips active content and decodes entities', () => {
  const payload={mimeType:'text/html',body:{data:Buffer.from('<script>Code: 999999</script><p>Verification code: <b>&#52;82913</b></p>').toString('base64url')}};
  assert.equal(extractCode(messageText(payload)),'482913');
});
test('Gmail reader filters metadata before fetching unrelated bodies', async () => {
  const calls=[];
  const fetcher=async (url, init)=>{
    calls.push(url); assert.equal(init.headers.Authorization,'Bearer fixture-token'); assert.equal(init.credentials,'omit');
    if(url.includes('messages?')) return {ok:true,json:async()=>({messages:[{id:'unrelated'},{id:'match'}]})};
    const data=message();
    if(url.includes('unrelated')) data.payload.headers[0].value='evil@evil.org';
    return {ok:true,json:async()=>data};
  };
  const codes=await findCodes('fixture-token','example.com',now-120_000,fetcher,now);
  assert.equal(codes[0].code,'482913');
  assert.equal(calls.some(url=>url.includes('unrelated?format=full')),false);
  assert.equal(calls.length,4);
});
test('Gmail errors are sanitized without returning response bodies or tokens', async () => {
  for (const [status, code] of [[401,'RECONNECT'],[403,'GMAIL_ACCESS'],[429,'RATE_LIMIT'],[500,'NETWORK']]) await assert.rejects(gmailRequest('private-token','profile',async()=>({ok:false,status})), {message:code});
});
test('rejects forged DMARC statements inside comments and quotes', () => {
  for (const header of [
    'mx.google.com; spf=pass (google.com: domain of "x dmarc=pass header.from=login.example.com"@evil.com designates host) smtp.mailfrom=evil.com; dmarc=fail (p=NONE) header.from=login.example.com',
    'mx.google.com; spf=pass (nested (comment dmarc=pass header.from=login.example.com)); dmarc=fail header.from=login.example.com',
    'mx.google.com; spf=pass smtp.mailfrom="x; dmarc=pass header.from=login.example.com"; dmarc=fail header.from=login.example.com',
    'mx.google.com; dmarc=pass header.from=login.example.com; dmarc=fail header.from=login.example.com',
  ]) { const item=message();item.payload.headers[2].value=header;assert.equal(candidateFromMessage(item,'example.com',now),null); }
});
test('Gmail quota-related 403 responses back off rather than disconnect',async()=>{
 await assert.rejects(gmailRequest('fixture','messages',async()=>({ok:false,status:403,json:async()=>({error:{errors:[{reason:'userRateLimitExceeded'}]}})})),{code:'RATE_LIMIT'});
});
test('Gmail fetch failures are retryable network errors',async()=>{
 await assert.rejects(gmailRequest('fixture','messages',async()=>{throw new Error('offline');}),{code:'NETWORK'});
});

test('Cloudflare email domain is automatic only on the real Access host boundary',()=>{
 assert.equal(defaultSender('https://example-team.cloudflareaccess.com'),'notify.cloudflare.com');
 assert.equal(defaultSender('https://foo.cloudflareaccess.com.attacker.com'),'attacker.com');
 assert.equal(defaultSender('https://cloudflareaccess.com.attacker.com'),'attacker.com');
 assert.equal(defaultSender('https://tenant.github.io'),'tenant.github.io');
});

test('shared-content hosts never inherit their platform email domain automatically',()=>{
 for(const host of ['docs.google.com','sites.google.com','script.google.com','forms.office.com','tenant.squarespace.com','tenant.wordpress.com','tenant.weebly.com','tenant.typeform.com','tenant.glitch.me']) assert.equal(defaultSender(`https://${host}`),null,host);
 assert.equal(defaultSender('https://accounts.google.com'),'google.com');
 assert.equal(defaultSender('https://docs.google.com.attacker.net'),'attacker.net');
 assert.equal(defaultSender('https://tenant.squarespace.com.attacker.net'),'attacker.net');
});

test('recognizes branded authentication subjects with the code first',()=>{
 for(const subject of ['482913 - Your Spotify login code','482913 – Your Spotify login code','482913 — Your Example Service sign-in code','AB12CD: Your Example authentication code']) assert.equal(extractCode(subject),subject.startsWith('AB12CD')?'AB12CD':'482913',subject);
});
test('prefixed subjects still reject promotional, unrelated and ambiguous numbers',()=>{
 for(const text of ['482913 - Your Spotify promo code','482913 - Your Example coupon code','Order 482913 - Your Spotify login code','482913 - Your Spotify login code. Backup code: 654321','482913 - Your Spotify code','12345678901 - Your Spotify login code']) assert.equal(extractCode(text),null,text);
});
test('Spotify-style subject survives authenticated Gmail/MIME processing',()=>{
 const item=message();item.payload={mimeType:'text/html',headers:[{name:'From',value:'Spotify <no-reply@accounts.spotify.com>'},{name:'Subject',value:'482913 - Your Spotify login code'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=accounts.spotify.com'}],body:{data:Buffer.from('<p>Hi,</p><p>Enter this code to continue logging in without a password.</p><strong>482913</strong>').toString('base64url')}};
 assert.equal(candidateFromMessage(item,'spotify.com',now)?.code,'482913');
 assert.equal(candidateFromMessage(item,'example.com',now),null);
 item.payload.headers[2].value='mx.google.com; dmarc=fail header.from=accounts.spotify.com';assert.equal(candidateFromMessage(item,'spotify.com',now),null);
});
