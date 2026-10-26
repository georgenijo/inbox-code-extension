(() => {
  if (globalThis.__inboxCodeLoaded) return;
  globalThis.__inboxCodeLoaded = true;
  let lastMoved = 0, lastPosition = '', visibilityObserver, suggestionVisible = false, expectedRect;
  let siteEnabled = true, watchEpoch = 0, windowPaused = !document.hasFocus();
  let target, host, root, timer, busy = false, dismissed, began = 0, lastRender = '', currentCandidates = [];
  const ignored = /password|email|phone|coupon|promo|postal|zip|credit|card|search/i;
  const hint = /one.?time|verif|otp|auth.?code|security.?code|passcode|confirmation.?code|login.?code|sign.?in.?code/i;
  function visible(input) {
    return input instanceof HTMLInputElement && !input.disabled && !input.readOnly && input.getClientRects().length > 0 && getComputedStyle(input).visibility === 'visible' && getComputedStyle(input).opacity !== '0';
  }
  function description(input) {
    return [input.name, input.id, input.placeholder, input.getAttribute('aria-label'), ...(input.labels ?? [])].map(v => typeof v === 'string' ? v : v?.textContent ?? '').join(' ');
  }
  function group(input) {
    if (input.maxLength !== 1) return [input];
    const parent = input.closest('fieldset, [role="group"], form') ?? input.parentElement;
    const peers = [...parent.querySelectorAll('input')].filter(el => visible(el) && el.maxLength === 1 && ['text', 'tel', 'number'].includes(el.type));
    return peers.length >= 4 && peers.length <= 8 && peers.includes(input) ? peers : [input];
  }
  function isOtp(input) {
    if (!visible(input) || !['text', 'tel', 'number'].includes(input.type)) return false;
    if (input.autocomplete === 'one-time-code') return true;
    const desc = description(input);
    if (/coupon|promo|postal|zip|credit|card|search/i.test(desc)) return false;
    const identity = [input.name, input.id, input.autocomplete].join(' ');
    if (/email|phone|password/i.test(identity) && !/code|otp|pin/i.test(identity)) return false;
    if (hint.test(desc)) return true;
    if (ignored.test([input.name, input.id, input.autocomplete].join(' '))) return false;
    const scope = input.closest('fieldset, form, [role="group"]') ?? input.parentElement;
    const context = [scope?.textContent?.slice(0, 2000), document.querySelector('h1')?.textContent].filter(Boolean).join(' ');
    return /verification code|security code|one.time (?:code|password)|enter (?:the |your )?code|check your email/i.test(context) && (input.maxLength >= 4 && input.maxLength <= 8 || group(input).length > 1 || /(?:^|\s)(?:code|pin)(?:\s|$)/i.test(desc));
  }
  function clear({ stopPolling = true } = {}) {
    if (stopPolling) { clearTimeout(timer); timer = undefined; }
    visibilityObserver?.disconnect(); suggestionVisible = false; lastPosition = '';
    host?.remove(); host = undefined; expectedRect = undefined; root = undefined; lastRender = ''; currentCandidates = [];
  }
  function position() {
    if (!host || !target || !visible(target)) return;
    const box = target.getBoundingClientRect();
    const positionKey = `${Math.round(box.left)}:${Math.round(box.bottom)}`;
    if (positionKey !== lastPosition) { lastMoved = Date.now(); lastPosition = positionKey; }
    host.style.setProperty('left', `${Math.max(8, Math.min(box.left, innerWidth - 268))}px`, 'important');
    host.style.setProperty('top', `${Math.max(8, Math.min(box.bottom + 8, innerHeight - host.getBoundingClientRect().height - 8))}px`, 'important');
    expectedRect = host.getBoundingClientRect();
  }
  async function fill(candidate, event) {
    if (!siteEnabled || windowPaused || !document.hasFocus() || !event.isTrusted || !target || !isOtp(target) || candidate.expiresAt <= Date.now() || document.visibilityState !== 'visible') return;
    const actualRect = host?.getBoundingClientRect();
    if (!actualRect || !expectedRect || ['x','y','width','height'].some(key => Math.abs(actualRect[key] - expectedRect[key]) > 1)) return;
    if (Date.now() - lastMoved < 600 || !suggestionVisible) return;
    const keyboard = event.detail === 0 && root.activeElement === event.currentTarget;
    if (!keyboard && (document.elementFromPoint(event.clientX, event.clientY) !== host || root.elementFromPoint(event.clientX, event.clientY)?.closest('button.code') !== event.currentTarget)) return;
    for (let element = host; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < 1) return;
    const clickedTarget = target, clickedEpoch = watchEpoch;
    let permission;
    try { permission = await chrome.runtime.sendMessage({ type: 'CONSUME', id: candidate.id }); } catch { clear(); return; }
    if (!siteEnabled || windowPaused || !document.hasFocus() || clickedEpoch !== watchEpoch || !permission?.ok || !permission.candidate || permission.candidate.code !== candidate.code || clickedTarget !== target || !isOtp(target) || document.visibilityState !== 'visible') { clear(); return; }
    const inputs = group(target);
    if (inputs.some(el => el.value)) return;
    if (inputs.length > 1 && inputs.length !== candidate.code.length) return;
    if (inputs.length === 1 && target.maxLength > 0 && target.maxLength < candidate.code.length) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const selected = target;
    inputs.forEach((input, index) => {
      setter.call(input, inputs.length > 1 ? candidate.code[index] : candidate.code);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    dismissed = selected; clear();
    inputs.at(-1)?.focus();

  }
  function render(candidates, status) {
    const signature = JSON.stringify({ candidates, status });
    if (signature === lastRender && host?.isConnected) { position(); return; }
    if (!host?.isConnected) {
      host = document.createElement('inbox-code-suggestion');
      host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;width:260px!important;color-scheme:light!important;';
      root = host.attachShadow({ mode: 'closed' });
      document.documentElement.append(host);
      visibilityObserver = new IntersectionObserver(entries => { suggestionVisible = Boolean(entries[0]?.isVisible); }, { trackVisibility: true, delay: 100 });
      visibilityObserver.observe(host);
    }
    lastMoved = Date.now();
    lastRender = signature; currentCandidates = candidates;
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = ':host{font:13px/1.4 system-ui,sans-serif;color:#19332f}section{font:13px/1.4 system-ui,sans-serif;color:#19332f;background:#fff;border:1px solid #d4e2dc;border-radius:10px;box-shadow:0 6px 20px #122c2520;padding:9px}header{display:flex;align-items:center;justify-content:space-between;font-weight:650;margin-bottom:8px}button{font:inherit;cursor:pointer}button.close{background:none;border:0;color:#556a63;padding:0 4px;font-size:18px}button.code{display:block;width:100%;text-align:left;border:1px solid #e0e9e5;background:#f4faf6;border-radius:9px;padding:9px 12px;margin-top:6px;color:#153c30}button.code:hover,button.code:focus-visible{outline:2px solid #27855e;outline-offset:1px}strong{display:block;font-size:20px;letter-spacing:2px}small{display:block;font-size:11px;overflow-wrap:anywhere}p{margin:4px 0;color:#5d7169;font-size:12px}';
    const section = document.createElement('section'); section.setAttribute('aria-label', 'Inbox Code suggestions');
    const header = document.createElement('header'); header.textContent = '✉  Inbox Code';
    const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss code suggestion');
    close.onclick = () => { dismissed = target; clear(); };
    header.append(close); section.append(header);
    for (const candidate of candidates) {
      const button = document.createElement('button'); button.className = 'code';
      const code = document.createElement('strong'); code.textContent = candidate.code;
      const source = document.createElement('small'); source.textContent = `From ${candidate.sender}`;
        button.append(code, source); button.addEventListener('click', e => fill(candidate, e)); section.append(button);
    }
    if (!candidates.length) { const p = document.createElement('p'); p.setAttribute('role', 'status'); p.textContent = status; section.append(p); }
    root.append(style, section); position();
  }
  async function poll() {
    clearTimeout(timer);
    if (!siteEnabled || windowPaused || !document.hasFocus() || !target?.isConnected || target === dismissed || group(target).some(i => i.value) || document.visibilityState !== 'visible') { clear(); return; }
    if (!isOtp(target)) {
      clear();
      if (Date.now() - began < 5 * 60_000) timer = setTimeout(poll, 5_000);
      return;
    }
    if (Date.now() - began > 5 * 60_000) { render([], 'Still waiting? Focus the field again to check Gmail.'); return; }
    if (busy) { timer = setTimeout(poll, 1000); return; }
    busy = true;
    const requestedTarget = target, requestedEpoch = watchEpoch;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'POLL' });
      if (!siteEnabled || windowPaused || !document.hasFocus() || requestedEpoch !== watchEpoch || requestedTarget !== target || target === dismissed || !isOtp(target) || group(target).some(i => i.value) || document.visibilityState !== 'visible') return;
      if (!result?.ok) {
        if (['DENIED', 'INVALID'].includes(result?.code)) { if (result.code === 'DENIED') siteEnabled = false; clear(); return; }
        render([], result?.error ?? 'Open Inbox Code to reconnect.');
        if (['SETUP', 'RECONNECT', 'DENIED', 'UNCONFIGURED', 'GMAIL_ACCESS'].includes(result?.code)) return;
      } else {
        const candidates = result.candidates.filter(c => c.expiresAt > Date.now() && (group(target).length === 1 || group(target).length === c.code.length));
        render(candidates, `Waiting for a code from ${result.senderDomain}…`);
      }
      timer = setTimeout(poll, 5_000);
    } catch { if (siteEnabled && !windowPaused && document.hasFocus() && requestedEpoch === watchEpoch) render([], 'Open Inbox Code to reconnect.'); }
    finally { busy = false; }
  }
  function pauseWindow() {
    windowPaused = true; ++watchEpoch; clear();
  }
  function resumeWindow() {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    windowPaused = false;
    const active = document.activeElement;
    if (isOtp(active)) {
      if (target !== active) { ++watchEpoch; dismissed = undefined; }
      target = active;
    } else if (active !== host || !target || !isOtp(target)) { target = undefined; clear(); return; }
    // Returning to an already-focused field doesn't always dispatch focusin.
    // Keep an explicit dismissal, but start a fresh watch for a real return.
    if (target === dismissed) return;
    began = Date.now(); poll();
  }
  addEventListener('blur', pauseWindow);
  addEventListener('focus', resumeWindow);
  document.addEventListener('focusin', event => {
    if (event.composedPath().includes(host)) return;
    if (!isOtp(event.target)) { ++watchEpoch; target = undefined; clear(); return; }
    if (target !== event.target) { ++watchEpoch; dismissed = undefined; clear(); }
    windowPaused = !document.hasFocus(); target = event.target; began = Date.now(); poll();
  });
  document.addEventListener('input', event => { if (target && group(target).includes(event.target)) { if (group(target).some(i => i.value)) clear(); else poll(); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { dismissed = target; clear(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pauseWindow(); else resumeWindow(); });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'SITE_CHANGED') return;
    ++watchEpoch; siteEnabled = message.enabled === true; clear();
    if (siteEnabled && target) { dismissed = undefined; began = Date.now(); poll(); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.connected || changes.sites || changes.disabledSites)) { clear(); }
  });
  addEventListener('scroll', position, true); addEventListener('resize', position);
  setInterval(() => {
    if (host && !target?.isConnected) clear();
    else if (host && (!visible(target) || currentCandidates.some(c => c.expiresAt <= Date.now()))) clear({ stopPolling: false });
  }, 1000);
  if (isOtp(document.activeElement)) { target = document.activeElement; began = Date.now(); poll(); }
})();
