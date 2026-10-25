# Inbox Code

A custom Brave/Chrome extension that reads recent Gmail verification emails and offers a code beside the focused login field. Click the suggestion to fill a single input or a row of digit boxes. It never clicks Verify or submits a form (a website may itself submit when all digits are entered).

## Use

1. Install the extension and click **Connect with Google**.
2. Request an email code on a login page and focus its verification-code field. Suggestions are on by default on supported HTTPS websites.
3. Click the matching suggestion to fill. Open the extension and flip the website switch off to disable suggestions there.

Sender matching is automatic: the website's domain is used, with built-in handling for Cloudflare Access emails from `notify.cloudflare.com`. An optional sender override is tucked under **Sender matching** for services that email from a different domain. Existing custom senders are retained. Shared-content hosts (such as Google Docs and hosted WordPress sites) do not automatically inherit their platform’s email domain; a trusted sender can optionally be set there.

Upgrading from 0.1 requires accepting Brave/Chrome's expanded HTTPS site-access permission, then refreshing open login pages. The compact popup shows a single website switch and an optional list of disabled sites.

Email bodies are processed locally. No app server, analytics, external AI, or clipboard access. Google OAuth tokens are kept in extension-only session memory and are cleared on browser restart or disconnect; they are never saved to disk by the extension. Settings contain your connected email address and disabled sites and optional sender overrides. Recent candidates are held briefly in service-worker memory and in the suggestion's DOM while visible.

## Development

Requires Node 22+ and npm. No runtime CDN or remotely hosted code.

```sh
npm ci
npm run check
npm run test:browser
npm run package
```

`dist/` is the unpacked extension. `artifacts/` contains the package and browser-test screenshots/video. The integration test uses a **separate temporary Brave profile** on macOS, or Playwright Chromium elsewhere. It loads the real extension but replaces Google identity and Gmail HTTP responses with fixtures. It never uses your existing browser profile or inbox. Install test Chromium with `npx playwright install --with-deps chromium` on Linux.

This source distribution contains no configured Google project or OAuth client IDs. Follow [Google setup](docs/SETUP.md) to configure your own project and test users. Without a configured client ID, the build is explicitly development-only and Connect is disabled. `node scripts/build.mjs --release` refuses to build without a client ID.

## Supported and intentionally excluded

- Desktop Brave and Chrome, Manifest V3, Chrome 120+ APIs.
- One connected Gmail account; HTTPS websites on by default with an exact-origin disable list.
- Numeric codes (4–8 digits), six-digit space/hyphen groups, and uppercase alphanumeric codes (6–10 characters containing letters and numbers).
- Standard visible, editable top-level inputs and split fields. Iframes, closed shadow DOM forms, HTTP sites, password inputs, and magic links are not supported.
- Gmail's own `Authentication-Results` must report DMARC pass aligned to the From domain. Forwarded mail that loses this result is excluded.
- A candidate must match the automatically matched or overridden sender domain (or a subdomain), be at most five minutes old, and arrive within the current watch window (including a two-minute lookback). Ambiguous multiple codes are excluded.
- Checks run every five seconds only while a code field is focused/visible, for up to five minutes. Re-focus to resume. API throttling backs off.
- Sender-domain matching cannot establish which login attempt an email belongs to. A compromised matching site or sender remains a trust boundary. Review the displayed sender before clicking.

See [privacy](docs/PRIVACY.md) and [release checklist](docs/RELEASE.md).

For a durable local installation outside a scratch checkout, run `node scripts/stage-local.mjs` after building and load the printed directory. On macOS this is `~/Library/Application Support/Inbox Code/extension`. Re-run the staging command and reload the extension after an update.

## License

[MIT](LICENSE). Contributions are welcome; please avoid including account data, OAuth credentials, or real email content in issues, test fixtures, or pull requests.
