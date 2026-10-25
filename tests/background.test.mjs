import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import { build } from 'esbuild';
const bundled = (await build({entryPoints:['src/background.js'],bundle:true,write:false,format:'iife',platform:'browser',plugins:[{name:'fixture-oauth',setup(b){b.onLoad({filter:/oauth-client\.json$/},()=>({contents:JSON.stringify({webClientId:'123456-fixture.apps.googleusercontent.com'}),loader:'json'}));}}]})).outputFiles[0].text;
function harness({connected=true, fetcher, sessionState={}}={}) {
  let listener;
  const state={connected,needsReconnect:false,email:'fixture@example.net',sites:{},disabledSites:{}};
  let authCalls=0, clearCalls=0; const session=sessionState; const launchArgs=[];
  const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},fire(){for(const fn of this.listeners) fn();}});
  const chrome={runtime:{id:'extension',getURL:p=>`chrome-extension://extension/${p}`,getManifest:()=>({oauth2:{client_id:'fixture'}}),onMessage:{addListener:fn=>listener=fn},onInstalled:event(),onStartup:event()},
    storage:{local:{get:async()=>structuredClone(state),set:async v=>Object.assign(state,v),setAccessLevel:async()=>{}},session:{get:async()=>structuredClone(session),set:async v=>Object.assign(session,v),remove:async key=>{delete session[key];},setAccessLevel:async()=>{}}},
    identity:{getRedirectURL:()=> 'https://extension.chromiumapp.org/',launchWebAuthFlow:async(args)=>{const {url}=args;launchArgs.push(args);authCalls++;const u=new URL(url);return 'https://extension.chromiumapp.org/#'+new URLSearchParams({state:u.searchParams.get('state'),access_token:'secret-token',expires_in:'3600',token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.readonly'});},getAuthToken:async()=>{authCalls++;return {token:'secret-token',grantedScopes:['https://www.googleapis.com/auth/gmail.readonly']};},clearAllCachedAuthTokens:async()=>{clearCalls++;},removeCachedAuthToken:async()=>{}},
    tabs:{get:async()=>({active:true,url:'https://example.com/login'}),query:async()=>[],onRemoved:event()},
    scripting:{getRegisteredContentScripts:async()=>[],unregisterContentScripts:async()=>{},registerContentScripts:async()=>{}},permissions:{contains:async()=>true,remove:async()=>{chrome.permissions.onRemoved.fire();return true;},onRemoved:event(),onAdded:event()}};
  const context=vm.createContext({chrome,crypto:webcrypto,fetch:fetcher??(async()=>({ok:true,json:async()=>({messages:[]})})),URL,URLSearchParams,TextDecoder,Uint8Array,atob,AbortSignal,Date,setTimeout,clearTimeout});
  vm.runInContext(bundled,context);
  const ui={id:'extension',url:'chrome-extension://extension/popup.html'};
  const page={id:'extension',url:'https://example.com/login',tab:{id:1},frameId:0,documentId:'doc',documentLifecycle:'active'};
  return {state,session,chrome,ui,page,launchArgs,clearCalls:()=>clearCalls,authCalls:()=>authCalls,send:(message,sender=page)=>new Promise(resolve=>listener(message,sender,resolve))};
}
test('page cannot request settings, sign-in, site changes or disconnect',async()=>{
 const h=harness(); for(const type of ['STATUS','CONNECT','SET_SITE','SET_SENDER','DISCONNECT']) assert.equal((await h.send({type})).code,'INVALID'); assert.equal(h.authCalls(),0);
});
test('background validates tab origin, frame and document lifecycle',async()=>{
 const h=harness(); for(const changes of [{url:'https://evil.org'},{frameId:1},{documentLifecycle:'prerender'},{id:'foreign'}]) assert.equal((await h.send({type:'POLL'},{...h.page,...changes})).code,'INVALID'); assert.equal(h.authCalls(),0);
});
test('disabled site and disconnected account never fetch Gmail',async()=>{
 const h=harness();h.state.disabledSites={'https://example.com':true}; assert.equal((await h.send({type:'POLL'})).code,'DENIED');
 h.state.connected=false; assert.equal((await h.send({type:'POLL'})).code,'SETUP');assert.equal(h.authCalls(),0);
});
test('polling throttles repeated calls',async()=>{
 const h=harness();assert.equal((await h.send({type:'POLL'})).ok,true); await h.send({type:'POLL'});assert.equal(h.authCalls(),1);
});
test('privileged status never contains authentication tokens',async()=>{
 const h=harness(); const result=await h.send({type:'STATUS'},h.ui);assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes('secret-token'),false);
});
test('unknown or stale candidate cannot be consumed',async()=>{
 const h=harness();assert.equal((await h.send({type:'CONSUME',id:'invented'})).ok,false);
});
test('disconnect during a pending request suppresses candidate delivery',async()=>{
 let resolve;const waiting=new Promise(r=>resolve=r);const h=harness({fetcher:async()=>{await waiting;return {ok:true,json:async()=>({messages:[]})};}});
 const pending=h.send({type:'POLL'});await new Promise(r=>setImmediate(r));h.state.connected=false;resolve();const result=await pending;assert.equal(result.ok,false);assert.equal(result.code,'SETUP');
});
test('concurrent script refreshes cannot register duplicate IDs',async()=>{
 const h=harness();let registered=false;
 h.chrome.scripting.getRegisteredContentScripts=async()=>{await new Promise(r=>setTimeout(r,1));return registered?[{id:'inbox-code'}]:[];};
 h.chrome.scripting.unregisterContentScripts=async()=>{registered=false;};
 h.chrome.scripting.registerContentScripts=async()=>{assert.equal(registered,false,'duplicate registration');await new Promise(r=>setTimeout(r,1));registered=true;};
 const results=await Promise.all([h.send({type:'SET_SITE',origin:'https://example.com',enabled:true},h.ui),h.send({type:'SET_SITE',origin:'https://example.com',enabled:true},h.ui)]);
 assert.ok(results.every(r=>r.ok));
 assert.equal((await h.send({type:'SET_SITE',origin:'https://example.com',enabled:false},h.ui)).ok,true);
});
test('silent renewal uses prompt=none and the connected account hint',async()=>{
 const h=harness();await h.send({type:'POLL'});
 const request=new URL(h.launchArgs[0].url);assert.equal(request.searchParams.get('prompt'),'none');assert.equal(request.searchParams.get('login_hint'),'fixture@example.net');assert.equal(h.launchArgs[0].interactive,false);
});
test('offline renewal preserves authorization and remains retryable',async()=>{
 const h=harness();h.session.oauth={accessToken:'old-token',expiresAt:0};
 h.chrome.identity.launchWebAuthFlow=async()=>{throw new Error('Authorization page could not be loaded.');};
 const result=await h.send({type:'POLL'});assert.equal(result.code,'NETWORK');assert.equal(h.clearCalls(),0);assert.equal(h.state.connected,true);assert.equal(h.state.needsReconnect,false);assert.equal(h.session.oauth.accessToken,'old-token');
});
test('interaction-required renewal exposes reconnect without revocation',async()=>{
 const h=harness();h.chrome.identity.launchWebAuthFlow=async()=>{throw new Error('The user did not approve access.');};
 assert.equal((await h.send({type:'POLL'})).code,'RECONNECT');assert.equal(h.state.needsReconnect,true);assert.equal(h.state.connected,true);assert.equal(h.clearCalls(),0);
});
test('401 invalidates only the rejected token and retries once silently',async()=>{
 let requests=0;const h=harness({fetcher:async()=>++requests===1?{ok:false,status:401}:{ok:true,json:async()=>({messages:[]})}});
 assert.equal((await h.send({type:'POLL'})).ok,true);assert.equal(requests,2);assert.equal(h.authCalls(),2);assert.equal(h.clearCalls(),0);assert.ok(h.launchArgs.every(a=>!a.interactive));
});
test('disconnect during sign-in cannot restore a token or connected state',async()=>{
 const h=harness({connected:false});let resolve,request;
 h.chrome.identity.launchWebAuthFlow=async args=>{request=new URL(args.url);return new Promise(r=>resolve=r);};
 const connect=h.send({type:'CONNECT'},h.ui);await new Promise(r=>setImmediate(r));
 await h.send({type:'DISCONNECT'},h.ui);
 resolve('https://extension.chromiumapp.org/#'+new URLSearchParams({state:request.searchParams.get('state'),access_token:'late-token',expires_in:'3600',token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.readonly'}));
 assert.equal((await connect).ok,false);assert.equal(h.state.connected,false);assert.equal(h.session.oauth,undefined);assert.equal(h.clearCalls(),1);
});
test('an interactive Connect waits for silent renewal then opens its own picker',async()=>{
 const h=harness();const original=h.chrome.identity.launchWebAuthFlow;let release;
 h.chrome.identity.launchWebAuthFlow=async args=>{if(!args.interactive) await new Promise(r=>release=r);return original(args);};
 const poll=h.send({type:'POLL'});await new Promise(r=>setImmediate(r));const connect=h.send({type:'CONNECT'},h.ui);release();await poll;await connect;
 assert.deepEqual(h.launchArgs.map(a=>new URL(a.url).searchParams.get('prompt')),['none','select_account']);
});
test('consumed codes remain suppressed after service-worker restart',async()=>{
 const received=Date.now();
 const fetcher=async url=>({ok:true,json:async()=>url.includes('messages?')?{messages:[{id:'used-mail'}]}:{id:'used-mail',internalDate:String(received),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'security@example.com'},{name:'Subject',value:'Your verification code'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.com'}],body:{data:Buffer.from('Verification code: 123456').toString('base64url')}}}});
 const h=harness({fetcher});const result=await h.send({type:'POLL'});assert.equal(result.candidates[0].code,'123456');
 assert.equal((await h.send({type:'CONSUME',id:'used-mail'})).ok,true);
 const restarted=harness({fetcher,sessionState:h.session});assert.equal((await restarted.send({type:'POLL'})).candidates.length,0);
});
test('a recovered silent poll clears an obsolete reconnect notice',async()=>{
 const h=harness();h.state.needsReconnect=true;assert.equal((await h.send({type:'POLL'})).ok,true);assert.equal(h.state.needsReconnect,false);
});
test('unconfigured HTTPS sites are on by default',async()=>{
 const h=harness();assert.deepEqual(h.state.sites,{});assert.equal((await h.send({type:'POLL'})).ok,true);
});
test('site opt-out and sender preferences serialize without losing concurrent edits',async()=>{
 const h=harness();await Promise.all(['https://example.com','https://other.com'].map(origin=>h.send({type:'SET_SITE',origin,enabled:false},h.ui)));
 assert.equal(Object.keys(h.state.disabledSites).length,2);
 assert.equal((await h.send({type:'POLL'})).code,'DENIED');assert.equal(h.authCalls(),0);
 await h.send({type:'SET_SITE',origin:'https://example.com',enabled:true},h.ui);
 assert.equal((await h.send({type:'POLL'})).ok,true);assert.equal(h.state.disabledSites['https://other.com'],true);
});
test('no host grant, invalid origin and unsupported sender domain fail closed',async()=>{
 const h=harness();h.chrome.permissions.contains=async()=>false;
 assert.equal((await h.send({type:'POLL'})).code,'DENIED');assert.equal(h.authCalls(),0);
 for(const origin of ['http://example.com','https://example.com:8443','https://example.com/path']) assert.equal((await h.send({type:'SET_SITE',origin,enabled:false},h.ui)).code,'INVALID');
 assert.equal((await h.send({type:'SET_SENDER',origin:'https://example.com',senderDomain:'com'},h.ui)).code,'INVALID');
});
test('default-on never offers mail from another website',async()=>{
 let fullReads=0;const h=harness({fetcher:async url=>{if(url.includes('format=full')) fullReads++;
 return {ok:true,json:async()=>url.includes('messages?')?{messages:[{id:'unrelated'}]}:{payload:{headers:[{name:'From',value:'security@bank.com'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=bank.com'}]}}};}});
 assert.equal((await h.send({type:'POLL'})).candidates.length,0);assert.equal(fullReads,0);
});
test('Cloudflare uses its email domain automatically, including old incorrect saved default',async()=>{
 for(const legacy of [false,true]){
 const now=Date.now();const h=harness({fetcher:async url=>({ok:true,json:async()=>url.includes('messages?')?{messages:[{id:'cf-code'}]}:{id:'cf-code',internalDate:String(now),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'noreply@notify.cloudflare.com'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=notify.cloudflare.com'}],body:{data:Buffer.from('Your code: 123456').toString('base64url')}}}})});
 h.chrome.tabs.get=async()=>({active:true,url:'https://example-team.cloudflareaccess.com/login'});
 if(legacy) h.state.sites['https://example-team.cloudflareaccess.com']={senderDomain:'cloudflareaccess.com'};
 const result=await h.send({type:'POLL'},{...h.page,url:'https://example-team.cloudflareaccess.com/login'});
 assert.equal(result.candidates[0].code,'123456');assert.equal(result.senderDomain,'notify.cloudflare.com');
 }
});
test('site disabled during retrieval cannot receive or consume a found code',async()=>{
 let release;const waiting=new Promise(r=>release=r),received=Date.now();const h=harness({fetcher:async url=>{await waiting;return {ok:true,json:async()=>url.includes('messages?')?{messages:[{id:'found-mail'}]}:{id:'found-mail',internalDate:String(received),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'security@example.com'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.com'}],body:{data:Buffer.from('Your code: 123456').toString('base64url')}}}};}});
 const pending=h.send({type:'POLL'});await new Promise(r=>setImmediate(r));
 await h.send({type:'SET_SITE',origin:'https://example.com',enabled:false},h.ui);release();
 assert.equal((await pending).code,'DENIED');assert.equal((await h.send({type:'CONSUME',id:'found-mail'})).code,'DENIED');
});
test('custom sender is optional, preserved per origin and resettable',async()=>{
 const h=harness();const origin='https://example.com';
 await h.send({type:'SET_SENDER',origin,senderDomain:'mailservice.com'},h.ui);assert.equal(h.state.sites[origin].senderDomain,'mailservice.com');
 assert.equal((await h.send({type:'POLL'})).senderDomain,'mailservice.com');
 await h.send({type:'SET_SENDER',origin,senderDomain:''},h.ui);assert.equal(h.state.sites[origin],undefined);
});
test('changing sender during consume cannot release a stale candidate',async()=>{
 const received=Date.now();const h=harness({fetcher:async url=>({ok:true,json:async()=>url.includes('messages?')?{messages:[{id:'race-mail'}]}:{id:'race-mail',internalDate:String(received),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'security@example.com'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.com'}],body:{data:Buffer.from('Your code: 123456').toString('base64url')}}}})});
 assert.equal((await h.send({type:'POLL'})).candidates.length,1);
 const save=h.chrome.storage.session.set;h.chrome.storage.session.set=async values=>{await save(values);if(values.usedCodes) await h.send({type:'SET_SENDER',origin:'https://example.com',senderDomain:'other.com'},h.ui);};
 assert.equal((await h.send({type:'CONSUME',id:'race-mail'})).code,'INVALID');
});
test('restricted browser site access keeps registration and re-registers on restored grants',async()=>{
 const h=harness();const scripts=[];h.chrome.permissions.contains=async()=>false;
 h.chrome.scripting.registerContentScripts=async entries=>scripts.push(entries[0]);
 h.chrome.runtime.onInstalled.fire();await new Promise(r=>setTimeout(r,10));
 assert.equal(scripts.length,1);assert.deepEqual([...scripts[0].matches],['https://*/*']);
 h.chrome.permissions.onAdded.fire();await new Promise(r=>setTimeout(r,10));assert.equal(scripts.length,2);
 assert.equal((await h.send({type:'POLL'})).code,'DENIED');assert.equal(h.authCalls(),0);
});
test('shared hosts require an explicit sender override while ordinary sites remain default-on',async()=>{
 const h=harness();h.chrome.tabs.get=async()=>({active:true,url:'https://tenant.wordpress.com/login'});
 const page={...h.page,url:'https://tenant.wordpress.com/login'};
 assert.equal((await h.send({type:'POLL'},page)).code,'DENIED');assert.equal(h.authCalls(),0);
 assert.equal((await h.send({type:'SET_SENDER',origin:'https://tenant.wordpress.com',senderDomain:'wordpress.com'},h.ui)).ok,true);
 assert.equal((await h.send({type:'POLL'},page)).ok,true);
});
test('site disabled during consume cannot release the already retrieved code',async()=>{
 const received=Date.now();const h=harness({fetcher:async url=>({ok:true,json:async()=>url.includes('messages?')?{messages:[{id:'disable-mail'}]}:{id:'disable-mail',internalDate:String(received),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'security@example.com'},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.com'}],body:{data:Buffer.from('Your code: 123456').toString('base64url')}}}})});
 assert.equal((await h.send({type:'POLL'})).candidates.length,1);
 const save=h.chrome.storage.session.set;h.chrome.storage.session.set=async values=>{await save(values);if(values.usedCodes) await h.send({type:'SET_SITE',origin:'https://example.com',enabled:false},h.ui);};
 assert.equal((await h.send({type:'CONSUME',id:'disable-mail'})).code,'DENIED');
});
test('origins with an internationalized top-level domain can be disabled',async()=>{
 const h=harness();const origin='https://xn--e1afmkfd.xn--p1ai';
 assert.equal((await h.send({type:'SET_SITE',origin,enabled:false},h.ui)).ok,true);assert.equal(h.state.disabledSites[origin],true);
 assert.equal((await h.send({type:'SET_SITE',origin,enabled:true},h.ui)).ok,true);assert.equal(h.state.disabledSites[origin],undefined);
});
