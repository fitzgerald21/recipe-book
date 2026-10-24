# Recipe Book and Firebase

Recipe Book requires Google sign-in. **Anyone with a Google account can sign in**, and each account gets its own recipe book, synced across every device it signs in on.

## Status
- **Done:** web app registration, Google sign-in, Firestore storage with live sync and offline use, a one-time move of recipes saved on the device before sign-in, and the shared rules (with a Recipe Book block).
- **Not yet tested on the live site** with a real Google account, a second device, or the iPhone home-screen app. Check those first.
- **Not yet built:** a way to delete an account's recipes from inside the app (signing out leaves them in the account).

## Project setup
- Recipe Book lives in the shared **`come-back-fitz21`** project, alongside Come back, Little Bites and One Line a Day. It has its own web app registration ("Recipe Book"), and its config is in `js/firebase-config.js`.
- **Firestore has one ruleset per project, shared by every app in it.** `firestore.rules` (and `storage.rules`) are kept **identical** in the Recipe Book, Come back, Little Bites and One Line a Day repos, so deploying from any of them is safe. If you edit one, copy it to the others.
- Unlike Little Bites and One Line a Day, Recipe Book's data isn't locked to one email: any signed-in user can read and write only their own `users/{uid}/recipes` and `users/{uid}/recipeCategories`.
- Google sign-in and the `fitzgerald21.github.io` authorized domain are already set up for the other apps. `localhost` is authorized by default for local testing.
- Recipe Book doesn't use Storage. Recipe photos are small JPEG data URLs (480px) inside each recipe document.
- Deploy rules with: `firebase deploy --only firestore:rules --project come-back-fitz21`

## Data model
```
users/{uid}/recipeCategories/{id}   { id, name, parentId|null, order, emoji, createdAt, updatedAt }
users/{uid}/recipes/{id}            { id, title, description, categoryId|null, servings, prepTime, cookTime,
                                      totalTime, ingredients, steps, notes, tags, source, image, favorite,
                                      createdAt, updatedAt }
```
These paths don't overlap with the other apps (`users/{uid}`, `.../sessions`, `.../babies`, `.../entries`, `.../settings`). The rules require each document's `id` field to match its document id, a string `title` (500 characters at most) on recipes, and a string `name` (200 characters at most) on categories.

**Never leaves the device:** AI provider keys and model choices (`localStorage` `recipe-book.settings`).

## How it behaves
- **Sign-in:** the app opens on a "Continue with Google" screen until someone signs in. Sign-in uses a popup and falls back to a full-page redirect where popups are blocked. Sign out is in Settings → Account.
- **New accounts** get the starting categories from `js/defaults.js`. Before seeding them, the app asks the server whether the account already has categories, because the offline cache on a new device is always empty.
- **Recipes from before sign-in:** the first time an account signs in on a device, recipes and categories that only exist in that device's IndexedDB are copied into the account. Where the account already has the same id, the account's copy wins. The device's own copy is left untouched. This runs once per account per device (`localStorage` `recipe-book.migrated.<uid>`), and waits for a later launch if the server can't be reached.
- **Offline:** Firestore's persistent cache keeps the book readable and editable without signal. Edits queue and upload when the connection returns. The service worker caches the Firebase SDK, so the app opens offline once it has been loaded online.
- **Live updates:** a change made on another device shows up here on its own.
- **Backups:** Settings → Export backup still works. Importing merges the backup into the account.

Code: `js/firebase-store.js` (sign-in and the Firestore adapter), `js/firebase-config.js`, `js/store.js` (the store interface and the old on-device `LocalStore`), and the start-up code at the bottom of `js/app.js`.
