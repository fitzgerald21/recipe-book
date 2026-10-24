// Turns messy recipe input (web page text, email text, photos) into a clean
// recipe object using whichever AI provider the user picked in Settings.
//
// Providers:
//   - OpenRouter & DeepInfra: OpenAI-compatible chat completions
//   - Anthropic: Messages API (direct browser access header required)
import { getSettings } from './settings.js';
import { PROVIDERS } from './defaults.js';

const ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepinfra: 'https://api.deepinfra.com/v1/openai/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

function systemPrompt(categories) {
  const catLines = categories.map((c) => `- ${c.path} (id: ${c.id})`).join('\n');
  return `You turn recipes into a clean, easy-to-read format for a home cook's recipe book.

The input may be a web page (with ads, stories and comments mixed in), a forwarded email, pasted notes, or photos of a cookbook page, recipe card or handwritten note. Find the recipe and extract it.

Rules:
- Keep the cook's quantities and ingredients exactly. Never invent ingredients, amounts, times or temperatures that are not in the source.
- Fix obvious typos and OCR/handwriting mistakes. Write fractions like 1/2, 1 1/2.
- One ingredient per item, quantity first ("2 cups all-purpose flour").
- Steps: short, clear, one action or closely related actions per step. Keep temperatures and times in the step text. Do not number them.
- If ingredients or steps are split into parts (e.g. "Cake" and "Frosting"), use one group per part. Otherwise use a single group with group "".
- Put tips, substitutions, storage info and anything useful that is not a step into notes. Skip life stories, ads and comments.
- Times as short text like "15 min" or "1 hr 20 min"; empty string if not given. Servings as short text like "12 cookies" or "4 servings"; empty string if not given.
- description: one short sentence about the dish (empty string if nothing to go on).
- categoryId: pick the single best id from the category list below, preferring the most specific subcategory. Use null if nothing fits.
- tags: up to 5 short lowercase tags (e.g. "chocolate", "slow cooker", "make ahead").
- If there are several recipes in the input, extract the main one and mention the others in notes.
- If the input contains no recipe at all, return {"error": "<short reason>"}.

Categories:
${catLines}

Reply with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "title": "",
  "description": "",
  "categoryId": "id or null",
  "servings": "",
  "prepTime": "",
  "cookTime": "",
  "totalTime": "",
  "ingredients": [{"group": "", "items": [""]}],
  "steps": [{"group": "", "items": [""]}],
  "notes": [""],
  "tags": [""]
}`;
}

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  return { mediaType: m[1], data: m[2] };
}

async function callOpenAICompatible(provider, key, model, system, text, images) {
  const content = [{ type: 'text', text }];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Recipe Book';
  }
  const res = await fetch(ENDPOINTS[provider], {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 6000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: images.length ? content : text },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(body.error?.message || body.detail?.error || body.detail || `HTTP ${res.status}`);
  }
  return body.choices?.[0]?.message?.content || '';
}

async function callAnthropic(key, model, system, text, images) {
  const content = images.map((img) => {
    const { mediaType, data } = splitDataUrl(img);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
  content.push({ type: 'text', text });
  const res = await fetch(ENDPOINTS.anthropic, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 6000,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** Pulls the first JSON object out of a model reply, tolerating fences or chatter around it. */
export function parseJsonReply(reply) {
  let s = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('The AI did not return a recipe. Try again or try another model.');
  return JSON.parse(s.slice(start, end + 1));
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  // Accept a flat list of strings as one unnamed group.
  if (groups.every((g) => typeof g === 'string')) return [{ group: '', items: asList(groups) }];
  return groups
    .map((g) => ({ group: String(g.group || g.name || '').trim(), items: asList(g.items) }))
    .filter((g) => g.items.length);
}

export function normalizeRecipe(raw, categories) {
  const ids = new Set(categories.map((c) => c.id));
  return {
    title: String(raw.title || 'Untitled recipe').trim(),
    description: String(raw.description || '').trim(),
    categoryId: ids.has(raw.categoryId) ? raw.categoryId : null,
    servings: String(raw.servings || '').trim(),
    prepTime: String(raw.prepTime || '').trim(),
    cookTime: String(raw.cookTime || '').trim(),
    totalTime: String(raw.totalTime || '').trim(),
    ingredients: normalizeGroups(raw.ingredients),
    steps: normalizeGroups(raw.steps),
    notes: asList(raw.notes),
    tags: asList(raw.tags).map((t) => t.toLowerCase()).slice(0, 8),
  };
}

/** Which providers will be tried, in order: the chosen one first, then others with keys if fallback is on. */
function providerOrder(settings) {
  const order = [settings.provider, ...Object.keys(PROVIDERS).filter((p) => p !== settings.provider)];
  return order.filter((p, i) => settings.keys[p] && (i === 0 || settings.fallback));
}

/**
 * Convert input to a recipe.
 * @param {{text?: string, images?: string[], categories: {id, path}[], onStatus?: (msg) => void}} input
 *   images are JPEG/PNG data URLs.
 */
export async function convertRecipe({ text = '', images = [], categories, onStatus = () => {} }) {
  const settings = getSettings();
  const order = providerOrder(settings);
  if (!order.length) throw new Error('Add an API key in Settings first.');

  const system = systemPrompt(categories);
  const userText = text.trim()
    ? `Here is the recipe source:\n\n${text.trim()}`
    : `The recipe is in the attached photo${images.length > 1 ? 's (in page order)' : ''}.`;

  const errors = [];
  for (const provider of order) {
    const model = settings.models[provider];
    onStatus(`Asking ${PROVIDERS[provider].label} (${model})…`);
    try {
      const reply = provider === 'anthropic'
        ? await callAnthropic(settings.keys[provider], model, system, userText, images)
        : await callOpenAICompatible(provider, settings.keys[provider], model, system, userText, images);
      const raw = parseJsonReply(reply);
      if (raw.error) throw Object.assign(new Error(raw.error), { noRetry: true });
      return { recipe: normalizeRecipe(raw, categories), provider, model };
    } catch (e) {
      errors.push(`${PROVIDERS[provider].label}: ${e.message}`);
      if (e.noRetry) break;
    }
  }
  throw new Error(errors.join('\n'));
}

/** Quick key check used by the Settings "Test" button. */
export async function testProvider(provider) {
  const s = getSettings();
  const key = s.keys[provider];
  if (!key) throw new Error('No key entered.');
  const model = s.models[provider];
  const reply = provider === 'anthropic'
    ? await callAnthropic(key, model, 'Reply with the single word OK.', 'Ping', [])
    : await callOpenAICompatible(provider, key, model, 'Reply with the single word OK.', 'Ping', []);
  return reply.trim().slice(0, 40) || '(empty reply)';
}
