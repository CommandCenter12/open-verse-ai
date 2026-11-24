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
  const LS = { sideOpen: 'ova.chat.sideOpen', closedFolders: 'ova.chat.closedFolders', model: 'ova.chat.model', memory: 'ova.chat.memory' };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

  const MODEL_NAMES = {
    'qwen3.8-27b': 'Qwen 3.8 27B', 'gemma-4-26b-a4b-it': 'Gemma 4 26B', 'llama-4-scout-17b-16e-instruct': 'Llama 4 Scout',
    'llama-3.3-70b-instruct-fp8-fast': 'Llama 3.3 70B', 'mistral-small-3.1-24b-instruct': 'Mistral Small 3.1',
    plus: 'Open Source+',
  };
  const prettyModel = (m) => MODEL_NAMES[m] || m || '';

  const state = { folders: [], chats: [], activeId: null, pendingFolder: null, busy: false, closed: new Set(lsGet(LS.closedFolders, [])), query: '', files: [], think: false };
  const MAX_FILE_CHARS = 15000, MAX_TOTAL_CHARS = 40000, MAX_FILES = 5, MAX_PDF_PAGES = 40;

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
    if (state.query) {
      const q = state.query.toLowerCase();
      const hits = state.chats.filter((c) => c.title.toLowerCase().includes(q));
      list.append(section(`Results for "${state.query}"`, hits.length ? hits.map(chatItem) : [el('div', { class: 'empty-note', text: 'No chats match.' })]));
      return;
    }
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
  function userMsg(text, files = []) {
    return el('div', { class: 'msg user' },
      files.length ? el('div', { class: 'att' }, ...files.map((n) => el('span', { class: 'chip' }, el('span', { text: '📄' }), el('span', { class: 'n', text: n })))) : null,
      el('div', { class: 'bubble', text }));
  }
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
      thread.replaceChildren(...d.messages.map((m) => (m.role === 'user' ? userMsg(m.content, (m.meta && m.meta.attachments) || []) : aiMsg(m.content, m.meta))));
      if (!d.messages.length) setEmpty(true);
      scrollDown();
    } catch (err) { thread.replaceChildren(el('div', { class: 'msg ai' }, el('div', { class: 'err-text', text: err.message }))); }
  }
  async function send(text) {
    if (state.busy || !text.trim()) return;
    state.busy = true; $('#send').disabled = true;
    setEmpty(false);
    const files = state.files.filter((f) => !f.loading);
    thread.append(userMsg(text, files.map((f) => f.name)));
    clearFiles();
    const typing = el('div', { class: 'msg ai' }, el('div', { class: 'typing', 'aria-label': 'Thinking' }, el('i'), el('i'), el('i')));
    thread.append(typing); scrollDown();
    try {
      if (!state.activeId) {
        const c = await api('/v1/chats', { method: 'POST', body: state.pendingFolder ? { folder_id: state.pendingFolder } : {} });
        state.activeId = c.id; state.pendingFolder = null;
      }
      const model = state.think ? 'plus' : $('#model').value;
      const body = { question: text.slice(0, 500), chat_id: state.activeId, use_memory: $('#use-memory').checked, ...(model !== 'auto' ? { model } : {}),
        ...(files.length ? { attachments: files.map((f) => ({ name: f.name, text: f.text })) } : {}) };
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
    let text = input.value.trim();
    if (!text && state.files.length) text = 'Summarize the attached file' + (state.files.length > 1 ? 's.' : '.');
    if (!text) return;
    if (state.files.some((f) => f.loading)) { alert('Still reading your file. Try again in a moment.'); return; }
    if (text.length > 500) { alert('Questions can be up to 500 characters.'); return; }
    input.value = ''; autosize();
    send(text);
  });
  $('#model').value = lsGet(LS.model, 'auto');
  $('#model').addEventListener('change', () => lsSet(LS.model, $('#model').value));
  $('#use-memory').checked = lsGet(LS.memory, true);
  $('#use-memory').addEventListener('change', () => lsSet(LS.memory, $('#use-memory').checked));
  $('#new-chat').addEventListener('click', () => newChat());

  // ---------- panel open/close (rail on desktop, slide-over on phones) ----------
  const app = $('#app');
  const mobile = () => matchMedia('(max-width: 820px)').matches;
  function openSide(focusSearch = false) {
    app.classList.add('side-open');
    if (mobile()) $('#scrim').hidden = false; else lsSet(LS.sideOpen, true);
    if (focusSearch) setTimeout(() => $('#search').focus(), 50);
  }
  function closeSide(force = false) {
    if (!mobile() && !force) return;
    app.classList.remove('side-open'); $('#scrim').hidden = true;
    if (!mobile()) lsSet(LS.sideOpen, false);
  }
  $('#collapse').addEventListener('click', () => closeSide(true));
  $('#open-side').addEventListener('click', () => openSide());
  $('#scrim').addEventListener('click', () => closeSide(true));
  $('#rail-new').addEventListener('click', () => newChat());
  $('#rail-search').addEventListener('click', () => openSide(true));
  $('#rail-chats').addEventListener('click', () => (app.classList.contains('side-open') ? closeSide(true) : openSide()));
  $('#rail-folders').addEventListener('click', () => { openSide(); const h = [...document.querySelectorAll('.sec-head span')].find((x) => x.textContent === 'Folders'); if (h) h.scrollIntoView({ block: 'start' }); });
  $('#search').addEventListener('input', () => { state.query = $('#search').value.trim(); renderSidebar(); });
  if (lsGet(LS.sideOpen, false) && !mobile()) app.classList.add('side-open');

  // ---------- + menu: files and memory ----------
  $('#plus').addEventListener('click', (e) => {
    e.stopPropagation();
    const mem = $('#use-memory').checked;
    openMenu(e.currentTarget, [
      mItem('📎  Add photos & files…', () => $('#file').click()),
      el('hr'),
      mItem(`${mem ? '✓' : '  '}  Use past chats as memory`, () => { $('#use-memory').checked = !mem; lsSet(LS.memory, !mem); }),
    ]);
  });
  $('#file').addEventListener('change', () => { addFiles([...$('#file').files]); $('#file').value = ''; });
  // drag & drop files onto the composer
  $('#pill').addEventListener('dragover', (e) => { e.preventDefault(); });
  $('#pill').addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

  const fmt = (n) => (n < 1000 ? `${n} chars` : `${Math.round(n / 1000)}k chars`);
  function renderChips() {
    const box = $('#chips');
    box.hidden = !state.files.length;
    box.replaceChildren(...state.files.map((f) => el('span', { class: 'chip' + (f.loading ? ' loading' : ''), title: f.note || f.name },
      el('span', { text: f.name.toLowerCase().endsWith('.pdf') ? '📕' : '📄' }), el('span', { class: 'n', text: f.name }),
      el('span', { class: 's', text: f.loading ? 'reading…' : fmt(f.text.length) + (f.note ? ' · cut' : '') }),
      el('button', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { state.files = state.files.filter((x) => x !== f); renderChips(); } }, el('span', { text: '×' })))));
  }
  function clearFiles() { state.files = []; renderChips(); }
  let pdfjs = null;
  async function pdfText(file) {
    if (!pdfjs) {
      pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(`[Page ${i}]\n` + tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim());
    }
    if (doc.numPages > MAX_PDF_PAGES) pages.push(`[Only the first ${MAX_PDF_PAGES} of ${doc.numPages} pages were read.]`);
    return pages.join('\n\n');
  }
  async function addFiles(list) {
    for (const file of list) {
      if (state.files.length >= MAX_FILES) { alert(`You can attach up to ${MAX_FILES} files.`); break; }
      if (/^image\//.test(file.type)) { alert(`${file.name}: images aren't supported yet. Text, code and PDF files work.`); continue; }
      if (file.size > 15 * 1024 * 1024) { alert(`${file.name} is larger than 15 MB.`); continue; }
      const entry = { name: file.name, text: '', loading: true };
      state.files.push(entry); renderChips();
      try {
        let text = /\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? await pdfText(file) : await file.text();
        if (!text.trim()) throw new Error(/\.pdf$/i.test(file.name) ? 'no readable text (a scanned PDF?)' : 'the file is empty');
        if (/\u0000/.test(text.slice(0, 2000))) throw new Error("this doesn't look like a text file");
        if (text.length > MAX_FILE_CHARS) { entry.note = `Only the first ${MAX_FILE_CHARS.toLocaleString()} characters are sent.`; text = text.slice(0, MAX_FILE_CHARS); }
        const used = state.files.reduce((n, f) => n + (f === entry ? 0 : f.text.length), 0);
        if (used + text.length > MAX_TOTAL_CHARS) { text = text.slice(0, Math.max(0, MAX_TOTAL_CHARS - used)); entry.note = 'Cut to fit the size limit for all files together.'; }
        entry.text = text; entry.loading = false;
      } catch (err) {
        state.files = state.files.filter((x) => x !== entry);
        alert(`Couldn't read ${file.name}: ${err.message}`);
      }
      renderChips();
    }
  }

  // ---------- Think, mic, suggestions ----------
  $('#think').addEventListener('click', () => {
    state.think = !state.think;
    $('#think').setAttribute('aria-pressed', String(state.think));
  });
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const mic = $('#mic'); mic.hidden = false;
    let rec = null;
    mic.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false;
      const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
      rec.onresult = (e) => { input.value = base + [...e.results].map((r) => r[0].transcript).join(''); autosize(); };
      rec.onend = () => { rec = null; mic.classList.remove('rec'); input.focus(); };
      rec.onerror = () => { rec = null; mic.classList.remove('rec'); };
      mic.classList.add('rec'); rec.start();
    });
  }
  document.querySelectorAll('#suggest button').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.prompt; autosize(); input.focus(); }));

  // ---------- start once unlocked ----------
  setEmpty(true);
  addEventListener('load', () => {
    window.OVA.onUnlock(() => { loadList().catch((err) => $('#side-list').replaceChildren(el('div', { class: 'empty-note', text: err.message }))); input.focus(); });
  });
})();
