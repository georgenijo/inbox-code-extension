# Release checklist

The source distribution is a development build. Every distributor configures its own Google project and must verify the actual installed identity.

- [ ] Configure Google OAuth clients and enable Gmail API in your project.
- [ ] Bind clients and callback URI to the actual installed extension ID.
- [ ] Configure the consent screen, Gmail read-only scope and test users.
- [ ] Verify live Google sign-in and a real emailed code in each supported browser.
- [ ] Run automated checks and browser fixture suites.
- [ ] Complete independent review for material product/security changes.
- [ ] Prepare store images, support contact and hosted privacy policy.
- [ ] Complete applicable Chrome Web Store review and Google restricted-scope verification before broad distribution.

Keep synthetic fixture evidence distinct from live Gmail verification. Public source availability is not a store release or Google OAuth approval.
