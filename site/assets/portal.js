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
      throw new Error(msg);
    }
    return data;
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  function currentKey(statusEl) {
    const k = $('key').value.trim();
    if (!k) { setStatus(statusEl, 'Paste an API key first.', 'warn'); return null; }
    return k;
  }

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
        $('confidence').textContent = 'Confidence: ' + r.confidence;
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
        $('confidence').textContent = r.nearest_topics.length ? 'Nearest topics: ' + r.nearest_topics.join('; ') : '';
        setStatus(st, 'No grounded answer found.', 'warn');
      }
      $('disclaimer').textContent = r.disclaimer || '';
      $('result').hidden = false;
    } catch (err) { setStatus(st, err.message, 'err'); }
  }));

  $('me').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = $('ask-status');
    const key = currentKey(st); if (!key) return;
    try {
      const m = await call('/v1/me', { key });
      setStatus(st, `${m.prefix}… · ${m.usage.minute.used}/${m.usage.minute.limit} this minute · ${m.usage.day.used}/${m.usage.day.limit} today`, 'ok');
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
