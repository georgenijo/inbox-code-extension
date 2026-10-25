# Google and Brave setup

The public OAuth client identifies Inbox Code. Each user authorizes Gmail separately through Google's consent screen. A Chrome Web Store review and Google's restricted-scope review for public use are separate from user consent.

1. Create a Google Cloud project and enable **Gmail API**.
2. In Google Auth Platform, set the app name to Inbox Code, select External, and leave it in Testing while developing. Add your Gmail address under Audience → Test users.
3. Add `https://www.googleapis.com/auth/gmail.readonly` under Data Access.
4. Create an OAuth client of type **Chrome Extension**. Use the extension ID printed by `npm run build`. It is derived from the development public key in `extension-key.json`. No private key or client secret is used or needed.
5. Create a second OAuth client of type **Web application** named Inbox Code browser sign-in. Set its authorized redirect URI to `https://YOUR_EXTENSION_ID.chromiumapp.org/`. No JavaScript origin is needed for the redirect flow. Do not download or embed its client secret.
6. Put the public client IDs in ignored `config.local.json`:
   ```json
   { "clientId": "CHROME_CLIENT_ID.apps.googleusercontent.com", "webClientId": "WEB_CLIENT_ID.apps.googleusercontent.com" }
   ```
   Or supply `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_WEB_CLIENT_ID` to the build process. The built manifest necessarily contains this **public** identifier.
7. Run `npm run build`. In `brave://extensions` or `chrome://extensions`, turn on Developer mode and Load unpacked → this repository's `dist` directory. Reload after rebuilding. Version 0.2 requests HTTPS access once for default-on suggestions; accept the browser’s permission update when upgrading from 0.1 and refresh any already-open login page.
8. Brave and Chrome use `identity.launchWebAuthFlow` with the web client. This does not require browser-level Chrome sign-in. If using a Chrome-only configuration without a web client, the extension falls back to `getAuthToken`.
9. Open the extension button and Connect with Google. Grant Gmail read-only access. An unverified test-app notice may appear until verification; only configured test users can use testing mode.

Testing-mode authorization can expire and require reconnection. Revoking access, signing out, or removing the Gmail scope also requires reconnecting. Disconnect clears local connection state and cached tokens, and attempts to revoke the Google grant. If Google is unreachable, remove the grant at https://myaccount.google.com/connections.

For a future store listing, bind the OAuth client to the store-assigned ID and keep the store public key in sync with the manifest. Do not assume an arbitrary development key controls the store ID. Verify the installed store build's identity before publication.

References:
- https://developer.chrome.com/docs/extensions/reference/api/identity
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://github.com/brave/brave-browser/wiki/Allow-Google-login---Third-Parties-and-Extensions

## Website behavior

Suggestions are enabled by default on supported HTTPS pages. Use the compact popup’s website switch to disable an origin. Sender matching is automatic; Cloudflare Access uses `notify.cloudflare.com`. A different sender can optionally be saved under Sender matching. No site-specific permission request or enable step is needed.

## Auth design

The web flow uses Google's client-side token response, intercepted by the browser at the extension-owned chromiumapp.org redirect. It validates the exact redirect, a random 256-bit state, granted Gmail scope, bearer token type, and bounded expiry. Tokens are stored only in trusted-context `storage.session`. Silent renewal uses `prompt=none`; if Google needs interaction, the user reconnects. Google discourages implicit flow for ordinary web SPAs; this extension uses the browser-owned redirect to keep tokens out of any hosted page, without shipping a web-client secret or adding a token-handling server. A future server-based auth architecture should use authorization code + PKCE.

If Brave reports that Google authentication is disabled, check **Allow Google login for extensions** under `brave://settings/extensions`.

The included key is a development-only public key, not a signing secret. For your own stable development identity, replace it with your own public key (or set `extensionKey` in ignored `config.local.json`). Changing the key changes the extension ID and requires updating OAuth redirects. Never commit a private signing key.
