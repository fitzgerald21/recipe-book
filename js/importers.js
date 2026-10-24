// Getting raw recipe material into the app: web links and photos.

// Browsers can't fetch other websites directly (CORS), so links go through a
// public reader/proxy. Several are tried in turn because free services come and go.
const READERS = [
  { name: 'jina', url: (u) => `https://r.jina.ai/${u}`, kind: 'text' },
  { name: 'allorigins', url: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, kind: 'html' },
  { name: 'codetabs', url: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`, kind: 'html' },
  { name: 'corsproxy', url: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`, kind: 'html' },
];

const MAX_CHARS = 60000;

async function fetchWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Most recipe sites embed schema.org Recipe JSON-LD. It's the most reliable source when present. */
function findJsonLdRecipe(doc) {
  const isRecipe = (n) => n && (n['@type'] === 'Recipe' || (Array.isArray(n['@type']) && n['@type'].includes('Recipe')));
  const walk = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (Array.isArray(n)) { for (const x of n) { const r = walk(x); if (r) return r; } return null; }
    if (isRecipe(n)) return n;
    return walk(n['@graph']);
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { const r = walk(JSON.parse(s.textContent)); if (r) return r; } catch { /* bad JSON-LD, skip */ }
  }
  return null;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const recipe = findJsonLdRecipe(doc);
  doc.querySelectorAll('script, style, noscript, svg, iframe, nav, footer, header, form, aside').forEach((el) => el.remove());
  const body = (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  const title = doc.title ? `Page title: ${doc.title}\n\n` : '';
  const ld = recipe ? `Structured recipe data from the page:\n${JSON.stringify(recipe).slice(0, 20000)}\n\n` : '';
  return { text: `${title}${ld}Page text:\n${body}`, image: pickImage(recipe, doc) };
}

function pickImage(recipe, doc) {
  let img = recipe?.image;
  if (Array.isArray(img)) img = img[0];
  if (img && typeof img === 'object') img = img.url;
  return img || doc.querySelector('meta[property="og:image"]')?.content || '';
}

/** Returns { text, imageUrl } for a recipe web page. */
export async function fetchRecipePage(url, onStatus = () => {}) {
  const errors = [];
  for (const r of READERS) {
    onStatus(`Loading page (${r.name})…`);
    try {
      const raw = await fetchWithTimeout(r.url(url));
      if (!raw || raw.length < 200) throw new Error('empty page');
      if (r.kind === 'text') {
        const m = /!\[[^\]]*\]\((https?:[^)\s]+\.(?:jpe?g|png|webp)[^)\s]*)\)/i.exec(raw);
        return { text: `Source: ${url}\n\n${raw.slice(0, MAX_CHARS)}`, imageUrl: m?.[1] || '' };
      }
      const { text, image } = htmlToText(raw);
      if (text.length < 300) throw new Error('page had no text');
      return { text: `Source: ${url}\n\n${text.slice(0, MAX_CHARS)}`, imageUrl: image };
    } catch (e) {
      errors.push(`${r.name}: ${e.message}`);
    }
  }
  throw new Error(`Couldn't load that page. You can open it, copy the recipe text, and use "Paste text" instead.\n(${errors.join('; ')})`);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = src;
  });
}

/** Scales an image down so it's cheap to send to the AI and small to store. Returns a JPEG data URL. */
export async function resizeImage(src, maxSide = 1600, quality = 0.85) {
  const img = await loadImage(src);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Small thumbnail for the recipe card. Remote images may block canvas access, so failures return ''. */
export async function makeThumbnail(src) {
  if (!src) return '';
  try {
    return await resizeImage(src, 480, 0.75);
  } catch {
    try {
      // Retry the remote image through a proxy that adds CORS headers.
      if (/^https?:/.test(src)) return await resizeImage(`https://corsproxy.io/?url=${encodeURIComponent(src)}`, 480, 0.75);
    } catch { /* give up quietly */ }
    return '';
  }
}

/** Reads plain text out of a dropped/picked file (.txt, .eml, .html, .md). */
export async function fileToText(file) {
  const text = await file.text();
  if (/\.html?$/i.test(file.name) || /^\s*<(!doctype|html)/i.test(text)) return htmlToText(text).text;
  return text;
}
