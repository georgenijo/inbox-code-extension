# Validation

Version 0.2.0 has 47 automated checks and 37 real-extension integration assertions in each of Brave and Google Chrome for Testing. The browser suites use isolated temporary profiles with synthetic Gmail and identity responses; they do not access a real inbox. Run the commands below to verify your checkout.

```sh
npm ci
npm run check
npm run test:browser
```

The browser suite uses Brave when available on macOS, otherwise Playwright Chromium. Set `BROWSER_PATH` to test another Chromium executable. On Linux, install the test browser with `npx playwright install --with-deps chromium`.

Coverage includes OAuth callback validation, token renewal/reconnect, sender authentication and domain boundaries, shared-content host isolation, permission/opt-out races, code consumption, dynamic script registration, single/split fields, click/visibility protection, keyboard fill, automatic Cloudflare sender matching, compact controls and no extension-triggered submission.

A read-only independent cross-family review passed after material findings were resolved. An independent privacy review also passed on the sanitized public source, including its Git metadata, build configuration and fixture-only CI artifacts.

A real-email Cloudflare Access flow was also manually exercised in Brave during development. No account identifiers, mailbox contents, private application URLs, screenshots of real mail, or machine-specific session records are included here. Fixture coverage is not a claim that Google has verified this application or approved public Gmail access.

Screenshots, videos and fixture results from local test runs are written to ignored `artifacts/`. They are not shipped in the source repository. Do not upload real browser-profile data or configured builds as public test evidence.
