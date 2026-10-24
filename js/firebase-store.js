// Firebase adapter: Google sign-in + Cloud Firestore. This is the active store; see FIREBASE.md.
//
// Same methods as LocalStore in store.js. Everything lives under the signed-in user:
//   users/{uid}/recipeCategories/{id}
//   users/{uid}/recipes/{id}
// (Other apps in the shared project use users/{uid}, .../sessions, .../babies, .../entries and
// .../settings, so these names must not collide with theirs.)
//
// Firestore's persistent cache keeps the book readable and editable offline; writes queue and upload
// when the connection returns. Snapshot listeners keep an in-memory copy current, so changes made on
// another device show up here on their own. Writes update that copy straight away and don't wait for
// the server, otherwise saving offline would hang until the signal came back.

import { DEFAULT_CATEGORIES } from './defaults.js';
import { FIREBASE_CONFIG } from './firebase-config.js';
import { newId } from './store.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const COLLECTIONS = { categories: 'recipeCategories', recipes: 'recipes' };
// Firestore batches hold at most 500 writes and a request at most 10 MiB; recipes carry a photo,
// so batches are also cut by size.
const BATCH_WRITES = 400;
const BATCH_BYTES = 4 * 1024 * 1024;
const now = () => new Date().toISOString();

// Firestore rejects `undefined` values; strip them.
const clean = (obj) => JSON.parse(JSON.stringify(obj));

let sdkPromise = null;
function loadSdk() {
  sdkPromise ||= (async () => {
    const [appM, authM, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = appM.initializeApp(FIREBASE_CONFIG);
    const auth = authM.getAuth(app);
    // Auto long-polling: some networks, VPNs and extensions block Firestore's streaming connection.
    const db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      experimentalAutoDetectLongPolling: true,
    });
    return { authM, fs, auth, db };
  })();
  sdkPromise.catch(() => { sdkPromise = null; }); // e.g. offline on the very first open: try again next time
  return sdkPromise;
}

/** Google sign-in. Any Google account can sign in and gets its own recipe book. */
export const account = {
  /** The signed-in user (restoring an earlier session, also offline), or null. */
  async current() {
    const { authM, auth } = await loadSdk();
    await authM.getRedirectResult(auth).catch(() => {});
    await auth.authStateReady();
    return auth.currentUser;
  },
  /** Resolves with the user, or null when the page is about to leave for a full-page sign-in. */
  async signIn() {
    const { authM, auth } = await loadSdk();
    const provider = new authM.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      return (await authM.signInWithPopup(auth, provider)).user;
    } catch (e) {
      // Popups are blocked in some home-screen (installed app) setups; fall back to a full-page sign-in.
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
        await authM.signInWithRedirect(auth, provider);
        return null;
      }
      throw e;
    }
  },
  async signOut() {
    const { authM, auth } = await loadSdk();
    await authM.signOut(auth);
  },
};

export class FirebaseStore {
  /**
   * @param {{uid: string}} user  the signed-in Firebase user
   * @param {{migrateFrom?: object, onError?: (e: Error) => void, onMigrated?: (counts) => void}} opts
   *   migrateFrom: a LocalStore whose recipes are copied into the account once per account on this device.
   */
  constructor(user, { migrateFrom = null, onError = console.error, onMigrated = () => {} } = {}) {
    this.uid = user.uid;
    this.migrateFrom = migrateFrom;
    this.onError = onError;
    this.onMigrated = onMigrated;
    this.listeners = new Set();
    this.unsubs = [];
    this.cache = { categories: [], recipes: [] };
  }

  async init() {
    const { fs, db } = await loadSdk();
    this.fs = fs;
    this.db = db;
    this.col = (key) => fs.collection(db, 'users', this.uid, COLLECTIONS[key]);
    this.ref = (key, id) => fs.doc(this.col(key), id);

    await Promise.all(Object.keys(COLLECTIONS).map((key) => new Promise((resolve, reject) => {
      let first = true;
      this.unsubs.push(fs.onSnapshot(this.col(key), (snap) => {
        this.cache[key] = snap.docs.map((d) => d.data());
        if (first) { first = false; resolve(); } else this.emit();
      }, (e) => { if (first) reject(e); else this.onError(e); }));
    })));

    // Runs in the background so the book opens straight away, even offline.
    this.settle().catch((e) => console.warn('Recipe Book: account setup will retry on the next launch', e));
  }

  /**
   * Decisions that depend on what the account already holds. They need the server's answer, not the
   * offline cache (which is empty on a new device and would make every account look brand new).
   */
  async settle() {
    const { fs } = this;
    const flag = `recipe-book.migrated.${this.uid}`;
    let hasCategories;
    if (this.migrateFrom && !localStorage.getItem(flag)) {
      const [cats, recs] = await Promise.all(['categories', 'recipes'].map((k) => fs.getDocsFromServer(this.col(k))));
      const counts = await this.adopt(await this.migrateFrom.exportAll(), {
        categories: new Set(cats.docs.map((d) => d.id)),
        recipes: new Set(recs.docs.map((d) => d.id)),
      });
      localStorage.setItem(flag, '1');
      if (counts.recipes) this.onMigrated(counts);
      hasCategories = !cats.empty || counts.categories > 0;
    } else {
      hasCategories = !(await fs.getDocsFromServer(fs.query(this.col('categories'), fs.limit(1)))).empty;
    }
    if (!hasCategories) await this.writeAll(DEFAULT_CATEGORIES.map((c) => ['categories', { ...c, createdAt: now(), updatedAt: now() }]));
  }

  /** Copies what only this device has into the account. Where the account already has an id, the account's copy wins. */
  async adopt(local, existing) {
    const cats = local.categories.filter((c) => !existing.categories.has(c.id));
    const recs = local.recipes.filter((r) => !existing.recipes.has(r.id));
    await this.writeAll([...cats.map((c) => ['categories', c]), ...recs.map((r) => ['recipes', r])]);
    return { categories: cats.length, recipes: recs.length };
  }

  /** Writes [key, record] pairs in batches and waits for the server. */
  async writeAll(items) {
    let batch = null; let writes = 0; let bytes = 0;
    for (const [key, rec] of items) {
      const json = JSON.stringify(rec);
      if (batch && (writes >= BATCH_WRITES || bytes + json.length > BATCH_BYTES)) { await batch.commit(); batch = null; }
      if (!batch) { batch = this.fs.writeBatch(this.db); writes = 0; bytes = 0; }
      batch.set(this.ref(key, rec.id), JSON.parse(json));
      writes += 1; bytes += json.length;
    }
    if (batch) await batch.commit();
  }

  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { for (const cb of this.listeners) cb(); }

  /** Starts a write without waiting for the server (it queues while offline); failures are reported. */
  send(promise) { promise.catch((e) => this.onError(e)); }

  upsert(key, rec) {
    this.cache[key] = [...this.cache[key].filter((x) => x.id !== rec.id), rec];
  }

  put(key, rec, silent) {
    const data = clean(rec);
    this.upsert(key, data);
    this.send(this.fs.setDoc(this.ref(key, data.id), data));
    if (!silent) this.emit();
    return data;
  }

  // ---- categories ----
  async listCategories() {
    return [...this.cache.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  }

  async saveCategory(cat, { silent = false } = {}) {
    return this.put('categories', { ...cat, id: cat.id || newId(), updatedAt: now(), createdAt: cat.createdAt || now() }, silent);
  }

  /** Deletes a category. Its subcategories move up to its parent, its recipes become unsorted. */
  async deleteCategory(id) {
    const cat = this.cache.categories.find((c) => c.id === id);
    if (!cat) return;
    const batch = this.fs.writeBatch(this.db);
    for (const child of this.cache.categories.filter((c) => c.parentId === id)) {
      const moved = { ...child, parentId: cat.parentId ?? null, updatedAt: now() };
      batch.set(this.ref('categories', child.id), clean(moved));
      this.upsert('categories', moved);
    }
    for (const r of this.cache.recipes.filter((r) => r.categoryId === id)) {
      const moved = { ...r, categoryId: null, updatedAt: now() };
      batch.set(this.ref('recipes', r.id), clean(moved));
      this.upsert('recipes', moved);
    }
    batch.delete(this.ref('categories', id));
    this.cache.categories = this.cache.categories.filter((c) => c.id !== id);
    this.send(batch.commit());
    this.emit();
  }

  // ---- recipes ----
  async listRecipes() {
    return [...this.cache.recipes].sort((a, b) => a.title.localeCompare(b.title));
  }

  async getRecipe(id) {
    return this.cache.recipes.find((r) => r.id === id);
  }

  async saveRecipe(recipe, { silent = false } = {}) {
    return this.put('recipes', { ...recipe, id: recipe.id || newId(), updatedAt: now(), createdAt: recipe.createdAt || now() }, silent);
  }

  async deleteRecipe(id) {
    this.cache.recipes = this.cache.recipes.filter((r) => r.id !== id);
    this.send(this.fs.deleteDoc(this.ref('recipes', id)));
    this.emit();
  }

  // ---- backup ----
  async exportAll() {
    return { app: 'recipe-book', version: 1, exportedAt: now(), categories: await this.listCategories(), recipes: await this.listRecipes() };
  }

  /** Merges a backup in: records with the same id are overwritten, nothing is deleted. */
  async importAll(data) {
    if (!data || data.app !== 'recipe-book') throw new Error('That file is not a Recipe Book backup.');
    const items = [...(data.categories || []).map((c) => ['categories', c]), ...(data.recipes || []).map((r) => ['recipes', r])];
    for (const [key, rec] of items) this.upsert(key, clean(rec));
    this.send(this.writeAll(items));
    this.emit();
    return { categories: (data.categories || []).length, recipes: (data.recipes || []).length };
  }
}
