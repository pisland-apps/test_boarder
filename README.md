# Border Day Ledger — deploy checklist

Single-file app: all HTML/CSS/JS lives in `index.html`, plus a separate
`sw.js` service worker for offline caching. There is no build step — just
upload the files.

## Every time you deploy a change

1. Edit `index.html` (and/or `sw.js`) as needed.
2. **Bump the version marker in `index.html`** — near the top of the
   inline `<script>`, the `APP_VERSION` / `APP_VERSION_DATE` constants.
   This drives the small badge shown bottom-right of the screen (visible
   even on the lock screen, before the password is entered). It's a
   display label only — nothing else reads it.
3. **Bump `CACHE_NAME` in `sw.js`** (e.g. `...-cache-v8` → `...-cache-v9`).
   This is what actually forces the service worker to fetch fresh files
   instead of serving the old cached `index.html` to returning visitors.
4. Upload **all changed files together** (`index.html` + `sw.js`, plus any
   icon/manifest changes) — never deploy just one.
5. After deploying, open the app and check the version badge. If it
   doesn't match what you just shipped, the browser is likely still
   running the old cached build — hard refresh (Ctrl/Cmd+Shift+R) or clear
   the Service Worker/cache storage for the site in devtools, rather than
   assuming the deploy itself failed.

## Why two separate version markers?

`APP_VERSION` (in `index.html`) and `CACHE_NAME` (in `sw.js`) live in
different files and do **not** sync automatically — each file has a
comment pointing at the other as a reminder. Bump them together.

## Current versions

- `APP_VERSION`: `v8` (`index.html`)
- `CACHE_NAME`: `border-day-ledger-cache-v8` (`sw.js`)
