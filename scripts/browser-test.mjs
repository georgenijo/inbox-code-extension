// Isolated-browser integration tests. No user profile or real Gmail data is used.
import { chromium } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const temp = await mkdtemp(path.join(tmpdir(),'inbox-code-test-'));
await mkdir('artifacts',{recursive:true});
await cp('dist',path.join(temp,'extension'),{recursive:true});
const manifest=JSON.parse(await readFile(path.join(temp,'extension/manifest.json'),'utf8'));
assert.ok(manifest.host_permissions.includes('https://*/*'),'Production manifest grants HTTPS by default');
manifest.oauth2={client_id:'123456-fixture.apps.googleusercontent.com',scopes:['https://www.googleapis.com/auth/gmail.readonly']};
// No static content script: exercise production dynamic registration/injection.
await writeFile(path.join(temp,'extension/manifest.json'),JSON.stringify(manifest));
const brave='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const executablePath=process.env.BROWSER_PATH || (existsSync(brave)?brave:undefined);
const browserName=executablePath?.includes('Brave Browser')?'Brave':'Chromium';
const context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
  ...(executablePath?{executablePath}:{channel:'chromium'}),headless:true,
  args:[`--disable-extensions-except=${path.join(temp,'extension')}`,`--load-extension=${path.join(temp,'extension')}`],
  viewport:{width:1000,height:760}, recordVideo:{dir:'artifacts/video',size:{width:1000,height:760}},
});
let passed=0;
try {
 const expectedId=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const worker=context.serviceWorkers().find(w=>w.url().includes(expectedId))??await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes(expectedId),timeout:20000});
 console.log('Testing extension worker',worker.url());
 const id=new URL(worker.url()).host;
 await worker.evaluate(async()=>{
  await chrome.storage.local.set({connected:true,email:'fixture@example.net',sites:{},disabledSites:{}});
  chrome.identity.launchWebAuthFlow=async({url})=>{const u=new URL(url);return chrome.identity.getRedirectURL()+'#'+new URLSearchParams({state:u.searchParams.get('state'),access_token:'fixture-only',expires_in:'3600',token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.readonly'});};
  chrome.identity.getAuthToken=async()=>({token:'fixture-only',grantedScopes:['https://www.googleapis.com/auth/gmail.readonly']});
  globalThis.fixtureMessageId='fixture-message';globalThis.fixtureSender='example.test';globalThis.fixtureFetches=0;
  globalThis.fetch=async url=>{
   globalThis.fixtureFetches++;const u=new URL(url); let data;
   if(u.pathname.endsWith('/messages')) data={messages:[{id:globalThis.fixtureMessageId}]};
   else if(u.pathname.includes('/messages/')) data={id:globalThis.fixtureMessageId,internalDate:String(Date.now()),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:`Security <security@${globalThis.fixtureSender}>`},{name:'Subject',value:'Your verification code'},{name:'Authentication-Results',value:`mx.google.com; dmarc=pass header.from=${globalThis.fixtureSender}`}],body:{data:btoa('Your verification code is: 482913.')}}};
   else if(u.pathname.endsWith('/profile')) data={emailAddress:'fixture@example.net'};
   else throw new Error('Unexpected fixture request');
   return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
 });
 await context.route(/^https:\/\/(?:example\.test(?::8443)?|other\.test|tenant\.wordpress\.com|example-team\.cloudflareaccess\.com)\//,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><title>Inbox Code integration fixture</title><style>body{background:#edf1ec;font:16px system-ui;color:#20362c;padding:80px}main{background:white;padding:44px;border-radius:20px;width:400px;margin:auto}h1{font-size:26px}input{padding:12px;font:24px system-ui;max-width:260px;border:1px solid #829687;border-radius:8px}fieldset{border:0;padding:0;display:flex;gap:6px}fieldset input{width:22px;padding:10px 8px}p{line-height:1.5;color:#58665b}label{display:block;margin:18px 0 8px}</style></head><body><main><small>INTEGRATION TEST · FIXTURE EMAIL</small><h1>Check your email</h1><p>Enter your verification code to continue.</p><form><label for="code">Verification code</label>${route.request().url().includes('/split')?'<fieldset aria-label="Verification code">'+Array.from({length:6},(_,i)=>`<input aria-label="Code digit ${i+1}" maxlength="1" inputmode="numeric" ${i===0?'autocomplete="one-time-code"':''}>`).join('')+'</fieldset>':'<input id="code" autocomplete="one-time-code" maxlength="6"><label for="coupon">Coupon</label><input id="coupon" maxlength="6">'}<button style="display:block;margin-top:24px" type="submit">Verify</button></form><p id="result"></p><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='Submitted'};</script></main></body></html>`}));
 const page=await context.newPage();
 page.on('pageerror',error=>console.log('Page error:',error.message));
 page.on('console',msg=>{if(msg.type()==='error') console.log('Browser error:',msg.text());});
 const cdp=await context.newCDPSession(page);
 async function navigate(route) { await worker.evaluate(()=>{globalThis.fixtureMessageId=crypto.randomUUID();});await page.goto(`https://example.test/${route}`); }
 async function suggestionNode() {
  const deadline=Date.now()+16000;
  while(Date.now()<deadline){
   const {nodes}=await cdp.send('Accessibility.getFullAXTree');
   const button=nodes.find(n=>n.role?.value==='button'&&n.name?.value.includes('482913'));
   if(button) return button;
   await page.waitForTimeout(100);
  }
  throw new Error('No accessible code suggestion appeared');
 }
 async function clickSuggestion({delay=700,keyboard=false}={}) {
  const button=await suggestionNode();await page.waitForTimeout(delay);
  if(keyboard){const {object}=await cdp.send('DOM.resolveNode',{backendNodeId:button.backendDOMNodeId});await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){this.focus()}'});await page.keyboard.press('Enter');return;}
  const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:button.backendDOMNodeId});const q=model.content;await page.mouse.click((q[0]+q[4])/2,(q[1]+q[5])/2);
 }
 await navigate('login');
 assert.equal(await page.locator('inbox-code-suggestion').count(),0);passed++;
 // Production registration covers previously unseen HTTPS sites with no per-site setup.
 await page.locator('#code').focus();await page.waitForFunction(()=>Boolean(document.querySelector('inbox-code-suggestion')));
 const registered=await worker.evaluate(()=>chrome.scripting.getRegisteredContentScripts());
 assert.ok(registered.some(script=>script.matches.includes('https://*/*')));passed++;
 const localAccess=await worker.evaluate(async()=>{
   const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
   return chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{try {await chrome.storage.local.get('email');return 'readable';}catch{return 'denied';}}});
 });
 assert.equal(localAccess[0].result,'denied');passed++;
 await page.locator('#code').focus();
 await page.waitForFunction(()=>Boolean(document.querySelector('inbox-code-suggestion')),{},{timeout:10000}).catch(async error=>{await page.screenshot({path:'artifacts/browser-failure.png'});console.log(await page.locator('body').innerText());throw error;});
 await page.waitForTimeout(500);
 assert.equal(await page.locator('#code').inputValue(),'');passed++;
 assert.equal(await page.evaluate(()=>document.querySelector('inbox-code-suggestion').shadowRoot),null);passed++;
 const inputBox=await page.locator('#code').boundingBox(),suggestionBox=await page.locator('inbox-code-suggestion').boundingBox();
 assert.ok(Math.abs(suggestionBox.x-inputBox.x)<10 && Math.abs(suggestionBox.y-(inputBox.y+inputBox.height+8))<10,'Suggestion must be beside the input');passed++;
 await page.screenshot({path:`artifacts/suggestion-${browserName.toLowerCase()}.png`});
 await clickSuggestion();await page.waitForFunction(()=>document.querySelector('#code').value==='482913');passed++;
 assert.equal(await page.locator('#result').textContent(),'');passed++;
 await page.locator('#coupon').focus();assert.equal(await page.locator('inbox-code-suggestion').count(),0);passed++;
 await navigate('split');await page.locator('input').first().focus();await clickSuggestion();
 assert.equal((await page.locator('input').evaluateAll(inputs=>inputs.map(i=>i.value))).join(''),'482913');passed++;
 assert.equal(await page.locator('#result').textContent(),'');passed++;
 await page.screenshot({path:`artifacts/filled-split-${browserName.toLowerCase()}.png`});
 // Existing typed digits must never be replaced.
 await navigate('login');await page.locator('#code').fill('777');
 assert.equal(await page.locator('inbox-code-suggestion').count(),0);passed++;
 // Suggestions moved by page script, hidden or visually covered cannot be clicked to fill.
 for (const attack of ['moved','transparent','covered']) {
  await navigate('login');await page.locator('#code').focus();
  await page.waitForFunction(()=>Boolean(document.querySelector('inbox-code-suggestion')));
  const codeButton=await suggestionNode();await page.waitForTimeout(800);
  await page.evaluate(attack=>{
   const host=document.querySelector('inbox-code-suggestion');
   if(attack==='moved') host.style.setProperty('left','50px','important');
   if(attack==='transparent') document.documentElement.style.opacity='0';
   if(attack==='covered'){const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;background:white;z-index:2147483647;pointer-events:none';document.documentElement.append(overlay);}
  },attack);
  await page.waitForTimeout(250);
  const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:codeButton.backendDOMNodeId});const quad=model.content;
  await page.mouse.click((quad[0]+quad[4])/2,(quad[1]+quad[5])/2);await page.waitForTimeout(200);
  assert.equal(await page.locator('#code').inputValue(),'');passed++;
 }
 await navigate('login');await page.locator('#code').focus();await clickSuggestion({delay:0});await page.waitForTimeout(200);
 assert.equal(await page.locator('#code').inputValue(),'');passed++;
 await clickSuggestion({keyboard:true});await page.waitForFunction(()=>document.querySelector('#code').value==='482913');passed++;
 await navigate('login');await page.evaluate(()=>{const input=document.querySelector('#code');input.removeAttribute('autocomplete');input.id='email-verification-code';});
 await page.locator('#email-verification-code').focus();await clickSuggestion();await page.waitForFunction(()=>document.querySelector('#email-verification-code').value==='482913');assert.equal(await page.locator('#email-verification-code').inputValue(),'482913');passed++;
 await navigate('login');await page.evaluate(()=>{const input=document.querySelector('#code');input.removeAttribute('autocomplete');input.removeAttribute('maxlength');input.placeholder='000000';input.name='code';document.querySelector('label').textContent='Code';document.querySelector('h1').textContent='Enter your code';});
 await page.locator('#code').focus();await clickSuggestion();await page.waitForFunction(()=>document.querySelector('#code').value==='482913');passed++;
 await navigate('login');await page.locator('#code').fill('777');
 for (const field of ['phone','promotion']) {
  await navigate('login');await page.evaluate(field=>{const input=document.querySelector('#code');input.removeAttribute('autocomplete');input.id=field;input.name=field;document.querySelector('label').textContent=field==='phone'?'Phone number for verification':'Promo code';document.querySelector('label').htmlFor=field;},field);
  await page.locator(`#${field}`).focus();await page.waitForTimeout(200);assert.equal(await page.locator('inbox-code-suggestion').count(),0);passed++;
 }
 await navigate('login');await page.locator('#code').fill('777');
 const popup=await context.newPage();await popup.addInitScript(()=>{chrome.tabs.query=async()=>[{id:1,url:'https://example.test/login',active:true}];});await popup.goto(`chrome-extension://${id}/popup.html`);
 await popup.getByText('fixture@example.net',{exact:true}).waitFor();passed++;
 await worker.evaluate(()=>chrome.storage.local.set({needsReconnect:true}));await popup.reload();await popup.getByRole('button',{name:'Reconnect with Google'}).waitFor();passed++;
 await worker.evaluate(()=>chrome.storage.local.set({needsReconnect:false}));await popup.reload();await popup.getByRole('button',{name:'Reconnect with Google'}).waitFor({state:'hidden'});
 assert.equal(await popup.locator('body').evaluate(el=>el.getBoundingClientRect().width),300);assert.ok(await popup.locator('body').evaluate(el=>el.getBoundingClientRect().height)<310);passed++;
 await popup.locator('body').screenshot({path:`artifacts/popup-${browserName.toLowerCase()}.png`});
 // Opt-out immediately clears an already-visible suggestion; new documents remain off.
 await page.bringToFront();await page.locator('#code').fill('');await page.locator('#code').focus();await suggestionNode();
 await popup.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SITE',origin:'https://example.test',enabled:false}));
 await page.waitForFunction(()=>!document.querySelector('inbox-code-suggestion'));passed++;
 const fetches=await worker.evaluate(()=>globalThis.fixtureFetches);
 await navigate('login');await page.locator('#code').focus();await page.waitForTimeout(600);
 assert.equal(await page.locator('inbox-code-suggestion').count(),0);assert.equal(await worker.evaluate(()=>globalThis.fixtureFetches),fetches);passed++;
 await popup.reload();await popup.getByRole('switch').waitFor();assert.equal(await popup.getByRole('switch').getAttribute('aria-checked'),'false');passed++;
 await popup.getByRole('switch').click();await page.bringToFront();await page.locator('#code').focus();await suggestionNode();passed++;
 // Another website must not see example.test's email code.
 await page.goto('https://other.test/login');await page.locator('#code').focus();
 await page.waitForFunction(()=>Boolean(document.querySelector('inbox-code-suggestion')));await page.waitForTimeout(200);
 const otherAX=await cdp.send('Accessibility.getFullAXTree');assert.ok(!otherAX.nodes.some(n=>n.role?.value==='button'&&n.name?.value.includes('482913')));passed++;
 // Cloudflare works on a fresh site without any stored sender/site entry.
 await worker.evaluate(()=>{globalThis.fixtureSender='notify.cloudflare.com';globalThis.fixtureMessageId=crypto.randomUUID();});
 await page.goto('https://example-team.cloudflareaccess.com/login');
 await page.evaluate(()=>{const input=document.querySelector('#code');input.removeAttribute('autocomplete');input.removeAttribute('maxlength');input.name='code';document.querySelector('label').textContent='Code';document.querySelector('h1').textContent='Enter your code';});
 await page.locator('#code').focus();await clickSuggestion();await page.waitForFunction(()=>document.querySelector('#code').value==='482913');passed++;
 await worker.evaluate(()=>{globalThis.fixtureSender='example.test';globalThis.fixtureMessageId=crypto.randomUUID();});
 const beforeRejected=await worker.evaluate(()=>globalThis.fixtureFetches);
 for(const url of ['https://example.test:8443/login','https://tenant.wordpress.com/login']) {
  await page.goto(url);await page.locator('#code').focus();await page.waitForTimeout(500);
  assert.equal(await page.locator('inbox-code-suggestion').count(),0);assert.equal(await worker.evaluate(()=>globalThis.fixtureFetches),beforeRejected);passed++;
 }
 await popup.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SENDER',origin:'https://tenant.wordpress.com',senderDomain:'example.test'}));
 await page.locator('#code').focus();await clickSuggestion();await page.waitForFunction(()=>document.querySelector('#code').value==='482913');passed++;
 await navigate('login');
 // Connection controls stay usable after repeated actions and refreshes.
 await popup.getByRole('button',{name:'Disconnect',exact:true}).click();await popup.getByRole('button',{name:'Connect with Google',exact:true}).waitFor();
 await popup.getByRole('button',{name:'Connect with Google',exact:true}).click();await popup.getByText('fixture@example.net',{exact:true}).waitFor();
 assert.equal(await popup.getByRole('button',{name:'Disconnect',exact:true}).isEnabled(),true);passed++;
 const idnPopup=await context.newPage();await idnPopup.addInitScript(()=>{chrome.tabs.query=async()=>[{id:1,url:'https://xn--e1afmkfd.xn--p1ai/login',active:true}];});await idnPopup.goto(`chrome-extension://${id}/popup.html`);
 await idnPopup.getByRole('switch').click();await idnPopup.waitForFunction(()=>document.querySelector('#site-toggle').getAttribute('aria-checked')==='false');
 assert.equal(await worker.evaluate(async()=>Boolean((await chrome.storage.local.get('disabledSites')).disabledSites['https://xn--e1afmkfd.xn--p1ai'])),true);passed++;await idnPopup.close();
 const withheldPopup=await context.newPage();await withheldPopup.addInitScript(()=>{chrome.tabs.query=async()=>[{id:1,url:'https://example.test/login',active:true}];chrome.permissions.contains=async()=>false;});await withheldPopup.goto(`chrome-extension://${id}/popup.html`);
 await withheldPopup.getByText('Allow site access in the browser extension menu',{exact:true}).waitFor();passed++;await withheldPopup.close();
 await popup.close();await page.bringToFront();

 await page.locator('#code').fill('');await page.locator('#code').focus();
 await page.waitForFunction(()=>Boolean(document.querySelector('inbox-code-suggestion')));
 // Removing authorization between retrieval and click must refuse the fill.
 await worker.evaluate(async()=>{await chrome.storage.local.set({connected:false});});
 // Suggestion may be removed by storage event; otherwise click must reject it.
 const {nodes}=await cdp.send('Accessibility.getFullAXTree');
 if(nodes.some(n=>n.role?.value==='button'&&n.name?.value.includes('482913'))) await clickSuggestion();
 assert.equal(await page.locator('#code').inputValue(),'');passed++;
 console.log(`PASS: ${passed} browser assertions in ${browserName}; real extension runtime, Gmail/identity fixtures. No live OAuth claim.`);
 await writeFile(`artifacts/browser-results-${browserName.toLowerCase()}.json`,JSON.stringify({passed,browser:browserName,gmail:'fixture',oauth:'fixture',extensionId:id},null,2));
} finally {await context.close();await rm(temp,{recursive:true,force:true});}
