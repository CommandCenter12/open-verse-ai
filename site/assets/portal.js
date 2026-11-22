(() => {
  const API = window.OVA_CONFIG.API_BASE.replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);

  function setStatus(el, text, kind = '') {
    el.textContent = text;
    el.className = 'status ' + kind;
  }

  async function call(path, { method = 'GET', key, body } = {}) {
    const headers = {};
    if (key) headers.Authorization = 'Bearer ' + key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Could not reach the API at ' + API + '. Check API_BASE in assets/config.js and the CORS origins.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      let msg = (data && data.error && data.error.message) || 'Request failed (HTTP ' + res.status + ').';
      const retry = res.headers.get('Retry-After');
      if (res.status === 429 && retry) msg += ' Try again in ' + retry + 's.';
      if (res.status === 401 && data && data.error && data.error.code === 'session_expired') setSession(null);
      throw new Error(msg);
    }
    return data;
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  // ---------- Passkey session (kept for this tab only; cleared on sign-out or expiry) ----------
  let session = null;
  try {
    const s = JSON.parse(sessionStorage.getItem('ova_session') || 'null');
    if (s && Date.parse(s.expires_at) > Date.now()) session = s;
  } catch { /* storage unavailable */ }
  function setSession(s) {
    session = s;
    try { s ? sessionStorage.setItem('ova_session', JSON.stringify(s)) : sessionStorage.removeItem('ova_session'); } catch { /* ignore */ }
    $('signed-out').hidden = Boolean(s);
    $('signed-in').hidden = !s;
    $('session-info').textContent = s ? `until ${new Date(s.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    $('pk-items').replaceChildren();
  }

  function currentKey(statusEl) {
    const k = $('key').value.trim();
    if (k) return k;
    if (session && Date.parse(session.expires_at) > Date.now()) return session.token;
    if (session) setSession(null);
    setStatus(statusEl, 'Paste an API key first, or sign in with Touch ID.', 'warn');
    return null;
  }

  // ---------- WebAuthn JSON <-> browser objects ----------
  const b64urlToBuf = (s) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
  };
  const bufToB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function creationOptions(o) {
    if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
    return { ...o, challenge: b64urlToBuf(o.challenge), user: { ...o.user, id: b64urlToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })) };
  }
  function requestOptions(o) {
    if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
    return { ...o, challenge: b64urlToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })) };
  }
  function credentialJSON(c) {
    if (typeof c.toJSON === 'function') return c.toJSON();
    const r = c.response;
    const response = { clientDataJSON: bufToB64url(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = bufToB64url(r.attestationObject);
      if (r.getTransports) response.transports = r.getTransports();
    } else {
      response.authenticatorData = bufToB64url(r.authenticatorData);
      response.signature = bufToB64url(r.signature);
      if (r.userHandle) response.userHandle = bufToB64url(r.userHandle);
    }
    return { id: c.id, rawId: bufToB64url(c.rawId), type: c.type, response,
      authenticatorAttachment: c.authenticatorAttachment || undefined, clientExtensionResults: c.getClientExtensionResults() };
  }
  function passkeyError(err) {
    if (err && err.name === 'NotAllowedError') return 'Cancelled, or no passkey for this site on this device.';
    if (err && err.name === 'InvalidStateError') return 'This device is already registered.';
    return err && err.message ? err.message : String(err);
  }

  const pkStatus = $('pk-status');
  if (!window.PublicKeyCredential) {
    $('pk-login').disabled = true; $('pk-register').disabled = true;
    setStatus(pkStatus, 'This browser does not support passkeys.', 'warn');
  }
  setSession(session);

  $('pk-login').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    setStatus(pkStatus, 'Waiting for Touch ID…');
    try {
      const opts = await call('/v1/passkeys/login/options', { method: 'POST', body: {} });
      const cred = await navigator.credentials.get({ publicKey: requestOptions(opts) });
      const s = await call('/v1/passkeys/login/verify', { method: 'POST', body: { response: credentialJSON(cred) } });
      setSession({ token: s.token, expires_at: s.expires_at });
      setStatus(pkStatus, `Signed in with ${s.passkey}. Questions below now use your owner access.`, 'ok');
    } catch (err) { setStatus(pkStatus, passkeyError(err), 'err'); }
  }));

  $('pk-logout').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try { if (session) await call('/v1/sessions/current', { method: 'DELETE', key: session.token }); } catch { /* already expired */ }
    setSession(null);
    setStatus(pkStatus, 'Signed out.', 'ok');
  }));

  $('pk-register').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const owner = $('pk-owner').value.trim();
    if (!owner) { setStatus(pkStatus, 'Paste your owner key first.', 'warn'); return; }
    setStatus(pkStatus, 'Follow the Touch ID prompt…');
    try {
      const opts = await call('/v1/passkeys/register/options', { method: 'POST', key: owner, body: {} });
      const cred = await navigator.credentials.create({ publicKey: creationOptions(opts) });
      const r = await call('/v1/passkeys/register/verify', { method: 'POST', key: owner, body: { response: credentialJSON(cred), label: $('pk-label').value.trim() } });
      $('pk-owner').value = '';
      setStatus(pkStatus, `Registered${r.label ? ` "${r.label}"` : ''}${r.synced ? ' (synced passkey: works on your other Apple devices too)' : ''}. Now use "Sign in with Touch ID".`, 'ok');
    } catch (err) { setStatus(pkStatus, passkeyError(err), 'err'); }
  }));

  $('pk-list').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const { passkeys } = await call('/v1/passkeys', { key: session && session.token });
      $('pk-items').replaceChildren(...passkeys.map((p) => {
        const li = document.createElement('li');
        li.textContent = `${p.label || p.id.slice(0, 10)} · ${p.synced ? 'synced' : 'this device only'} · last used ${p.last_used_at ? new Date(p.last_used_at).toLocaleString() : 'never'}`;
        return li;
      }));
      setStatus(pkStatus, passkeys.length ? 'To remove one, use DELETE /v1/passkeys/<id> with your owner key.' : 'No passkeys.', '');
    } catch (err) { setStatus(pkStatus, err.message, 'err'); }
  }));

  $('create').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    setStatus($('create-status'), 'Creating…');
    try {
      const label = $('label').value.trim();
      const data = await call('/v1/keys', { method: 'POST', body: label ? { label } : {} });
      $('newkey').textContent = data.key;
      $('created').hidden = false;
      setStatus($('create-status'), data.note, 'ok');
    } catch (err) { setStatus($('create-status'), err.message, 'err'); }
  }));

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('newkey').textContent);
      setStatus($('create-status'), 'Copied.', 'ok');
    } catch { setStatus($('create-status'), 'Copy failed. Select the key and copy it manually.', 'warn'); }
  });

  $('usekey').addEventListener('click', () => { $('key').value = $('newkey').textContent; $('question').focus(); });

  $('ask').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = $('ask-status');
    const key = currentKey(st); if (!key) return;
    const question = $('question').value.trim();
    if (!question) { setStatus(st, 'Type a question.', 'warn'); return; }
    setStatus(st, 'Searching the knowledge base…');
    $('result').hidden = true;
    try {
      const r = await call('/v1/ask', { method: 'POST', key, body: { question } });
      $('sources').replaceChildren();
      if (r.answered) {
        $('answer').textContent = r.answer;
        const label = { docs: 'From the knowledge base', math: 'Calculated', general: 'General AI answer (' + r.model + '), not from the docs' }[r.mode] || r.mode;
        $('confidence').textContent = label + ' · confidence: ' + r.confidence;
        for (const s of r.sources) {
          const li = document.createElement('li');
          const title = document.createElement(s.url ? 'a' : 'strong');
          title.textContent = s.title + ' › ' + s.section;
          if (s.url) { title.href = s.url; title.target = '_blank'; title.rel = 'noopener'; }
          const ex = document.createElement('div');
          ex.className = 'meta';
          ex.textContent = s.excerpt;
          li.append(title, ex);
          $('sources').append(li);
        }
        setStatus(st, '');
      } else {
        $('answer').textContent = r.message;
        const topics = (r.nearest_topics || []).length ? 'Nearest topics: ' + r.nearest_topics.join('; ') : '';
        $('confidence').textContent = [topics, r.general_unavailable ? 'General answer unavailable: ' + r.general_unavailable : ''].filter(Boolean).join(' · ');
        setStatus(st, 'No grounded answer found.', 'warn');
      }
      $('disclaimer').textContent = [r.note, r.disclaimer].filter(Boolean).join(' ');
      $('result').hidden = false;
    } catch (err) { setStatus(st, err.message, 'err'); }
  }));

  $('me').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = $('ask-status');
    const key = currentKey(st); if (!key) return;
    try {
      const m = await call('/v1/me', { key });
      const g = m.usage.general_day ? ` · ${m.usage.general_day.used}/${m.usage.general_day.limit} AI answers today` : '';
      setStatus(st, `${m.prefix}… · ${m.usage.minute.used}/${m.usage.minute.limit} this minute · ${m.usage.day.used}/${m.usage.day.limit} today${g}`, 'ok');
    } catch (err) { setStatus(st, err.message, 'err'); }
  }));

  $('revoke').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = $('ask-status');
    const key = currentKey(st); if (!key) return;
    if (!confirm('Revoke this key? Apps using it will stop working immediately. This cannot be undone.')) return;
    try {
      const r = await call('/v1/keys/current', { method: 'DELETE', key });
      $('key').value = '';
      setStatus(st, 'Revoked ' + r.prefix + '…', 'ok');
    } catch (err) { setStatus(st, err.message, 'err'); }
  }));
})();
