import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOAuthResponse } from '../src/auth.js';
import { GMAIL_SCOPE } from '../src/core.js';
const redirect='https://extension.chromiumapp.org/';
function response(overrides={}) { return redirect+'#'+new URLSearchParams({state:'random-state',access_token:'fixture-token',token_type:'Bearer',expires_in:'3600',scope:GMAIL_SCOPE,...overrides}); }
test('OAuth callback validates state, exact redirect, permission and expiry',()=>{
 assert.deepEqual(parseOAuthResponse(response(),redirect,'random-state',1000),{accessToken:'fixture-token',expiresAt:3601000});
 for(const data of [{state:'attacker'},{expires_in:'NaN'},{expires_in:'0'},{expires_in:'90000'},{scope:'email'},{token_type:'other'},{access_token:''}]) assert.throws(()=>parseOAuthResponse(response(data),redirect,'random-state'));
 for(const value of [response().replace('extension.chromiumapp.org','evil.org'),response().replace('/#','/evil#'),response().replace('/#','/?q=x#')]) assert.throws(()=>parseOAuthResponse(value,redirect,'random-state'));
});
test('OAuth denial never becomes a connected session',()=>{
 assert.throws(()=>parseOAuthResponse(response({error:'access_denied'}),redirect,'random-state'),{code:'RECONNECT'});
});
