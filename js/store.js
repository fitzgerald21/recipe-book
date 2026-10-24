// Storage layer.
//
// Every part of the app talks to storage through the `store` proxy below, never
// to an adapter directly. The app signs in and swaps in FirebaseStore
// (firebase-store.js) via `setStore()`; LocalStore is the on-device adapter that
// came first, and is now only read once to move its recipes into the account.
// All methods are async, and records are plain JSON objects with string ids and
// ISO timestamps, which map 1:1 onto Firestore documents.
//
// Collections:
//   categories: { id, name, parentId|null, order, emoji, createdAt, updatedAt }
//   recipes:    { id, title, description, categoryId|null, servings, prepTime,
//                 cookTime, totalTime, ingredients:[{group, items:[str]}],
//                 steps:[{group, items:[str]}], notes:[str], tags:[str],
//                 source:{type, url, text}, image (small data URL), favorite,
//                 createdAt, updatedAt }

import { DEFAULT_CATEGORIES } from './defaults.js';

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const now = () => new Date().toISOString();

/** IndexedDB adapter: data lives on this device only. */
export class LocalStore {
  constructor(dbName = 'recipe-book') {
    this.dbName = dbName;
    this.listeners = new Set();
    this.dbPromise = null;
  }

  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('categories', { keyPath: 'id' });
        db.createObjectStore('recipes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async tx(storeName, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async init() {
    const cats = await this.listCategories();
    if (cats.length === 0) {
      for (const c of DEFAULT_CATEGORIES) await this.saveCategory(c, { silent: true });
    }
  }

  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit() {
    for (const cb of this.listeners) cb();
  }

  // ---- categories ----
  async listCategories() {
    const all = await this.tx('categories', 'readonly', (s) => this.reqToPromise(s.getAll()));
    return all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  }

  async saveCategory(cat, { silent = false } = {}) {
    const rec = { ...cat, id: cat.id || newId(), updatedAt: now(), createdAt: cat.createdAt || now() };
    await this.tx('categories', 'readwrite', (s) => s.put(rec));
    if (!silent) this.emit();
    return rec;
  }

  /** Deletes a category. Its subcategories move up to its parent, its recipes become unsorted. */
  async deleteCategory(id) {
    const cats = await this.listCategories();
    const cat = cats.find((c) => c.id === id);
    if (!cat) return;
    for (const child of cats.filter((c) => c.parentId === id)) {
      await this.saveCategory({ ...child, parentId: cat.parentId ?? null }, { silent: true });
    }
    for (const r of (await this.listRecipes()).filter((r) => r.categoryId === id)) {
      await this.saveRecipe({ ...r, categoryId: null }, { silent: true });
    }
    await this.tx('categories', 'readwrite', (s) => s.delete(id));
    this.emit();
  }

  // ---- recipes ----
  async listRecipes() {
    const all = await this.tx('recipes', 'readonly', (s) => this.reqToPromise(s.getAll()));
    return all.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getRecipe(id) {
    return this.tx('recipes', 'readonly', (s) => this.reqToPromise(s.get(id)));
  }

  async saveRecipe(recipe, { silent = false } = {}) {
    const rec = { ...recipe, id: recipe.id || newId(), updatedAt: now(), createdAt: recipe.createdAt || now() };
    await this.tx('recipes', 'readwrite', (s) => s.put(rec));
    if (!silent) this.emit();
    return rec;
  }

  async deleteRecipe(id) {
    await this.tx('recipes', 'readwrite', (s) => s.delete(id));
    this.emit();
  }

  // ---- backup ----
  async exportAll() {
    return {
      app: 'recipe-book',
      version: 1,
      exportedAt: now(),
      categories: await this.listCategories(),
      recipes: await this.listRecipes(),
    };
  }

  /** Merges a backup in: records with the same id are overwritten, nothing is deleted. */
  async importAll(data) {
    if (!data || data.app !== 'recipe-book') throw new Error('That file is not a Recipe Book backup.');
    for (const c of data.categories || []) await this.tx('categories', 'readwrite', (s) => s.put(c));
    for (const r of data.recipes || []) await this.tx('recipes', 'readwrite', (s) => s.put(r));
    this.emit();
    return { categories: (data.categories || []).length, recipes: (data.recipes || []).length };
  }
}

let current = new LocalStore();

/** The active store. Import this everywhere instead of an adapter. */
export const store = new Proxy({}, {
  get: (_, prop) => {
    const v = current[prop];
    return typeof v === 'function' ? v.bind(current) : v;
  },
});

/** Swap the backing adapter (to Firebase, after sign-in). The new adapter must implement the same methods. */
export async function setStore(adapter) {
  current = adapter;
  await current.init();
  current.emit?.();
}
