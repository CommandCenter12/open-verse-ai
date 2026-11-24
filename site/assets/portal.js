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

  // The lock screen (lock.js) holds the decrypted owner key for this tab.
  function currentKey(statusEl) {
    const k = $('key').value.trim();
    if (k) return k;
    const owner = window.OVA && window.OVA.key();
    if (owner) return owner;
    setStatus(statusEl, 'Locked. Unlock with your PIN or Touch ID.', 'warn');
    return null;
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

  $('usekey').addEventListener('click', () => { $('key').value = $('newkey').textContent; $('key').closest('details').open = true; $('question').focus(); });

  $('ask').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const st = $('ask-status');
    const key = currentKey(st); if (!key) return;
    const question = $('question').value.trim();
    if (!question) { setStatus(st, 'Type a question.', 'warn'); return; }
    setStatus(st, 'Searching the knowledge base…');
    $('result').hidden = true;
    try {
      const model = $('model') ? $('model').value : 'auto';
      const r = await call('/v1/ask', { method: 'POST', key, body: model === 'auto' ? { question } : { question, model } });
      $('sources').replaceChildren();
      if (r.answered) {
        $('answer').textContent = r.answer;
        $('original-wrap').hidden = !r.original_answer;
        $('original').textContent = r.original_answer || '';
        const label = {
          docs: 'From the knowledge base',
          math: 'Calculated',
          live: 'Live data (' + (r.live_data || []).map((d) => d.source).filter(Boolean).join(', ') + ')',
          memory: 'Memory',
          general: 'AI answer (' + (r.model === 'plus' ? 'Open Source+: ' + (r.contributors || []).map((c) => c.model.split('-')[0] + (c.ok ? ' ✓' : ' ✗')).join(', ') : r.model) + ')' + (r.calculations ? ', numbers computed exactly' : '') + ', not from the docs',
        }[r.mode] || r.mode;
        const by = r.fallback_from ? ' · ' + r.fallback_from + ' was unavailable, answered by ' + r.model : '';
        $('confidence').textContent = label + ' · confidence: ' + r.confidence + (r.learned ? ' · saved to memory' : '') + by;
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
    // Only ever revoke a key pasted explicitly, never the unlocked owner key.
    const key = $('key').value.trim();
    if (!key) { $('key').closest('details').open = true; setStatus(st, 'Paste the key to revoke under "Use a different API key". Your owner key is never revoked from here.', 'warn'); return; }
    if (window.OVA && key === window.OVA.key()) { setStatus(st, 'That is your owner key. It can\'t be revoked from the portal.', 'err'); return; }
    if (!confirm('Revoke this key? Apps using it will stop working immediately. This cannot be undone.')) return;
    try {
      const r = await call('/v1/keys/current', { method: 'DELETE', key });
      $('key').value = '';
      setStatus(st, 'Revoked ' + r.prefix + '…', 'ok');
    } catch (err) { setStatus(st, err.message, 'err'); }
  }));
})();
