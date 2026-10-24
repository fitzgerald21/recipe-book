# Recipe Book

A phone-first recipe book. Paste a link, an email, or snap a photo of a recipe card, and AI turns it into a clean, easy-to-read recipe filed under the right category.

**Open it:** https://fitzgerald21.github.io/recipe-book/

## Install on iPhone
1. Open the link above in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open **Recipes** from your home screen and sign in with Google.
4. Tap ⚙︎ and paste an API key.

## Adding recipes
- **🔗 Link**: paste any recipe page. The app reads the page and drops the ads and life story.
- **✉️ Text / Email**: copy the email (or any notes) and paste it in, or open a `.txt`/`.eml` file.
- **📷 Photo**: cookbook pages, handwritten cards, screenshots. Add several photos for multi-page recipes.

You review the result (and can change anything) before saving. The AI suggests a category, and you can move a recipe anytime from its page.

**Shortcut tip:** an iOS Shortcut can send links straight in. Open
`https://fitzgerald21.github.io/recipe-book/#/add?url=<link>` and it converts automatically.

## AI providers
Settings has three providers. Pick one as **Main**, and if it fails the app can try the others:

| Provider | Default model |
|---|---|
| OpenRouter | `deepseek/deepseek-v4.1-flash-1017` |
| DeepInfra | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Anthropic | `claude-haiku-5-5` |

You can type any model id. DeepSeek V4.1 Flash reads photos too.

## Accounts and where data lives
Anyone can sign in with a Google account and gets their own recipe book. Recipes are stored in Firebase (Cloud Firestore) under that account, so they sync across devices and still work offline. Recipes saved on a phone before sign-in move into the account the first time it signs in there.

API keys are stored on the phone (localStorage) and only sent to the provider you chose. They are never synced.

Firebase setup, the data model and the shared security rules are described in [FIREBASE.md](FIREBASE.md).

## Code
Plain HTML/CSS/JS with no build step. GitHub Pages serves the repo root.

- `js/app.js`: screens and navigation
- `js/ai.js`: prompt and provider calls
- `js/importers.js`: link fetching (via public reader proxies) and photo resizing
- `js/store.js`: storage interface (and the old on-device adapter)
- `js/firebase-store.js`: Google sign-in and the Firestore adapter
- `js/firebase-config.js`: Firebase web app config
- `js/defaults.js`: starting categories and model presets
- `sw.js`: offline support
