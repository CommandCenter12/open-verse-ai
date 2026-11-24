// Open Verse Ai Chrome extension popup.
// - Owner key encrypted with an 8-digit PIN (PBKDF2-SHA256 600k → AES-GCM), stored in chrome.storage.local.
// - While unlocked, the key sits in chrome.storage.session (memory only, gone when Chrome closes) for 15 minutes.
// - The page is read ONLY when you ask (activeTab + scripting), and sent as an attachment the API treats as data.
(() => {
  const DEFAULT_API = 'https://open-verse-ai.boukeilehm.workers.dev';
  const CHAT_PAGE = 'https://commandcenter12.github.io/open-verse-ai/chat.html';
  const ITER = 600000, UNLOCK_MS = 15 * 60 * 1000, MAX_PAGE_CHARS = 15000;
  const KEY_RE = /^ova_[A-Za-z0-9_-]{43}$/;
  const $ = (s) => document.querySelector(s);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const store = chrome.storage.local, session = chrome.storage.session;
  const status = (t, kind = '') => { $('#status').textContent = t; $('#status').className = 'status ' + kind; };
  let apiBase = DEFAULT_API, ownerKey = null, think = false;

  // ---------- crypto (same scheme as the website lock screen) ----------
  async function pinKey(pin, salt, iter = ITER) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function saveVault(key, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), enc.encode(key)));
    await store.set({ vault: { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) }, fails: 0 });
  }
  async function openVault(pin) {
    const { vault } = await store.get('vault');
    const k = await pinKey(pin, unb64(vault.salt), vault.iter);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, k, unb64(vault.ct))); // throws if wrong
  }

  // ---------- screens ----------
  function show(id) {
    for (const s of ['setup', 'locked', 'main']) $('#' + s).hidden = s !== id;
    $('#lock').hidden = id !== 'main';
    const focus = { setup: '#key', locked: '#pin', main: '#question' }[id];
    setTimeout(() => $(focus) && $(focus).focus(), 30);
  }
  async function start() {
    const cfg = await store.get(['apiBase', 'vault']);
    if (cfg.apiBase) apiBase = cfg.apiBase; // only set for local testing
    if (!cfg.vault) return show('setup');
    const s = await session.get(['key', 'at']);
    if (s.key && Date.now() - (s.at || 0) < UNLOCK_MS) { ownerKey = s.key; await session.set({ at: Date.now() }); return enterMain(); }
    await session.remove(['key', 'at']);
    show('locked');
  }
  async function enterMain() {
    show('main');
    const tab = await activeTab();
    $('#page-title').textContent = tab ? (tab.title || tab.url || 'This page') : 'No page';
    if (tab && !canRead(tab.url)) { $('#page').classList.add('blocked'); $('#page-title').textContent = "Chrome doesn't let extensions read this page"; $('#use-page').checked = false; }
  }

  // ---------- setup / unlock / lock ----------
  const digits = (el) => el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 8); });
  ['#pin1', '#pin2', '#pin'].forEach((s) => digits($(s)));
  $('#save').addEventListener('click', async () => {
    const key = $('#key').value.trim(), p1 = $('#pin1').value, p2 = $('#pin2').value;
    if (!KEY_RE.test(key)) return status("That doesn't look like an Open Verse Ai key.", 'err');
    if (p1.length !== 8) return status('The PIN must be 8 digits.', 'err');
    if (p1 !== p2) return status("The PINs don't match.", 'err');
    $('#save').disabled = true; status('Checking key…');
    try {
      const r = await fetch(apiBase + '/v1/me', { headers: { Authorization: 'Bearer ' + key } });
      const me = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((me.error && me.error.message) || `API returned ${r.status}`);
      if (me.scope !== 'owner') throw new Error('That is a public key. Use your owner key.');
      status('Encrypting…');
      await saveVault(key, p1);
      ownerKey = key; await session.set({ key, at: Date.now() });
      $('#key').value = $('#pin1').value = $('#pin2').value = '';
      status('Saved. Ask away!', 'ok'); enterMain();
    } catch (e) { status(e.message, 'err'); } finally { $('#save').disabled = false; }
  });
  async function unlock() {
    const { fails = 0, until = 0 } = await store.get(['fails', 'until']);
    if (until > Date.now()) return status(`Too many wrong PINs. Try again in ${Math.ceil((until - Date.now()) / 1000)}s.`, 'err');
    const pin = $('#pin').value;
    if (pin.length !== 8) return status('Enter all 8 digits.', 'err');
    $('#unlock').disabled = true; status('Unlocking…');
    try {
      ownerKey = await openVault(pin);
      await store.set({ fails: 0, until: 0 }); await session.set({ key: ownerKey, at: Date.now() });
      $('#pin').value = ''; status(''); enterMain();
    } catch {
      const n = fails + 1;
      await store.set({ fails: n, until: n >= 5 ? Date.now() + Math.min(3600, 30 * 2 ** (n - 5)) * 1000 : 0 });
      $('#pin').value = ''; status(n >= 5 ? 'Wrong PIN. Wait 30s or more.' : 'Wrong PIN.', 'err');
    } finally { $('#unlock').disabled = false; }
  }
  $('#unlock').addEventListener('click', unlock);
  $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('#pin').addEventListener('input', () => { if ($('#pin').value.length === 8) unlock(); });
  $('#lock').addEventListener('click', async () => { ownerKey = null; await session.remove(['key', 'at']); $('#answer').hidden = true; status('Locked.'); show('locked'); });
  $('#forget').addEventListener('click', async () => {
    if (!confirm('Remove the saved key from this extension? You will need your owner key to set it up again.')) return;
    await store.remove(['vault', 'fails', 'until']); await session.remove(['key', 'at']); status(''); show('setup');
  });

  // ---------- reading the page ----------
  async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t || null; }
  function canRead(url) { return /^(https?|file):/i.test(url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url); }
  async function readPage() {
    const tab = await activeTab();
    if (!tab || !canRead(tab.url)) throw new Error("Chrome doesn't let extensions read this page.");
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Runs in the page: highlighted text if any, else the visible text of the page.
      func: () => {
        const sel = String(window.getSelection ? window.getSelection() : '').trim();
        const text = sel || (document.body ? document.body.innerText : '');
        return { title: document.title, url: location.href, selection: Boolean(sel), text };
      },
    });
    const p = res && res.result;
    if (!p || !p.text || !p.text.trim()) throw new Error('This page has no readable text.');
    const clean = p.text.replace(/\n{3,}/g, '\n\n').trim();
    return { ...p, text: clean.slice(0, MAX_PAGE_CHARS), cut: clean.length > MAX_PAGE_CHARS };
  }

  // ---------- asking ----------
  async function api(path, body) {
    const r = await fetch(apiBase + path, { method: 'POST', headers: { Authorization: 'Bearer ' + ownerKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { await session.remove(['key', 'at']); show('locked'); throw new Error('Session ended. Unlock again.'); }
    if (!r.ok) throw new Error((d.error && d.error.message) || `Request failed (HTTP ${r.status}).`);
    return d;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Tiny, safe formatter: escape first, then bold / code / bullets / headings / paragraphs.
  function format(text) {
    const lines = esc(text).split('\n');
    let html = '', inList = false;
    for (const raw of lines) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${bullet[1]}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (h) html += `<p><b>${h[1]}</b></p>`;
      else if (line.trim()) html += `<p>${line}</p>`;
    }
    return html + (inList ? '</ul>' : '');
  }
  async function ask(question) {
    question = question.trim();
    if (!question) return status('Type a question or tap a button.', 'err');
    if (question.length > 500) return status('Questions can be up to 500 characters.', 'err');
    $('#ask').disabled = true; $('#answer').hidden = true;
    try {
      const body = { question, ...(think ? { model: 'plus' } : {}) };
      let page = null;
      if ($('#use-page').checked) {
        status('Reading the page…');
        page = await readPage();
        body.attachments = [{ name: `${page.selection ? 'Highlighted text from' : 'Web page'}: ${page.title || page.url}`.slice(0, 100), text: `URL: ${page.url}\n\n${page.text}` }];
      }
      if ($('#save-chat').checked) {
        const c = await api('/v1/chats', {});
        body.chat_id = c.id;
      }
      status(think ? 'Thinking with Qwen + Llama + Gemma (up to a minute)…' : 'Thinking…');
      const r = await api('/v1/ask', body);
      const who = r.model === 'plus' ? 'Open Source+' : r.model || (r.mode === 'docs' ? 'your docs' : '');
      $('#answer').innerHTML = format(r.answer || r.message || 'No answer.') +
        `<div class="meta">${esc([who && `Answered by ${who}`, page && `read ${page.selection ? 'your highlighted text' : 'this page'}${page.cut ? ' (first 15,000 characters)' : ''}`].filter(Boolean).join(' · '))}` +
        (r.chat_id ? ` · <a href="${CHAT_PAGE}?chat=${encodeURIComponent(r.chat_id)}" target="_blank" rel="noopener">Continue in chat</a>` : '') + '</div>';
      $('#answer').hidden = false; status('');
      await session.set({ at: Date.now() });
    } catch (e) { status(e.message, 'err'); } finally { $('#ask').disabled = false; }
  }
  $('#ask').addEventListener('click', () => ask($('#question').value));
  $('#question').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#question').value); } });
  document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { $('#question').value = b.dataset.q; ask(b.dataset.q); }));
  $('#think').addEventListener('click', () => { think = !think; $('#think').setAttribute('aria-pressed', String(think)); });

  start().catch((e) => status(e.message, 'err'));
})();
