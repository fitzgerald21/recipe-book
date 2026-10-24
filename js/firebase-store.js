// Firebase (Cloud Firestore) adapter: NOT ACTIVE YET.
//
// Same methods as LocalStore in store.js, so switching is a one-liner once a
// Firebase project exists. Data layout mirrors the local one:
//   users/{uid}/categories/{id}
//   users/{uid}/recipes/{id}
//
// To turn it on later:
//   1. Create a Firebase project, enable Firestore and Authentication (e.g. Google sign-in),
//      and add the GitHub Pages domain under Authentication → Settings → Authorized domains.
//   2. Paste the web config below.
//   3. In app.js, after sign-in:  await setStore(new FirebaseStore(user.uid));
//   4. Move existing recipes up once with: firebaseStore.importAll(await localStore.exportAll())
//
// Recommended Firestore rules:
//   match /users/{uid}/{document=**} { allow read, write: if request.auth.uid == uid; }

import { DEFAULT_CATEGORIES } from './defaults.js';
import { newId } from './store.js';

export const FIREBASE_CONFIG = null; // { apiKey: '…', authDomain: '…', projectId: '…', appId: '…' }

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const now = () => new Date().toISOString();

// Firestore rejects `undefined` values; strip them.
const clean = (obj) => JSON.parse(JSON.stringify(obj));

export class FirebaseStore {
  constructor(uid) {
    this.uid = uid;
    this.listeners = new Set();
    this.cache = { categories: [], recipes: [] };
  }

  async init() {
    const { initializeApp, getApps } = await import(`${SDK}/firebase-app.js`);
    this.fs = await import(`${SDK}/firebase-firestore.js`);
    const app = getApps()[0] || initializeApp(FIREBASE_CONFIG);
    this.db = this.fs.initializeFirestore(app, { localCache: this.fs.persistentLocalCache() });
    this.col = (name) => this.fs.collection(this.db, 'users', this.uid, name);

    // Live sync: changes from other devices update the cache and refresh the UI.
    await Promise.all(['categories', 'recipes'].map((name) => new Promise((resolve) => {
      this.fs.onSnapshot(this.col(name), (snap) => {
        this.cache[name] = snap.docs.map((d) => d.data());
        resolve();
        this.emit();
      });
    })));

    if (this.cache.categories.length === 0) {
      for (const c of DEFAULT_CATEGORIES) await this.saveCategory(c, { silent: true });
    }
  }

  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { for (const cb of this.listeners) cb(); }

  async put(name, rec) {
    await this.fs.setDoc(this.fs.doc(this.col(name), rec.id), clean(rec));
    return rec;
  }

  async listCategories() {
    return [...this.cache.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  }

  async saveCategory(cat) {
    return this.put('categories', { ...cat, id: cat.id || newId(), updatedAt: now(), createdAt: cat.createdAt || now() });
  }

  async deleteCategory(id) {
    const cat = this.cache.categories.find((c) => c.id === id);
    if (!cat) return;
    const batch = this.fs.writeBatch(this.db);
    for (const child of this.cache.categories.filter((c) => c.parentId === id)) {
      batch.update(this.fs.doc(this.col('categories'), child.id), { parentId: cat.parentId ?? null, updatedAt: now() });
    }
    for (const r of this.cache.recipes.filter((r) => r.categoryId === id)) {
      batch.update(this.fs.doc(this.col('recipes'), r.id), { categoryId: null, updatedAt: now() });
    }
    batch.delete(this.fs.doc(this.col('categories'), id));
    await batch.commit();
  }

  async listRecipes() {
    return [...this.cache.recipes].sort((a, b) => a.title.localeCompare(b.title));
  }

  async getRecipe(id) {
    return this.cache.recipes.find((r) => r.id === id);
  }

  async saveRecipe(recipe) {
    return this.put('recipes', { ...recipe, id: recipe.id || newId(), updatedAt: now(), createdAt: recipe.createdAt || now() });
  }

  async deleteRecipe(id) {
    await this.fs.deleteDoc(this.fs.doc(this.col('recipes'), id));
  }

  async exportAll() {
    return { app: 'recipe-book', version: 1, exportedAt: now(), categories: await this.listCategories(), recipes: await this.listRecipes() };
  }

  async importAll(data) {
    if (!data || data.app !== 'recipe-book') throw new Error('That file is not a Recipe Book backup.');
    for (const c of data.categories || []) await this.put('categories', c);
    for (const r of data.recipes || []) await this.put('recipes', r);
    return { categories: (data.categories || []).length, recipes: (data.recipes || []).length };
  }
}
