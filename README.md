# Border Day Ledger — deploy checklist

App logic lives in `app.js`, markup/CSS in `index.html`, plus a separate
`sw.js` service worker for offline caching, and a `lib/` folder holding a
locally-vendored copy of pdf.js (used by the attachment viewer for PDF
attachments — see "PDF attachments" below). There is no build step — just
upload the files together.

## Every time you deploy a change

1. Edit `app.js` / `index.html` / `sw.js` as needed.
2. **Bump the version marker in `app.js`** — near the top, the
   `APP_VERSION` / `APP_VERSION_DATE` constants. This drives the small
   badge shown bottom-right of the screen (visible even on the lock
   screen, before the password is entered). It's a display label only —
   nothing else reads it.
3. **Bump `CACHE_NAME` in `sw.js`** (e.g. `...-cache-v11` → `...-cache-v12`).
   This is what actually forces the service worker to fetch fresh files
   instead of serving the old cached copy to returning visitors.
4. Upload **all changed files together** (`index.html` + `app.js` +
   `sw.js` + `lib/`, plus any icon/manifest changes) — never deploy just
   one. GitHub Pages in particular will serve a broken mix of old/new
   files if you only push some of them.
5. After deploying, open the app and check the version badge. If it
   doesn't match what you just shipped, the browser is likely still
   running the old cached build — hard refresh (Ctrl/Cmd+Shift+R) or clear
   the Service Worker/cache storage for the site in devtools, rather than
   assuming the deploy itself failed.

## PDF attachments

Trip attachments accept images *or* PDFs (up to 8MB per PDF). Both are
stored the same way as before — a single base64 `data:` URL per attachment,
type-sniffed from its own mime prefix, so no storage-schema change or
migration was needed.

PDFs are rendered inside the existing attachment viewer modal via
[pdf.js](https://mozilla.github.io/pdf.js/), vendored locally at
`lib/pdf.min.mjs` + `lib/pdf.worker.min.mjs` (pdfjs-dist 6.2.108) rather
than pulled from a CDN — same pattern as the sibling `tax-tracker` app.
JSZip (used for the encrypted ZIP backup/import feature) is vendored the
same way at `lib/jszip.min.js` (v3.10.1) — it used to be loaded from
cdnjs.cloudflare.com, but that meant ZIP export/import broke if that CDN
was unreachable, and it was the one remaining third-party origin in
`script-src`. `script-src` is now `'self'` only.

**pdf.js update history:** as of v17 this was bumped from the previously
vendored 3.11.174 (2023) to 6.2.108 — the old version had a known
arbitrary-JS-execution vulnerability in font handling (CVE-2024-4367,
fixed upstream in 4.2.67). This was not a drop-in file swap: pdfjs-dist
v4+ dropped the classic global-script build entirely and ships ESM-only
(`pdf.min.mjs` / `pdf.worker.min.mjs`, no more `.js` build with
`window.pdfjsLib`). To land it, `app.js` now imports pdf.js directly
(`import * as pdfjsLib from './lib/pdf.min.mjs'` at the top of the
file) and is itself loaded as `<script type="module" src="app.js">` in
`index.html`, and the standalone `<script src="lib/pdf.min.js">` tag
that used to precede it is gone.

**To update either library later:** JSZip — replace `lib/jszip.min.js`
with a newer version and redeploy, no code changes needed unless its API
changed. pdf.js — check whether the new `pdfjs-dist` release still ships
`build/pdf.min.mjs` + `build/pdf.worker.min.mjs` under the same names
(it has since v4); if so it's still just a file swap, since app.js
already imports it as a module. Also re-check the CVE feed for
`pdfjs-dist` on npm/Snyk periodically — this app has no dependency
scanner running, so nothing will flag a new vendored-library CVE
automatically.

JSON/ZIP export and import both carry PDF attachments correctly (ZIP
entries get a `.pdf` extension instead of the image default of `.jpg`, and
import reconstructs the right mime prefix from that extension).

## Why two separate version markers?

`APP_VERSION` (in `app.js`) and `CACHE_NAME` (in `sw.js`) live in
different files and do **not** sync automatically — each file has a
comment pointing at the other as a reminder. Bump them together.

## App logic lives in app.js, not inline `<script>` — here's why

Earlier deploys (through v11) kept all app logic in two inline
`<script>` blocks in `index.html`, allow-listed in the CSP by exact
sha256 hash instead of `'unsafe-inline'`. That turned out to be fragile
in practice: **after deploying v11 to GitHub Pages, every button on the
page silently stopped working.** The cause was a CSP hash mismatch —
something in the local→GitHub Pages upload path changed a byte in one of
the inline script blocks (this class of drift is usually git line-ending
normalization or an editor/upload pipeline touching whitespace), so its
computed hash no longer matched the one hard-coded in the CSP `<meta>`
tag. Chrome then silently blocked that script from running — the page
still loads, nothing errors visibly unless you specifically open the
DevTools Console and look for a CSP violation line. This is the second
time this exact failure hit this app (a *different* stale hash, for the
service-worker registration script, was also found and fixed in the v11
deploy) — recomputing hashes by hand on every edit is what caused it.

**Fix applied in v12: moved all app logic into `app.js`, loaded via
`<script src="app.js"></script>`.** `script-src 'self'` already covers
same-origin external scripts with no hash required, so there is nothing
left to keep in sync — this whole failure class is now structurally
impossible for this app, the same way `tax-tracker` and `ledger-pwa`
already avoid it. If you ever see "every button suddenly does nothing"
again on an app in this family, check the DevTools Console for a CSP
violation first — it's the signature symptom of a stale hash, and if a
file still uses inline hash-locked scripts, the permanent fix is the
same one applied here: move the code to an external `.js` file.

## Current versions

- `APP_VERSION`: `v17` (`app.js`)
- `CACHE_NAME`: `border-day-ledger-cache-v17` (`sw.js`)
