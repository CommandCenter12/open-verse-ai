// Open Verse Ai chat page: saved chats (D1 via the Worker), folders, pins, model choice,
// memory toggle, markdown/code/math rendering. Needs the unlocked owner key from lock.js.
(() => {
  const API = window.OVA_CONFIG.API_BASE.replace(/\/$/, '');
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const LS = { collapsed: 'ova.chat.collapsed', closedFolders: 'ova.chat.closedFolders', model: 'ova.chat.model', memory: 'ova.chat.memory' };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

  const MODEL_NAMES = {
    'qwen3.8-27b': 'Qwen 3.8 27B', 'gemma-4-26b-a4b-it': 'Gemma 4 26B', 'llama-4-scout-17b-16e-instruct': 'Llama 4 Scout',
    'llama-3.3-70b-instruct-fp8-fast': 'Llama 3.3 70B', 'mistral-small-3.1-24b-instruct': 'Mistral Small 3.1',
    plus: 'Open Source+',
  };
  const prettyModel = (m) => MODEL_NAMES[m] || m || '';

  const state = { folders: [], chats: [], activeId: null, pendingFolder: null, busy: false, closed: new Set(lsGet(LS.closedFolders, [])) };

  // ---------- API ----------
  async function api(path, { method = 'GET', body } = {}) {
    const key = window.OVA && window.OVA.key();
    if (!key) { window.OVA && window.OVA.lock(); throw new Error('Locked'); }
    let res;
    try {
      res = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new Error('Could not reach the Open Verse Ai API.'); }
    const data = await res.json().catch(() => null);
    if (res.status === 401) { window.OVA.lock(); throw new Error('Session ended. Unlock again.'); }
    if (!res.ok) {
      let msg = (data && data.error && data.error.message) || `Request failed (HTTP ${res.status}).`;
      const retry = res.headers.get('Retry-After');
      if (res.status === 429 && retry) msg += ` Try again in ${retry}s.`;
      throw new Error(msg);
    }
    return data;
  }

  // ---------- sidebar ----------
  function dayGroup(iso) {
    const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = (t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'Previous 7 Days';
    if (diff < 30) return 'Previous 30 Days';
    return 'Older';
  }
  const dots = () => el('span', { 'aria-hidden': 'true', text: '⋯' });
  function chatItem(c) {
    const item = el('div', { class: 'item' + (c.id === state.activeId ? ' active' : ''), role: 'button', tabindex: '0', 'data-id': c.id, title: c.title },
      c.pinned ? el('span', { 'aria-hidden': 'true', text: '📌' }) : null,
      el('span', { class: 't', text: c.title }),
      el('button', { class: 'icon-btn more', 'aria-label': `Options for ${c.title}`, onclick: (e) => { e.stopPropagation(); chatMenu(c, e.currentTarget); } }, dots()));
    item.addEventListener('click', () => openChat(c.id));
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') openChat(c.id); });
    return item;
  }
  function section(title, kids, action) {
    return el('div', { class: 'sec' }, el('div', { class: 'sec-head' }, el('span', { text: title }), action || null), ...kids);
  }
  function renderSidebar() {
    const list = $('#side-list');
    list.replaceChildren();
    const pinned = state.chats.filter((c) => c.pinned);
    if (pinned.length) list.append(section('Pinned', pinned.map(chatItem)));

    const folderNodes = state.folders.map((f) => {
      const kids = state.chats.filter((c) => c.folder_id === f.id && !c.pinned);
      const closed = state.closed.has(f.id);
      const head = el('div', { class: 'item', role: 'button', tabindex: '0', 'aria-expanded': String(!closed) },
        el('svg', { class: 'chev', width: '12', height: '12', viewBox: '0 0 24 24' }),
        el('span', { 'aria-hidden': 'true', text: '📁' }),
        el('span', { class: 't', text: f.name }),
        el('button', { class: 'icon-btn more', title: `New chat in ${f.name}`, 'aria-label': `New chat in ${f.name}`, onclick: (e) => { e.stopPropagation(); newChat(f.id); } }, el('span', { text: '+' })),
        el('button', { class: 'icon-btn more', 'aria-label': `Options for folder ${f.name}`, onclick: (e) => { e.stopPropagation(); folderMenu(f, e.currentTarget); } }, dots()));
      head.querySelector('.chev').innerHTML = '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
      const toggle = () => { closed ? state.closed.delete(f.id) : state.closed.add(f.id); lsSet(LS.closedFolders, [...state.closed]); renderSidebar(); };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });
      return el('div', { class: 'folder' + (closed ? ' closed' : '') }, head,
        el('div', { class: 'kids' }, ...(kids.length ? kids.map(chatItem) : [el('div', { class: 'empty-note', text: 'No chats yet' })])));
    });
    list.append(section('Folders', folderNodes.length ? folderNodes : [el('div', { class: 'empty-note', text: 'Make folders like "Math" to group chats.' })],
      el('button', { class: 'link-btn', onclick: () => createFolder() }, el('span', { text: '+ New folder' }))));

    const recent = state.chats.filter((c) => !c.pinned && !c.folder_id);
    const groups = new Map();
    for (const c of recent) { const g = dayGroup(c.updated_at); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const recentKids = [];
    for (const [g, cs] of groups) recentKids.push(el('div', { class: 'group-label', text: g }), ...cs.map(chatItem));
    list.append(section('Recent', recentKids.length ? recentKids : [el('div', { class: 'empty-note', text: 'Your chats will show up here.' })]));
  }

  // ---------- menus + modal ----------
  const menu = $('#menu');
  function openMenu(anchor, entries) {
    menu.replaceChildren(...entries);
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(r.left, innerWidth - w - 8) + 'px';
    menu.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    setTimeout(() => menu.querySelector('button') && menu.querySelector('button').focus(), 0);
  }
  const closeMenu = () => { menu.hidden = true; };
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeModal(null); } });
  const mItem = (label, fn, cls) => el('button', { class: cls || '', role: 'menuitem', onclick: async () => { closeMenu(); try { await fn(); } catch (err) { toastErr(err); } } }, el('span', { text: label }));

  let modalResolve = null;
  function prompt(label, value = '') {
    $('#modal-label').textContent = label;
    $('#modal-input').value = value;
    $('#modal').hidden = false;
    setTimeout(() => { $('#modal-input').focus(); $('#modal-input').select(); }, 0);
    return new Promise((res) => { modalResolve = res; });
  }
  function closeModal(v) { if ($('#modal').hidden) return; $('#modal').hidden = true; const r = modalResolve; modalResolve = null; r && r(v); }
  $('#modal-ok').onclick = () => closeModal($('#modal-input').value.trim() || null);
  $('#modal-cancel').onclick = () => closeModal(null);
  $('#modal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closeModal($('#modal-input').value.trim() || null); } });

  function chatMenu(c, anchor) {
    const entries = [
      mItem(c.pinned ? 'Unpin' : 'Pin', async () => { await api(`/v1/chats/${c.id}`, { method: 'PATCH', body: { pinned: !c.pinned } }); await loadList(); }),
      mItem('Rename', async () => { const t = await prompt('Rename chat', c.title); if (!t) return; await api(`/v1/chats/${c.id}`, { method: 'PATCH', body: { title: t } }); await loadList(); }),
      el('hr'), el('div', { class: 'sub-label', text: 'Move to folder' }),
      ...state.folders.filter((f) => f.id !== c.folder_id).map((f) => mItem('📁 ' + f.name, async () => { await api(`/v1/chats/${c.id}`, { method: 'PATCH', body: { folder_id: f.id } }); await loadList(); })),
      c.folder_id ? mItem('No folder', async () => { await api(`/v1/chats/${c.id}`, { method: 'PATCH', body: { folder_id: null } }); await loadList(); }) : null,
      mItem('+ New folder…', async () => { const f = await createFolder(); if (f) { await api(`/v1/chats/${c.id}`, { method: 'PATCH', body: { folder_id: f.id } }); await loadList(); } }),
      el('hr'),
      mItem('Delete', async () => {
        if (!confirm(`Delete "${c.title}"? This can't be undone.`)) return;
        await api(`/v1/chats/${c.id}`, { method: 'DELETE' });
        if (state.activeId === c.id) newChat();
        await loadList();
      }, 'danger'),
    ].filter(Boolean);
    openMenu(anchor, entries);
  }
  function folderMenu(f, anchor) {
    openMenu(anchor, [
      mItem('New chat in folder', () => newChat(f.id)),
      mItem('Rename', async () => { const n = await prompt('Rename folder', f.name); if (!n) return; await api(`/v1/folders/${f.id}`, { method: 'PATCH', body: { name: n } }); await loadList(); }),
      mItem('Delete folder', async () => {
        if (!confirm(`Delete folder "${f.name}"? Its chats are kept and moved to Recent.`)) return;
        await api(`/v1/folders/${f.id}`, { method: 'DELETE' }); await loadList();
      }, 'danger'),
    ]);
  }
  async function createFolder() {
    const name = await prompt('New folder name (e.g. Math)');
    if (!name) return null;
    const f = await api('/v1/folders', { method: 'POST', body: { name } });
    await loadList();
    return f;
  }

  // ---------- rendering ----------
  const thread = $('#thread');
  const main = $('.main');
  function setEmpty(on) { main.classList.toggle('empty', on); }
  function renderMarkdown(container, text) {
    const html = window.marked ? window.marked.parse(String(text || ''), { breaks: true, gfm: true }) : null;
    if (html && window.DOMPurify) container.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    else container.textContent = String(text || '');
    container.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    container.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (code && window.hljs) { try { window.hljs.highlightElement(code); } catch { /* ignore */ } }
      pre.append(el('button', { class: 'copy-code', type: 'button', onclick: async (e) => {
        try { await navigator.clipboard.writeText(code ? code.innerText : pre.innerText); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200); } catch { /* ignore */ }
      } }, el('span', { text: 'Copy' })));
    });
    if (window.renderMathInElement) {
      try { window.renderMathInElement(container, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }], throwOnError: false }); } catch { /* ignore */ }
    }
  }
  function userMsg(text) { return el('div', { class: 'msg user' }, el('div', { class: 'bubble', text })); }
  function aiMsg(text, meta) {
    meta = meta || {};
    const content = el('div', { class: 'content' });
    renderMarkdown(content, text);
    const row = el('div', { class: 'meta-row' });
    const badge = (t, cls) => row.append(el('span', { class: 'badge ' + (cls || ''), text: t }));
    if (meta.mode === 'docs') badge('From your docs' + (meta.style === 'simple' ? ' · simplified' : ''));
    else if (meta.mode === 'math') badge('Calculator');
    else if (meta.mode === 'live') badge('Live data');
    else if (meta.mode === 'memory') badge('Memory');
    if (meta.model) badge(prettyModel(meta.model));
    if (meta.fallback_from) badge(`Backup: ${prettyModel(meta.fallback_from)} was unavailable`, 'backup');
    if (meta.contributors) badge(meta.contributors.map((c) => `${prettyModel(c.model).split(' ')[0]} ${c.ok ? '✓' : '✗'}`).join(' · '));
    if (meta.calculations && meta.calculations.length) badge('Numbers computed exactly');
    const extras = [];
    const toggle = (label, build) => {
      let box = null;
      row.append(el('button', { class: 'link-btn', type: 'button', onclick: () => {
        if (box) { box.remove(); box = null; return; }
        box = build(); extras.push(box); body.append(box);
      } }, el('span', { text: label })));
    };
    if (meta.candidates && meta.candidates.length) toggle(`Compare the ${meta.candidates.length} answers`, () => el('div', { class: 'extra' },
      ...meta.candidates.map((c) => { const box = el('div', { class: 'content', style: 'margin-bottom:10px' }); renderMarkdown(box, `**${prettyModel(c.model)}:** ${c.answer}`); return box; })));
    if (meta.original_answer) toggle('Show original wording', () => el('div', { class: 'extra', text: meta.original_answer }));
    if (meta.sources && meta.sources.length) toggle(`Sources (${meta.sources.length})`, () => el('div', { class: 'extra' }, el('ol', {}, ...meta.sources.map((s) =>
      el('li', {}, s.url && /^https:\/\//.test(s.url) ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: `${s.title} › ${s.section}` }) : el('span', { text: `${s.title} › ${s.section}` }))))));
    if (meta.calculations && meta.calculations.length) toggle(`Calculations (${meta.calculations.length})`, () => el('div', { class: 'extra' }, ...meta.calculations.map((c) => el('div', { text: `${c.expression} = ${c.error ? 'error: ' + c.error : c.result}` }))));
    if (meta.live_data && meta.live_data.length) toggle('Live data sources', () => el('div', { class: 'extra' }, ...meta.live_data.map((d) =>
      el('div', {}, d.url && /^https:\/\//.test(d.url) ? el('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', text: d.source || d.tool }) : el('span', { text: d.source || d.tool }), d.error ? el('span', { text: ' (error: ' + d.error + ')' }) : null))));
    if (meta.memory_sources && meta.memory_sources.length) {
      const used = meta.memory_sources.map((m) => m.title).slice(0, 3).join(' · ');
      row.append(el('span', { class: 'badge mem', title: used, text: `Used memory: ${used.length > 60 ? used.slice(0, 60) + '…' : used}` }));
    }
    const body = el('div', { class: 'body' }, content, row, meta.disclaimer ? el('div', { class: 'disclaimer', text: meta.disclaimer }) : null);
    return el('div', { class: 'msg ai' }, body);
  }
  const scrollDown = () => { thread.scrollTop = thread.scrollHeight; };

  // ---------- chat flow ----------
  async function loadList() {
    const d = await api('/v1/chats');
    state.folders = d.folders; state.chats = d.chats;
    renderSidebar();
    const c = state.chats.find((x) => x.id === state.activeId);
    $('#chat-title').textContent = c ? c.title : '';
  }
  function newChat(folderId = null) {
    state.activeId = null; state.pendingFolder = folderId;
    thread.replaceChildren();
    const f = state.folders.find((x) => x.id === folderId);
    $('#chat-title').textContent = f ? `New chat in ${f.name}` : '';
    setEmpty(true); renderSidebar(); closeSide();
    $('#input').focus();
  }
  async function openChat(id) {
    closeSide();
    state.activeId = id; state.pendingFolder = null;
    renderSidebar();
    thread.replaceChildren(el('div', { class: 'msg ai' }, el('div', { class: 'typing' }, el('i'), el('i'), el('i'))));
    setEmpty(false);
    try {
      const d = await api(`/v1/chats/${id}`);
      if (state.activeId !== id) return;
      $('#chat-title').textContent = d.chat.title;
      thread.replaceChildren(...d.messages.map((m) => (m.role === 'user' ? userMsg(m.content) : aiMsg(m.content, m.meta))));
      if (!d.messages.length) setEmpty(true);
      scrollDown();
    } catch (err) { thread.replaceChildren(el('div', { class: 'msg ai' }, el('div', { class: 'err-text', text: err.message }))); }
  }
  async function send(text) {
    if (state.busy || !text.trim()) return;
    state.busy = true; $('#send').disabled = true;
    setEmpty(false);
    thread.append(userMsg(text));
    const typing = el('div', { class: 'msg ai' }, el('div', { class: 'typing', 'aria-label': 'Thinking' }, el('i'), el('i'), el('i')));
    thread.append(typing); scrollDown();
    try {
      if (!state.activeId) {
        const c = await api('/v1/chats', { method: 'POST', body: state.pendingFolder ? { folder_id: state.pendingFolder } : {} });
        state.activeId = c.id; state.pendingFolder = null;
      }
      const model = $('#model').value;
      const body = { question: text.slice(0, 500), chat_id: state.activeId, use_memory: $('#use-memory').checked, ...(model !== 'auto' ? { model } : {}) };
      const r = await api('/v1/ask', { method: 'POST', body });
      typing.replaceWith(aiMsg(r.answer || r.message || 'No answer.', r));
      await loadList();
    } catch (err) {
      typing.replaceWith(el('div', { class: 'msg ai' }, el('div', { class: 'err-text', text: err.message })));
    } finally {
      state.busy = false; $('#send').disabled = false; scrollDown();
    }
  }
  function toastErr(err) { alert(err.message || String(err)); }

  // ---------- composer ----------
  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 500) { alert('Questions can be up to 500 characters.'); return; }
    input.value = ''; autosize();
    send(text);
  });
  $('#model').value = lsGet(LS.model, 'auto');
  $('#model').addEventListener('change', () => lsSet(LS.model, $('#model').value));
  $('#use-memory').checked = lsGet(LS.memory, true);
  $('#use-memory').addEventListener('change', () => lsSet(LS.memory, $('#use-memory').checked));
  $('#new-chat').addEventListener('click', () => newChat());

  // ---------- sidebar open/close ----------
  const app = $('#app');
  const mobile = () => matchMedia('(max-width: 820px)').matches;
  function closeSide() { if (mobile()) { app.classList.remove('side-open'); $('#scrim').hidden = true; } }
  $('#collapse').addEventListener('click', () => {
    if (mobile()) return closeSide();
    app.classList.add('collapsed'); lsSet(LS.collapsed, true);
  });
  $('#open-side').addEventListener('click', () => {
    if (mobile()) { app.classList.add('side-open'); $('#scrim').hidden = false; return; }
    app.classList.remove('collapsed'); lsSet(LS.collapsed, false);
  });
  $('#scrim').addEventListener('click', closeSide);
  if (lsGet(LS.collapsed, false) && !mobile()) app.classList.add('collapsed');

  // ---------- start once unlocked ----------
  setEmpty(true);
  addEventListener('load', () => {
    window.OVA.onUnlock(() => { loadList().catch((err) => $('#side-list').replaceChildren(el('div', { class: 'empty-note', text: err.message }))); input.focus(); });
  });
})();
