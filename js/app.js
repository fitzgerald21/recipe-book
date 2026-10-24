import { store, newId } from './store.js';
import { PROVIDERS } from './defaults.js';
import { getSettings, saveSettings } from './settings.js';
import { convertRecipe, testProvider } from './ai.js';
import { fetchRecipePage, resizeImage, fileToDataUrl, makeThumbnail, fileToText } from './importers.js';

const app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}

/** Adds `path` ("Desserts › Cakes") and `depth` to each category, in tree order. */
function categoryTree(cats) {
  const byParent = new Map();
  for (const c of cats) {
    const k = c.parentId || '';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(c);
  }
  const out = [];
  const visit = (parentId, prefix, depth) => {
    for (const c of byParent.get(parentId) || []) {
      const path = prefix ? `${prefix} › ${c.name}` : c.name;
      out.push({ ...c, path, depth });
      visit(c.id, path, depth + 1);
    }
  };
  visit('', '', 0);
  // Orphans (parent deleted elsewhere) still show up at top level.
  for (const c of cats) if (!out.find((o) => o.id === c.id)) out.push({ ...c, path: c.name, depth: 0 });
  return out;
}

function descendantIds(cats, id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cats) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
  }
  return ids;
}

function recipeCard(r, cats) {
  const cat = cats.find((c) => c.id === r.categoryId);
  const meta = [r.totalTime || r.cookTime, r.servings].filter(Boolean).join(' · ');
  return `
    <a class="card" href="#/recipe/${esc(r.id)}">
      ${r.image ? `<img class="thumb" src="${esc(r.image)}" alt="" loading="lazy">` : `<div class="thumb placeholder">${esc(cat?.emoji || '🍴')}</div>`}
      <div class="card-body">
        <div class="card-title">${r.favorite ? '<span class="fav">★</span> ' : ''}${esc(r.title)}</div>
        ${meta ? `<div class="card-meta">${esc(meta)}</div>` : ''}
      </div>
    </a>`;
}

function header({ title, back, right = '' }) {
  return `
    <header class="bar">
      <div class="bar-side">${back ? `<a class="bar-btn" href="${esc(back)}" aria-label="Back">‹ Back</a>` : ''}</div>
      <h1 class="bar-title">${esc(title)}</h1>
      <div class="bar-side right">${right}</div>
    </header>`;
}

/** Bottom sheet for choosing a category. Resolves to an id, null for "Unsorted", or undefined if cancelled. */
function pickCategory(cats, currentId) {
  return new Promise((resolve) => {
    const tree = categoryTree(cats);
    const sheet = document.createElement('div');
    sheet.className = 'sheet-backdrop';
    sheet.innerHTML = `
      <div class="sheet">
        <div class="sheet-title">Move to…</div>
        <div class="sheet-list">
          ${tree.map((c) => `<button data-id="${esc(c.id)}" class="sheet-item ${c.id === currentId ? 'current' : ''}" style="padding-left:${16 + c.depth * 22}px">${esc(c.emoji || '📁')} ${esc(c.name)}</button>`).join('')}
          <button data-id="" class="sheet-item ${!currentId ? 'current' : ''}">📥 Unsorted</button>
        </div>
        <button class="btn secondary block" data-cancel>Cancel</button>
      </div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-id]');
      if (btn) { sheet.remove(); resolve(btn.dataset.id || null); return; }
      if (e.target === sheet || e.target.closest('[data-cancel]')) { sheet.remove(); resolve(undefined); }
    });
  });
}

// ---------- state ----------
let draft = null;        // recipe produced by the AI, waiting to be reviewed on the edit screen
let addTab = 'link';
let addPhotos = [];      // data URLs for the photo import tab
let searchQuery = '';
let wakeLock = null;

// ---------- views ----------
async function viewHome() {
  const [cats, recipes] = await Promise.all([store.listCategories(), store.listRecipes()]);
  const tops = cats.filter((c) => !c.parentId);
  const count = (id) => { const ids = descendantIds(cats, id); return recipes.filter((r) => ids.has(r.categoryId)).length; };
  const unsorted = recipes.filter((r) => !r.categoryId || !cats.find((c) => c.id === r.categoryId));
  const favs = recipes.filter((r) => r.favorite);

  app.innerHTML = `
    ${header({ title: 'Recipes', right: '<a class="bar-btn icon" href="#/settings" aria-label="Settings">⚙︎</a>' })}
    <main class="page">
      <input class="search" type="search" placeholder="Search recipes or ingredients" value="${esc(searchQuery)}" autocomplete="off">
      <div id="results"></div>
      <div id="browse">
        ${recipes.length === 0 ? `
          <div class="empty">
            <div class="empty-emoji">📖</div>
            <p><strong>Your recipe book is empty.</strong></p>
            <p>Tap <strong>＋</strong> to add one from a link, an email, or a photo.</p>
            ${!Object.values(getSettings().keys).some(Boolean) ? '<p><a href="#/settings">First, add an API key in Settings →</a></p>' : ''}
          </div>` : ''}
        ${favs.length ? `<h2 class="section">Favorites</h2><div class="hscroll">${favs.map((r) => recipeCard(r, cats)).join('')}</div>` : ''}
        <h2 class="section">Categories</h2>
        <div class="cat-grid">
          ${tops.map((c) => `
            <a class="cat-tile" href="#/category/${esc(c.id)}">
              <span class="cat-emoji">${esc(c.emoji || '📁')}</span>
              <span class="cat-name">${esc(c.name)}</span>
              <span class="cat-count">${count(c.id)}</span>
            </a>`).join('')}
          ${unsorted.length ? `<a class="cat-tile" href="#/category/unsorted"><span class="cat-emoji">📥</span><span class="cat-name">Unsorted</span><span class="cat-count">${unsorted.length}</span></a>` : ''}
          <a class="cat-tile" href="#/category/all"><span class="cat-emoji">📚</span><span class="cat-name">All recipes</span><span class="cat-count">${recipes.length}</span></a>
        </div>
      </div>
    </main>
    <a class="fab" href="#/add" aria-label="Add recipe">＋</a>`;

  const input = $('.search');
  const runSearch = () => {
    searchQuery = input.value;
    const q = searchQuery.trim().toLowerCase();
    $('#browse').hidden = !!q;
    if (!q) { $('#results').innerHTML = ''; return; }
    const hits = recipes.filter((r) => [r.title, r.description, ...(r.tags || []), ...(r.ingredients || []).flatMap((g) => g.items)]
      .join(' ').toLowerCase().includes(q));
    $('#results').innerHTML = hits.length
      ? `<div class="list">${hits.map((r) => recipeCard(r, cats)).join('')}</div>`
      : '<p class="muted center">No recipes match.</p>';
  };
  input.addEventListener('input', runSearch);
  runSearch();
}

async function viewCategory(id) {
  const [cats, recipes] = await Promise.all([store.listCategories(), store.listRecipes()]);
  let title; let sections = []; let cat = null;
  if (id === 'all') {
    title = 'All recipes';
    sections = [{ name: '', items: recipes }];
  } else if (id === 'unsorted') {
    title = 'Unsorted';
    sections = [{ name: '', items: recipes.filter((r) => !r.categoryId || !cats.find((c) => c.id === r.categoryId)) }];
  } else {
    cat = cats.find((c) => c.id === id);
    if (!cat) { location.hash = '#/'; return; }
    title = cat.name;
    sections.push({ name: '', items: recipes.filter((r) => r.categoryId === id) });
    for (const child of categoryTree(cats).filter((c) => c.parentId === id)) {
      const ids = descendantIds(cats, child.id);
      sections.push({ name: child.name, emoji: child.emoji, id: child.id, items: recipes.filter((r) => ids.has(r.categoryId)) });
    }
  }
  const back = cat?.parentId ? `#/category/${cat.parentId}` : '#/';
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const subs = sections.filter((s) => s.id);

  app.innerHTML = `
    ${header({ title, back })}
    <main class="page">
      ${subs.length ? `<div class="chips">${subs.map((s) => `<a class="chip" href="#/category/${esc(s.id)}">${esc(s.emoji || '')} ${esc(s.name)} <span class="muted">${s.items.length}</span></a>`).join('')}</div>` : ''}
      ${total === 0 ? '<p class="muted center">No recipes here yet.</p>' : ''}
      ${sections.filter((s) => s.items.length).map((s) => `
        ${s.name ? `<h2 class="section"><a href="#/category/${esc(s.id)}">${esc(s.emoji || '')} ${esc(s.name)} ›</a></h2>` : ''}
        <div class="list">${s.items.map((r) => recipeCard(r, cats)).join('')}</div>`).join('')}
    </main>
    <a class="fab" href="#/add${cat ? `?cat=${esc(cat.id)}` : ''}" aria-label="Add recipe">＋</a>`;
}

function groupsHtml(groups, kind) {
  let n = 0;
  return groups.map((g) => `
    ${g.group ? `<h3 class="group">${esc(g.group)}</h3>` : ''}
    ${kind === 'ingredients'
      ? `<ul class="ingredients">${g.items.map((it) => `<li><label><input type="checkbox"><span>${esc(it)}</span></label></li>`).join('')}</ul>`
      : `<ol class="steps">${g.items.map((it) => `<li data-n="${++n}">${esc(it)}</li>`).join('')}</ol>`}
  `).join('');
}

async function viewRecipe(id) {
  const [r, cats] = await Promise.all([store.getRecipe(id), store.listCategories()]);
  if (!r) { location.hash = '#/'; return; }
  const cat = categoryTree(cats).find((c) => c.id === r.categoryId);
  const times = [['Prep', r.prepTime], ['Cook', r.cookTime], ['Total', r.totalTime], ['Makes', r.servings]].filter(([, v]) => v);

  app.innerHTML = `
    ${header({ title: '', back: cat ? `#/category/${cat.id}` : '#/', right: `<a class="bar-btn" href="#/edit/${esc(r.id)}">Edit</a>` })}
    <main class="page recipe">
      ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="">` : ''}
      <h1 class="recipe-title">${esc(r.title)}</h1>
      ${r.description ? `<p class="lead">${esc(r.description)}</p>` : ''}
      <div class="meta-row">
        <button class="pill" data-act="move">${cat ? `${esc(cat.emoji || '📁')} ${esc(cat.path)}` : '📥 Unsorted'} ▾</button>
        ${(r.tags || []).map((t) => `<span class="pill muted">${esc(t)}</span>`).join('')}
      </div>
      ${times.length ? `<div class="times">${times.map(([k, v]) => `<div><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}</div>` : ''}

      <div class="actions">
        <button class="act" data-act="fav">${r.favorite ? '★ Favorite' : '☆ Favorite'}</button>
        ${'wakeLock' in navigator ? `<button class="act" data-act="awake">${wakeLock ? '☀︎ Screen on' : '☾ Keep screen on'}</button>` : ''}
        ${navigator.share ? '<button class="act" data-act="share">Share</button>' : ''}
      </div>

      <h2 class="section">Ingredients</h2>
      ${r.ingredients?.length ? groupsHtml(r.ingredients, 'ingredients') : '<p class="muted">None listed.</p>'}

      <h2 class="section">Steps</h2>
      ${r.steps?.length ? groupsHtml(r.steps, 'steps') : '<p class="muted">None listed.</p>'}

      ${r.notes?.length ? `<h2 class="section">Notes</h2><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}

      ${r.source?.url ? `<p class="source">Source: <a href="${esc(r.source.url)}" target="_blank" rel="noopener">${esc(new URL(r.source.url).hostname)}</a></p>` : ''}
      <button class="btn danger block" data-act="delete">Delete recipe</button>
    </main>`;

  $$('.steps li').forEach((li) => li.addEventListener('click', () => li.classList.toggle('done')));
  $('.recipe').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'fav') { await store.saveRecipe({ ...r, favorite: !r.favorite }); viewRecipe(id); }
    if (act === 'move') {
      const to = await pickCategory(cats, r.categoryId);
      if (to !== undefined) { await store.saveRecipe({ ...r, categoryId: to }); toast('Moved'); viewRecipe(id); }
    }
    if (act === 'awake') { await toggleWakeLock(); viewRecipe(id); }
    if (act === 'share') navigator.share({ title: r.title, text: recipeAsText(r) }).catch(() => {});
    if (act === 'delete' && confirm(`Delete "${r.title}"?`)) {
      await store.deleteRecipe(id);
      location.hash = cat ? `#/category/${cat.id}` : '#/';
    }
  });
}

async function toggleWakeLock() {
  if (wakeLock) { await wakeLock.release().catch(() => {}); wakeLock = null; sessionStorage.removeItem('wake'); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    sessionStorage.setItem('wake', '1');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { toast('Could not keep the screen on'); }
}

function recipeAsText(r) {
  const groups = (gs, numbered) => gs.map((g) => `${g.group ? `${g.group}:\n` : ''}${g.items.map((x, i) => (numbered ? `${i + 1}. ` : '• ') + x).join('\n')}`).join('\n\n');
  return [
    r.title,
    r.description,
    [r.servings && `Makes: ${r.servings}`, r.totalTime && `Total: ${r.totalTime}`].filter(Boolean).join(' · '),
    `INGREDIENTS\n${groups(r.ingredients || [], false)}`,
    `STEPS\n${groups(r.steps || [], true)}`,
    r.notes?.length ? `NOTES\n${r.notes.map((n) => `• ${n}`).join('\n')}` : '',
    r.source?.url || '',
  ].filter(Boolean).join('\n\n');
}

// ---------- add ----------
function hashQuery() {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q);
}

async function viewAdd() {
  const q = hashQuery();
  const presetCat = q.get('cat');
  if (q.get('url')) addTab = 'link';
  if (q.get('text')) addTab = 'text';
  const hasKey = Object.values(getSettings().keys).some(Boolean);

  app.innerHTML = `
    ${header({ title: 'Add recipe', back: presetCat ? `#/category/${presetCat}` : '#/' })}
    <main class="page">
      ${!hasKey ? '<div class="notice">Add an API key in <a href="#/settings">Settings</a> so the app can read recipes for you.</div>' : ''}
      <div class="segmented">
        <button data-tab="link" class="${addTab === 'link' ? 'on' : ''}">🔗 Link</button>
        <button data-tab="text" class="${addTab === 'text' ? 'on' : ''}">✉️ Text / Email</button>
        <button data-tab="photo" class="${addTab === 'photo' ? 'on' : ''}">📷 Photo</button>
      </div>

      <section data-pane="link" ${addTab !== 'link' ? 'hidden' : ''}>
        <label class="field-label">Recipe web link</label>
        <div class="row">
          <input id="url" type="url" inputmode="url" placeholder="https://…" value="${esc(q.get('url') || '')}" autocomplete="off">
          ${navigator.clipboard?.readText ? '<button class="btn secondary" id="paste-url">Paste</button>' : ''}
        </div>
        <p class="hint">Works with most recipe sites. If a site blocks it, copy the recipe text and use Text / Email.</p>
      </section>

      <section data-pane="text" ${addTab !== 'text' ? 'hidden' : ''}>
        <label class="field-label">Paste the recipe, an email, or your notes</label>
        <textarea id="text" rows="12" placeholder="Paste anything here. Messy is fine.">${esc(q.get('text') || '')}</textarea>
        <label class="file-btn">Or open a file (.txt, .eml, .html)<input id="text-file" type="file" accept=".txt,.eml,.html,.htm,.md,text/*,message/rfc822"></label>
      </section>

      <section data-pane="photo" ${addTab !== 'photo' ? 'hidden' : ''}>
        <label class="file-btn big">📷 Take or choose photos<input id="photo-input" type="file" accept="image/*" multiple></label>
        <p class="hint">Cookbook pages, recipe cards, handwritten notes, or screenshots. Add several photos for multi-page recipes, in order.</p>
        <div class="photo-grid" id="photos"></div>
        <label class="field-label">Anything to add? (optional)</label>
        <input id="photo-note" type="text" placeholder="e.g. Grandma's version, double the frosting">
      </section>

      <div id="status" class="status" hidden></div>
      <div id="error" class="error" hidden></div>
      <button class="btn primary block" id="convert" ${!hasKey ? 'disabled' : ''}>✨ Make it easy to read</button>
      <a class="btn secondary block" href="#/edit/new${presetCat ? `?cat=${esc(presetCat)}` : ''}" id="manual">Type it in myself</a>
    </main>`;

  const renderPhotos = () => {
    $('#photos').innerHTML = addPhotos.map((p, i) => `<div class="photo"><img src="${p}" alt=""><button data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
  };
  renderPhotos();

  $$('.segmented button').forEach((b) => b.addEventListener('click', () => {
    addTab = b.dataset.tab;
    $$('.segmented button').forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== addTab; });
  }));
  $('#paste-url')?.addEventListener('click', async () => {
    try { $('#url').value = (await navigator.clipboard.readText()).trim(); } catch { toast('Clipboard not available'); }
  });
  $('#text-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) $('#text').value = await fileToText(f);
  });
  $('#photo-input').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try { addPhotos.push(await resizeImage(await fileToDataUrl(f))); } catch (err) { toast(err.message); }
    }
    e.target.value = '';
    renderPhotos();
  });
  $('#photos').addEventListener('click', (e) => {
    const i = e.target.dataset.rm;
    if (i !== undefined) { addPhotos.splice(+i, 1); renderPhotos(); }
  });

  $('#convert').addEventListener('click', async () => {
    const btn = $('#convert');
    const status = $('#status');
    const errorBox = $('#error');
    const setStatus = (m) => { status.hidden = false; status.innerHTML = `<span class="spinner"></span> ${esc(m)}`; };
    errorBox.hidden = true;
    btn.disabled = true;
    try {
      const cats = categoryTree(await store.listCategories());
      let text = ''; let images = []; let source = {}; let thumbSrc = '';
      if (addTab === 'link') {
        const url = $('#url').value.trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Enter a web link starting with http:// or https://');
        const page = await fetchRecipePage(url, setStatus);
        text = page.text; thumbSrc = page.imageUrl;
        source = { type: 'url', url };
      } else if (addTab === 'text') {
        text = $('#text').value.trim();
        if (!text) throw new Error('Paste some recipe text first.');
        const url = /https?:\/\/\S+/.exec(text)?.[0];
        source = { type: 'text', text: text.slice(0, 20000), ...(text.length < 300 && url ? { url } : {}) };
      } else {
        if (!addPhotos.length) throw new Error('Add at least one photo.');
        images = addPhotos;
        text = $('#photo-note').value.trim() ? `Note from the cook: ${$('#photo-note').value.trim()}` : '';
        thumbSrc = addPhotos[0];
        source = { type: 'photo' };
      }
      const { recipe, provider, model } = await convertRecipe({ text, images, categories: cats, onStatus: setStatus });
      setStatus('Finishing up…');
      draft = {
        ...recipe,
        categoryId: presetCat && cats.find((c) => c.id === presetCat) ? presetCat : recipe.categoryId,
        source,
        image: await makeThumbnail(thumbSrc),
        convertedWith: `${provider}:${model}`,
      };
      addPhotos = [];
      location.hash = '#/edit/new';
    } catch (e) {
      status.hidden = true;
      errorBox.hidden = false;
      errorBox.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  if (q.get('url') && hasKey) $('#convert').click();
}

// ---------- edit ----------
// Groups are edited as plain text: one item per line, "## Name" starts a group.
const groupsToText = (gs = []) => gs.map((g) => `${g.group ? `## ${g.group}\n` : ''}${g.items.join('\n')}`).join('\n\n');
function textToGroups(text) {
  const groups = [];
  let cur = { group: '', items: [] };
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^(?:[-•*]|\d+[.)])\s+/, '');
    if (!line) continue;
    const h = /^#+\s*(.+)$/.exec(raw.trim());
    if (h) {
      if (cur.items.length || cur.group) groups.push(cur);
      cur = { group: h[1].trim(), items: [] };
    } else cur.items.push(line);
  }
  if (cur.items.length || cur.group) groups.push(cur);
  return groups.filter((g) => g.items.length);
}

async function viewEdit(id) {
  const cats = categoryTree(await store.listCategories());
  let r;
  const isNew = id === 'new';
  if (isNew) {
    r = draft || { title: '', categoryId: hashQuery().get('cat') || null, ingredients: [], steps: [], notes: [], tags: [], source: { type: 'manual' } };
  } else {
    r = await store.getRecipe(id);
    if (!r) { location.hash = '#/'; return; }
  }
  let image = r.image || '';

  app.innerHTML = `
    ${header({ title: isNew ? (draft ? 'Review recipe' : 'New recipe') : 'Edit recipe', back: isNew ? '#/add' : `#/recipe/${r.id}`, right: '<button class="bar-btn strong" id="save">Save</button>' })}
    <main class="page form">
      ${draft && isNew ? '<div class="notice ok">Here\'s the cleaned-up recipe. Check it over, pick a category, then Save.</div>' : ''}
      <label class="field-label">Title</label>
      <input id="f-title" value="${esc(r.title)}" placeholder="Recipe name">

      <label class="field-label">Category</label>
      <select id="f-cat">
        <option value="">📥 Unsorted</option>
        ${cats.map((c) => `<option value="${esc(c.id)}" ${c.id === r.categoryId ? 'selected' : ''}>${'   '.repeat(c.depth)}${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('')}
      </select>

      <label class="field-label">Photo</label>
      <div class="row photo-edit">
        <div id="img-preview">${image ? `<img src="${esc(image)}" alt="">` : '<div class="thumb placeholder">🍴</div>'}</div>
        <label class="btn secondary file-inline">Choose<input id="f-image" type="file" accept="image/*"></label>
        <button class="btn secondary" id="rm-image" ${image ? '' : 'hidden'}>Remove</button>
      </div>

      <label class="field-label">Short description</label>
      <input id="f-desc" value="${esc(r.description || '')}">

      <div class="grid2">
        <div><label class="field-label">Makes / serves</label><input id="f-serv" value="${esc(r.servings || '')}" placeholder="4 servings"></div>
        <div><label class="field-label">Prep time</label><input id="f-prep" value="${esc(r.prepTime || '')}" placeholder="15 min"></div>
        <div><label class="field-label">Cook time</label><input id="f-cook" value="${esc(r.cookTime || '')}" placeholder="30 min"></div>
        <div><label class="field-label">Total time</label><input id="f-total" value="${esc(r.totalTime || '')}" placeholder="45 min"></div>
      </div>

      <label class="field-label">Ingredients <span class="muted">one per line · start a line with ## for a section</span></label>
      <textarea id="f-ing" rows="10">${esc(groupsToText(r.ingredients))}</textarea>

      <label class="field-label">Steps <span class="muted">one per line · ## for a section</span></label>
      <textarea id="f-steps" rows="10">${esc(groupsToText(r.steps))}</textarea>

      <label class="field-label">Notes <span class="muted">one per line</span></label>
      <textarea id="f-notes" rows="4">${esc((r.notes || []).join('\n'))}</textarea>

      <label class="field-label">Tags <span class="muted">comma separated</span></label>
      <input id="f-tags" value="${esc((r.tags || []).join(', '))}">

      <label class="field-label">Source link</label>
      <input id="f-url" type="url" value="${esc(r.source?.url || '')}" placeholder="https://…">

      <button class="btn primary block" id="save2">Save recipe</button>
    </main>`;

  $('#f-image').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    image = await resizeImage(await fileToDataUrl(f), 480, 0.75);
    $('#img-preview').innerHTML = `<img src="${image}" alt="">`;
    $('#rm-image').hidden = false;
  });
  $('#rm-image').addEventListener('click', () => {
    image = '';
    $('#img-preview').innerHTML = '<div class="thumb placeholder">🍴</div>';
    $('#rm-image').hidden = true;
  });

  const save = async () => {
    const title = $('#f-title').value.trim();
    if (!title) { toast('Give it a title'); $('#f-title').focus(); return; }
    const url = $('#f-url').value.trim();
    const saved = await store.saveRecipe({
      ...r,
      id: isNew ? newId() : r.id,
      title,
      categoryId: $('#f-cat').value || null,
      image,
      description: $('#f-desc').value.trim(),
      servings: $('#f-serv').value.trim(),
      prepTime: $('#f-prep').value.trim(),
      cookTime: $('#f-cook').value.trim(),
      totalTime: $('#f-total').value.trim(),
      ingredients: textToGroups($('#f-ing').value),
      steps: textToGroups($('#f-steps').value),
      notes: $('#f-notes').value.split('\n').map((s) => s.trim()).filter(Boolean),
      tags: $('#f-tags').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      source: url ? { ...(r.source || {}), url } : Object.fromEntries(Object.entries(r.source || {}).filter(([k]) => k !== 'url')),
      favorite: !!r.favorite,
    });
    draft = null;
    toast('Saved');
    location.hash = `#/recipe/${saved.id}`;
  };
  $('#save').addEventListener('click', save);
  $('#save2').addEventListener('click', save);
}

// ---------- settings ----------
async function viewSettings() {
  const s = getSettings();
  const cats = categoryTree(await store.listCategories());

  app.innerHTML = `
    ${header({ title: 'Settings', back: '#/' })}
    <main class="page form">
      <h2 class="section">AI for reading recipes</h2>
      <p class="hint">Keys are saved only on this phone. Pick which service to use first.</p>
      <div class="segmented">
        ${Object.entries(PROVIDERS).map(([k, p]) => `<button data-provider="${k}" class="${s.provider === k ? 'on' : ''}">${p.label}</button>`).join('')}
      </div>
      ${Object.entries(PROVIDERS).map(([k, p]) => `
        <div class="provider-card ${s.provider === k ? 'active' : ''}" data-card="${k}">
          <div class="provider-head"><strong>${p.label}</strong>${s.provider === k ? '<span class="badge">Main</span>' : ''}</div>
          <label class="field-label">API key <a href="${p.keyUrl}" target="_blank" rel="noopener">get one</a></label>
          <div class="row">
            <input type="password" data-key="${k}" value="${esc(s.keys[k])}" placeholder="Paste key" autocomplete="off" autocapitalize="off" spellcheck="false">
            <button class="btn secondary" data-show="${k}">Show</button>
          </div>
          <label class="field-label">Model</label>
          <input data-model="${k}" list="models-${k}" value="${esc(s.models[k])}" autocapitalize="off" spellcheck="false">
          <datalist id="models-${k}">${p.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
          <div class="row"><button class="btn secondary" data-test="${k}">Test</button><span class="test-result" data-result="${k}"></span></div>
        </div>`).join('')}
      <label class="switch-row"><input type="checkbox" id="fallback" ${s.fallback ? 'checked' : ''}> If the main one fails, try the others that have keys</label>

      <h2 class="section">Categories</h2>
      <div class="cat-manage">
        ${cats.map((c) => `
          <div class="cat-row" style="padding-left:${12 + c.depth * 22}px">
            <span class="cat-row-name">${esc(c.emoji || '📁')} ${esc(c.name)}</span>
            <span class="cat-row-btns">
              <button data-cup="${esc(c.id)}" aria-label="Move up">↑</button>
              <button data-cdown="${esc(c.id)}" aria-label="Move down">↓</button>
              <button data-cedit="${esc(c.id)}" aria-label="Rename">✎</button>
              ${c.depth === 0 ? `<button data-csub="${esc(c.id)}" aria-label="Add subcategory">＋</button>` : ''}
              <button data-cdel="${esc(c.id)}" aria-label="Delete">🗑</button>
            </span>
          </div>`).join('')}
      </div>
      <button class="btn secondary block" id="add-cat">＋ Add category</button>

      <h2 class="section">Backup</h2>
      <p class="hint">Recipes are saved on this phone. Export a backup now and then (save it to Files or iCloud Drive). Cloud sync with Firebase is planned.</p>
      <div class="row">
        <button class="btn secondary" id="export">Export backup</button>
        <label class="btn secondary file-inline">Import backup<input id="import" type="file" accept=".json,application/json"></label>
      </div>

      <h2 class="section">Install on iPhone</h2>
      <p class="hint">In Safari, tap the Share button, then <strong>Add to Home Screen</strong>. It opens full-screen like a regular app.</p>
    </main>`;

  const persist = () => saveSettings(s);

  $$('[data-provider]').forEach((b) => b.addEventListener('click', () => { s.provider = b.dataset.provider; persist(); viewSettings(); }));
  $$('[data-key]').forEach((i) => i.addEventListener('change', () => { s.keys[i.dataset.key] = i.value.trim(); persist(); }));
  $$('[data-model]').forEach((i) => i.addEventListener('change', () => { s.models[i.dataset.model] = i.value.trim() || PROVIDERS[i.dataset.model].models[0]; persist(); }));
  $$('[data-show]').forEach((b) => b.addEventListener('click', () => {
    const i = $(`[data-key="${b.dataset.show}"]`);
    i.type = i.type === 'password' ? 'text' : 'password';
    b.textContent = i.type === 'password' ? 'Show' : 'Hide';
  }));
  $$('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.test;
    // Save whatever is typed before testing.
    s.keys[k] = $(`[data-key="${k}"]`).value.trim();
    s.models[k] = $(`[data-model="${k}"]`).value.trim() || PROVIDERS[k].models[0];
    persist();
    const out = $(`[data-result="${k}"]`);
    out.className = 'test-result'; out.textContent = 'Testing…';
    try { await testProvider(k); out.textContent = '✓ Works'; out.classList.add('ok'); } catch (e) { out.textContent = `✕ ${e.message}`; out.classList.add('bad'); }
  }));
  $('#fallback').addEventListener('change', (e) => { s.fallback = e.target.checked; persist(); });

  // Category management
  const raw = await store.listCategories();
  const siblings = (c) => raw.filter((x) => (x.parentId || null) === (c.parentId || null));
  const move = async (id, dir) => {
    const c = raw.find((x) => x.id === id);
    const sibs = siblings(c);
    const i = sibs.findIndex((x) => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    for (let k = 0; k < sibs.length; k++) await store.saveCategory({ ...sibs[k], order: k }, { silent: true });
    viewSettings();
  };
  const askName = (title, c = {}) => {
    const name = prompt(title, c.name || '');
    if (name === null || !name.trim()) return null;
    const emoji = prompt('Emoji for this category (optional)', c.emoji || '') ?? c.emoji ?? '';
    return { name: name.trim(), emoji: emoji.trim() };
  };
  app.querySelector('.cat-manage').addEventListener('click', async (e) => {
    const d = e.target.dataset;
    if (d.cup) move(d.cup, -1);
    if (d.cdown) move(d.cdown, 1);
    if (d.cedit) {
      const c = raw.find((x) => x.id === d.cedit);
      const v = askName('Rename category', c);
      if (v) { await store.saveCategory({ ...c, ...v }); viewSettings(); }
    }
    if (d.csub) {
      const v = askName('New subcategory name');
      if (v) { await store.saveCategory({ ...v, parentId: d.csub, order: raw.filter((x) => x.parentId === d.csub).length }); viewSettings(); }
    }
    if (d.cdel) {
      const c = raw.find((x) => x.id === d.cdel);
      if (confirm(`Delete "${c.name}"? Its recipes move to Unsorted and its subcategories move up a level. No recipes are deleted.`)) {
        await store.deleteCategory(c.id); viewSettings();
      }
    }
  });
  $('#add-cat').addEventListener('click', async () => {
    const v = askName('New category name');
    if (v) { await store.saveCategory({ ...v, parentId: null, order: raw.filter((x) => !x.parentId).length }); viewSettings(); }
  });

  $('#export').addEventListener('click', async () => {
    const data = await store.exportAll();
    const name = `recipe-book-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Recipe Book backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const res = await store.importAll(JSON.parse(await f.text()));
      toast(`Imported ${res.recipes} recipes`);
      viewSettings();
    } catch (err) { alert(err.message); }
  });
}

// ---------- router ----------
async function route() {
  const [path] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] !== 'edit') draft = null;
  switch (parts[0]) {
    case 'category': return viewCategory(parts[1]);
    case 'recipe': return viewRecipe(parts[1]);
    case 'add': return viewAdd();
    case 'edit': return viewEdit(parts[1]);
    case 'settings': return viewSettings();
    default: return viewHome();
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', async () => {
  // iOS drops the wake lock when the app is backgrounded; take it again on return.
  if (document.visibilityState === 'visible' && wakeLock === null && sessionStorage.getItem('wake') === '1') {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }
});

(async () => {
  await store.init();
  // Let recipes arriving from another device (future Firebase sync) refresh list screens.
  store.onChange(() => {
    const p = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (p === '' || p === 'category') route();
  });
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
