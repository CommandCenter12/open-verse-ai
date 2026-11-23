// Open Verse Ai lock screen (same model as Command Center).
// - The owner key is encrypted with AES-GCM; the key comes from your 8-digit PIN via
//   PBKDF2-SHA256 (600,000 rounds). The encrypted blob lives ONLY in this browser
//   (localStorage) and is never published, so the PIN can't be brute-forced from the web.
// - Touch ID / Face ID wraps the same owner key with a passkey PRF secret (or, if the
//   browser lacks PRF, a non-extractable key kept in this browser's IndexedDB).
// - Unlocked state lives in this tab only and auto-locks after 5 minutes idle.
(() => {
  const ITER = 600000;
  const IDLE_MS = 5 * 60 * 1000;
  const LS = { vault: 'ova.vault', bio: 'ova.bio', fails: 'ova.fails', twostep: 'ova.twostep' };
  const SS = 'ova.session';
  const KEY_RE = /^ova_[A-Za-z0-9_-]{43}$/;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const $ = (s, r = document) => r.querySelector(s);

  const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  const ssGet = () => { try { return JSON.parse(sessionStorage.getItem(SS) || 'null'); } catch { return null; } };
  const ssSet = (v) => { try { v == null ? sessionStorage.removeItem(SS) : sessionStorage.setItem(SS, JSON.stringify(v)); } catch { /* ignore */ } };

  // ---------- crypto ----------
  async function pinKey(pin, salt, iter = ITER) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(key, plaintext) {
    const iv = rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
    return { iv: b64u(iv), ct: b64u(ct) };
  }
  async function open(key, box) {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(box.iv) }, key, unb64u(box.ct))); // throws if wrong
  }
  async function createVault(ownerKey, pin, prefix) {
    const salt = rand(16);
    const box = await seal(await pinKey(pin, salt), JSON.stringify({ key: ownerKey }));
    lsSet(LS.vault, { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64u(salt), ...box, createdAt: new Date().toISOString() });
  }
  async function openVault(pin) {
    const v = lsGet(LS.vault);
    if (!v) throw new Error('No saved key on this device.');
    if (v.v === 2) return openVault2(pin);
    return JSON.parse(await open(await pinKey(pin, unb64u(v.salt), v.iter), v)).key;
  }

  // ---------- Two-step (vault v2): PIN AND Touch ID, combined into ONE key ----------
  // key = HKDF( PBKDF2(PIN) || PRF(passkey) ). Neither factor alone can decrypt, so
  // knowing the PIN without the finger (or the finger without the PIN) gets nothing.
  async function pinBits(pin, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256));
  }
  async function comboKey(pin, salt, iter, prfSecret) {
    const a = await pinBits(pin, salt, iter);
    const ikm = new Uint8Array(a.length + prfSecret.length);
    ikm.set(a); ikm.set(prfSecret, a.length);
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('ova-two-step-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const noPrf = () => Object.assign(new Error('This browser can\'t do two-step: its passkeys don\'t support the PRF feature. Use recent Safari, or Chrome with iCloud Keychain or Google Password Manager.'), { name: 'NoPrfError' });
  async function prfSecretFor(credId, prfSalt) {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32), rpId: RP_ID, userVerification: 'required', timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: unb64u(credId), transports: ['internal', 'hybrid'] }],
      extensions: { prf: { eval: { first: unb64u(prfSalt) } } },
    } });
    const r = a.getClientExtensionResults && a.getClientExtensionResults().prf;
    if (!r || !r.results || !r.results.first) throw noPrf();
    return new Uint8Array(r.results.first);
  }
  async function openVault2(pin) {
    const v = lsGet(LS.vault);
    const secret = await prfSecretFor(v.credId, v.prfSalt); // Touch ID first, while the tap still counts as a user action
    return JSON.parse(await open(await comboKey(pin, unb64u(v.salt), v.iter, secret), v)).key;
  }
  async function twoStepStep1() {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32),
      rp: { name: 'Open Verse Ai', id: RP_ID },
      user: { id: rand(16), name: 'owner-two-step', displayName: 'Open Verse Ai two-step' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, attestation: 'none', extensions: { prf: {} },
    } });
    const ext = (cred.getClientExtensionResults && cred.getClientExtensionResults()) || {};
    if (ext.prf && ext.prf.enabled === false) throw noPrf();
    lsSet(LS.twostep, { credId: b64u(new Uint8Array(cred.rawId)), prfSalt: b64u(rand(32)), pending: true });
  }
  async function twoStepStep2(pin) {
    const p = lsGet(LS.twostep);
    if (!p || !p.credId) throw new Error('Start two-step setup first.');
    const ownerKeyChecked = await openVault(pin); // proves the PIN before changing anything (throws if wrong)
    const secret = await prfSecretFor(p.credId, p.prfSalt);
    const salt = rand(16);
    const box = await seal(await comboKey(pin, salt, ITER, secret), JSON.stringify({ key: ownerKeyChecked }));
    lsSet(LS.vault, { v: 2, mode: 'pin+touchid', kdf: 'PBKDF2-SHA256+PRF/HKDF', iter: ITER, salt: b64u(salt), credId: p.credId, prfSalt: p.prfSalt, ...box, createdAt: new Date().toISOString() });
    lsSet(LS.bio, null);      // remove the old "Touch ID alone" shortcut
    lsSet(LS.twostep, null);
  }

  // ---------- Touch ID / Face ID (WebAuthn, local to this site) ----------
  const RP_ID = location.hostname;
  async function hkdfKey(secret) {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('ova-bio-wrap-v1'), info: enc.encode('owner-key') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open('ova-keys', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function localWrapKey(create) {
    const db = await idb();
    const get = () => new Promise((res, rej) => { const q = db.transaction('keys').objectStore('keys').get('wrap'); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); });
    let k = await get();
    if (!k && create) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await new Promise((res, rej) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(k, 'wrap'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }
    if (!k) throw new Error('Touch ID key missing in this browser. Set it up again.');
    return k;
  }
  async function bioAvailable() {
    try { return !!(window.PublicKeyCredential && window.isSecureContext) && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch { return false; }
  }
  // Two user taps (Safari allows one WebAuthn call per tap): create, then evaluate PRF and wrap.
  async function bioEnrollStep1() {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32),
      rp: { name: 'Open Verse Ai', id: RP_ID },
      user: { id: rand(16), name: 'owner', displayName: 'Open Verse Ai owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, attestation: 'none', extensions: { prf: {} },
    } });
    lsSet(LS.bio, { v: 1, credId: b64u(new Uint8Array(cred.rawId)), prfSalt: b64u(rand(32)), pending: true });
  }
  async function bioEnrollStep2(ownerKey) {
    const rec = lsGet(LS.bio);
    if (!rec || !rec.credId) throw new Error('Start Touch ID setup first.');
    const a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32), rpId: RP_ID, userVerification: 'required', timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: unb64u(rec.credId), transports: ['internal'] }],
      extensions: { prf: { eval: { first: unb64u(rec.prfSalt) } } },
    } });
    const r = a.getClientExtensionResults && a.getClientExtensionResults().prf;
    const secret = r && r.results && r.results.first ? new Uint8Array(r.results.first) : null;
    const method = secret ? 'prf' : 'local';
    const box = await seal(secret ? await hkdfKey(secret) : await localWrapKey(true), JSON.stringify({ key: ownerKey }));
    lsSet(LS.bio, { ...rec, pending: false, method, ...box, enrolledAt: new Date().toISOString() });
    return method;
  }
  async function bioUnlock() {
    const rec = lsGet(LS.bio);
    if (!rec || rec.pending || !rec.ct) throw new Error('Touch ID is not set up on this device yet.');
    const opts = { challenge: rand(32), rpId: RP_ID, userVerification: 'required', timeout: 60000, allowCredentials: [{ type: 'public-key', id: unb64u(rec.credId), transports: ['internal'] }] };
    if (rec.method === 'prf') opts.extensions = { prf: { eval: { first: unb64u(rec.prfSalt) } } };
    const a = await navigator.credentials.get({ publicKey: opts });
    let wrapKey;
    if (rec.method === 'prf') {
      const r = a.getClientExtensionResults && a.getClientExtensionResults().prf;
      if (!r || !r.results || !r.results.first) throw new Error('This browser did not return the Touch ID key. Use your PIN.');
      wrapKey = await hkdfKey(new Uint8Array(r.results.first));
    } else wrapKey = await localWrapKey(false);
    return JSON.parse(await open(wrapKey, rec)).key;
  }

  // ---------- wrong-PIN backoff (5 free tries, then 30 s, 60 s, … up to 1 h) ----------
  function waitLeft() { const f = lsGet(LS.fails); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
  function recordFail() {
    const f = lsGet(LS.fails) || { n: 0, until: 0 };
    f.n += 1;
    f.until = f.n >= 5 ? Date.now() + Math.min(3600, 30 * 2 ** (f.n - 5)) * 1000 : 0;
    lsSet(LS.fails, f);
  }

  // ---------- session ----------
  let ownerKey = null;
  let idleTimer = null;
  const listeners = [];
  function startSession(key) {
    ownerKey = key;
    ssSet({ key, at: Date.now() });
    lsSet(LS.fails, null);
    document.documentElement.classList.remove('ova-locked');
    const ov = $('#ova-lock');
    if (ov) { ov.classList.add('hide'); setTimeout(() => { ov.hidden = true; ov.classList.remove('hide'); }, 250); }
    bumpIdle();
    renderNav();
    listeners.forEach((fn) => { try { fn(key); } catch { /* ignore */ } });
  }
  function lock() {
    ownerKey = null;
    ssSet(null);
    clearTimeout(idleTimer);
    document.documentElement.classList.add('ova-locked');
    render();
  }
  function bumpIdle() {
    if (!ownerKey) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(lock, IDLE_MS);
    const s = ssGet(); if (s) ssSet({ ...s, at: Date.now() });
  }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => addEventListener(ev, bumpIdle, { passive: true }));

  // ---------- UI ----------
  function overlay() {
    let ov = $('#ova-lock');
    if (!ov) { ov = document.createElement('div'); ov.id = 'ova-lock'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Open Verse Ai login'); document.body.prepend(ov); }
    ov.hidden = false;
    return ov;
  }
  const header = (sub) => `
    <div class="ova-brand"><span class="ova-mark" aria-hidden="true">OV</span><div><div class="ova-title">Open Verse Ai</div><div class="ova-sub">${sub}</div></div></div>
    <div class="ova-clock"><span class="t" id="ova-time"></span><span id="ova-date"></span></div>`;
  function tick() {
    const t = $('#ova-time'); const d = $('#ova-date'); const now = new Date();
    if (t) t.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d) d.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  setInterval(tick, 15000);
  const hint = (msg, kind = '') => { const h = $('#ova-hint'); if (h) { h.textContent = msg; h.className = 'ova-hint ' + kind; } };
  const shake = () => { const c = $('.ova-card'); if (c) { c.classList.remove('ova-shake'); void c.offsetWidth; c.classList.add('ova-shake'); } };
  const digits = (el) => el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 8); });

  function render() {
    const ov = overlay();
    const vault = lsGet(LS.vault);
    if (!vault) return renderSetup(ov);
    const bio = lsGet(LS.bio);
    const twoStep = vault.v === 2;
    ov.innerHTML = `<div class="ova-card">${header(twoStep ? 'Private portal · two-step' : 'Private portal')}
      <label class="ova-label" for="ova-pin">${twoStep ? 'Step 1: enter your 8-digit PIN' : 'Enter your 8-digit PIN'}</label>
      <input id="ova-pin" class="ova-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN">
      <button type="button" class="ova-btn" id="ova-unlock">${twoStep ? 'Step 2: Touch ID' : 'Unlock'}</button>
      <div class="ova-or" id="ova-or" hidden><span>or</span></div>
      <button type="button" class="ova-btn ghost" id="ova-bio" hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 11v3M8.5 7.5a5 5 0 0 1 8.5 3.5v2a9 9 0 0 1-1 4M7 12a5 5 0 0 1 .3-1.7M7 15.5a12 12 0 0 0 .9 3.5M10 20.5A13 13 0 0 1 9 14v-3a3 3 0 0 1 6 0v1M4 9a9 9 0 0 1 14.5-3.4M20.6 12a9 9 0 0 1 .1 1.3M3.3 13a9 9 0 0 0 .2 2"/></svg>
        <span>Unlock with Touch ID / Face ID</span></button>
      <div class="ova-hint" id="ova-hint" aria-live="polite"></div>
      <button type="button" class="ova-link" id="ova-forget">Forget this device</button>
    </div>`;
    tick();
    const pin = $('#ova-pin');
    digits(pin);
    const go = async () => {
      const left = waitLeft();
      if (left) { hint(`Too many wrong PINs. Try again in ${left}s.`, 'err'); return; }
      if (pin.value.length !== 8) { hint('Enter all 8 digits.', 'err'); shake(); return; }
      const b = $('#ova-unlock'); b.disabled = true; hint(twoStep ? 'Now touch the sensor…' : 'Unlocking…');
      try { startSession(await openVault(pin.value)); }
      catch (e) {
        if (twoStep && e.name === 'NotAllowedError') { hint('Touch ID was cancelled. Both steps are needed to unlock.', 'err'); }
        else if (e.name === 'NoPrfError') { hint(e.message, 'err'); }
        else { recordFail(); pin.value = ''; shake(); const l = waitLeft(); hint((twoStep ? 'PIN or fingerprint didn\'t match.' : 'Wrong PIN.') + (l ? ` Wait ${l}s.` : ''), 'err'); pin.focus(); }
      }
      finally { b.disabled = false; }
    };
    $('#ova-unlock').onclick = go;
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    pin.addEventListener('input', () => { if (pin.value.length === 8) go(); });
    if (!twoStep && bio && !bio.pending && bio.ct) {
      bioAvailable().then((ok) => { if (!ok) return; $('#ova-bio').hidden = false; $('#ova-or').hidden = false; });
      $('#ova-bio').onclick = async () => {
        hint('Waiting for Touch ID…');
        try { startSession(await bioUnlock()); }
        catch (e) {
          if (e.name === 'NotAllowedError') hint('Touch ID cancelled. Use your PIN.', 'err');
          else if (e.name === 'OperationError') { hint('Touch ID didn\'t match this device\'s setup. Use your PIN.', 'err'); shake(); }
          else hint(e.message || 'Touch ID failed. Use your PIN.', 'err');
        }
      };
    }
    $('#ova-forget').onclick = () => {
      if (!confirm('Remove the saved key and Touch ID from this browser? You will need your owner key to set it up again.')) return;
      lsSet(LS.vault, null); lsSet(LS.bio, null); lsSet(LS.twostep, null); lsSet(LS.fails, null); ssSet(null); render();
    };
    setTimeout(() => pin.focus(), 50);
  }

  function renderSetup(ov) {
    ov.innerHTML = `<div class="ova-card">${header('Set up this device')}
      <p class="ova-sub" style="margin:0">Paste your owner key once. It is encrypted with your PIN and stored only in this browser, never on the website.</p>
      <label class="ova-label" for="ova-key">Owner key</label>
      <input id="ova-key" class="ova-input text" type="password" autocomplete="off" spellcheck="false" placeholder="ova_…">
      <label class="ova-label" for="ova-pin1">Choose an 8-digit PIN</label>
      <input id="ova-pin1" class="ova-input" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8">
      <label class="ova-label" for="ova-pin2">Repeat PIN</label>
      <input id="ova-pin2" class="ova-input" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8">
      <button type="button" class="ova-btn" id="ova-save">Encrypt and lock</button>
      <div class="ova-hint" id="ova-hint" aria-live="polite"></div>
    </div>`;
    tick();
    digits($('#ova-pin1')); digits($('#ova-pin2'));
    $('#ova-save').onclick = async () => {
      const key = $('#ova-key').value.trim(); const p1 = $('#ova-pin1').value; const p2 = $('#ova-pin2').value;
      if (!KEY_RE.test(key)) return hint('That doesn\'t look like an Open Verse Ai key (ova_ + 43 characters).', 'err');
      if (p1.length !== 8) return hint('The PIN must be 8 digits.', 'err');
      if (p1 !== p2) return hint('The PINs don\'t match.', 'err');
      const b = $('#ova-save'); b.disabled = true; hint('Checking key…');
      try {
        const api = window.OVA_CONFIG.API_BASE.replace(/\/$/, '');
        const r = await fetch(api + '/v1/me', { headers: { Authorization: 'Bearer ' + key } });
        const me = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((me.error && me.error.message) || `API returned ${r.status}`);
        if (me.scope !== 'owner') throw new Error('That is a public key. Use your owner key.');
        hint('Encrypting…');
        await createVault(key, p1, me.prefix);
        startSession(key);
      } catch (e) { hint(e.message, 'err'); } finally { b.disabled = false; }
    };
    setTimeout(() => $('#ova-key').focus(), 50);
  }

  // Header buttons once unlocked: Lock, and Touch ID setup if not done yet.
  async function renderNav() {
    const wrap = $('header.nav .wrap');
    if (!wrap) return;
    let box = $('#ova-nav');
    if (!box) { box = document.createElement('span'); box.id = 'ova-nav'; box.style.display = 'flex'; box.style.gap = '8px'; wrap.append(box); }
    box.innerHTML = '';
    const vault = lsGet(LS.vault);
    if (vault && vault.v === 2) {
      const on = document.createElement('span');
      on.className = 'ova-nav-btn'; on.style.cursor = 'default'; on.textContent = '🔒 Two-step on';
      on.title = 'Unlocking needs your PIN and Touch ID together';
      box.append(on);
    } else if (await bioAvailable()) {
      const pending = lsGet(LS.twostep);
      const tb = document.createElement('button');
      tb.className = 'ova-nav-btn';
      tb.textContent = pending && pending.pending ? 'Finish two-step setup' : 'Turn on two-step';
      tb.title = 'Require PIN + Touch ID to unlock';
      tb.onclick = async () => {
        try {
          if (!lsGet(LS.twostep)) {
            await twoStepStep1();
            tb.textContent = 'Finish two-step setup';
            alert('Step 1 done. Now tap "Finish two-step setup", enter your PIN, and touch the sensor once more.');
            return;
          }
          const pin = await askPin('Enter your PIN to finish two-step setup');
          if (!pin) return;
          await twoStepStep2(pin);
          alert('Two-step is on. From now on, unlocking needs your PIN and Touch ID together.');
          renderNav();
        } catch (e) {
          if (e.name === 'NoPrfError') { lsSet(LS.twostep, null); alert(e.message); renderNav(); }
          else if (e.name === 'NotAllowedError') alert('Touch ID was cancelled. Nothing changed.');
          else if (e.name === 'OperationError') alert('That PIN is not correct. Nothing changed.');
          else alert('Two-step setup failed: ' + e.message + '. Nothing changed.');
        }
      };
      box.append(tb);
    }
    const lb = document.createElement('button');
    lb.className = 'ova-nav-btn'; lb.textContent = 'Lock'; lb.onclick = lock;
    box.append(lb);
  }

  // Small PIN dialog (masked input), used to confirm the PIN when turning on two-step.
  function askPin(title) {
    return new Promise((resolve) => {
      const d = document.createElement('div');
      d.id = 'ova-lock'; d.className = 'ova-ask'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
      d.style.background = 'rgba(0,0,0,.45)';
      d.innerHTML = `<div class="ova-card"><div class="ova-title" style="font-size:17px">${title}</div>
        <input class="ova-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN">
        <button type="button" class="ova-btn">Continue</button>
        <button type="button" class="ova-link">Cancel</button></div>`;
      const existing = $('#ova-lock'); if (existing) existing.id = 'ova-lock-hidden';
      document.body.append(d);
      const input = d.querySelector('input'); digits(input);
      const done = (v) => { d.remove(); const h = $('#ova-lock-hidden'); if (h) h.id = 'ova-lock'; resolve(v); };
      d.querySelector('.ova-btn').onclick = () => { if (input.value.length === 8) done(input.value); else input.focus(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.length === 8) done(input.value); if (e.key === 'Escape') done(null); });
      d.querySelector('.ova-link').onclick = () => done(null);
      setTimeout(() => input.focus(), 30);
    });
  }

  window.OVA = { key: () => ownerKey, lock, onUnlock: (fn) => { listeners.push(fn); if (ownerKey) fn(ownerKey); } };

  function boot() {
    const s = ssGet();
    const fresh = s && s.key && Date.now() - (s.at || 0) < IDLE_MS && lsGet(LS.vault);
    if (fresh) startSession(s.key); else { ssSet(null); render(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
