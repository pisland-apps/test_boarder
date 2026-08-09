# Border Day Ledger — deploy checklist

Single-file app: all HTML/CSS/JS lives in `index.html`, plus a separate
`sw.js` service worker for offline caching, and a `lib/` folder holding a
locally-vendored copy of pdf.js (used by the attachment viewer for PDF
attachments — see "PDF attachments" below). There is no build step — just
upload the files.

## Every time you deploy a change

1. Edit `index.html` (and/or `sw.js`) as needed.
2. **Bump the version marker in `index.html`** — near the top of the
   inline `<script>`, the `APP_VERSION` / `APP_VERSION_DATE` constants.
   This drives the small badge shown bottom-right of the screen (visible
   even on the lock screen, before the password is entered). It's a
   display label only — nothing else reads it.
3. **Bump `CACHE_NAME` in `sw.js`** (e.g. `...-cache-v10` → `...-cache-v11`).
   This is what actually forces the service worker to fetch fresh files
   instead of serving the old cached `index.html` to returning visitors.
4. Upload **all changed files together** (`index.html` + `sw.js` + `lib/`,
   plus any icon/manifest changes) — never deploy just one.
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
`lib/pdf.min.js` + `lib/pdf.worker.min.js` (pdfjs-dist 3.11.174) rather
than pulled from a CDN — same pattern as the sibling `tax-tracker` app.
This keeps `script-src` free of a pdf.js CDN origin (only `cdnjs.cloudflare.com`
remains, for JSZip) and avoids an SRI hash that would need to stay in sync
with a CDN version string. To update pdf.js later, replace both files in
`lib/` with a matching version pair from the same pdfjs-dist release and
redeploy — no code changes needed unless the API itself changed.

JSON/ZIP export and import both carry PDF attachments correctly (ZIP
entries get a `.pdf` extension instead of the image default of `.jpg`, and
import reconstructs the right mime prefix from that extension).

## Why two separate version markers?

`APP_VERSION` (in `index.html`) and `CACHE_NAME` (in `sw.js`) live in
different files and do **not** sync automatically — each file has a
comment pointing at the other as a reminder. Bump them together.

## Editing the inline `<script>` blocks

This file's CSP allow-lists its two inline `<script>` blocks by exact
sha256 hash instead of `'unsafe-inline'`. If you change so much as one
character inside either block, **you must recompute and swap in its new
hash** in the `script-src` line of the CSP `<meta>` tag near the top of
`index.html`, or the browser will silently block that script — the page
loads but every button does nothing. See the in-file comment right above
the CSP meta tag for the exact `openssl` recompute command.

⚠ Note: as of the v11 deploy, the *previous* CSP hash for the second
(service-worker registration) inline script was found to be stale/wrong —
it didn't match that script's actual bytes, meaning offline caching may
have been silently broken in earlier deploys without any visible error
short of checking the browser console for a CSP violation. Both hashes
were recomputed and verified byte-for-byte against the shipped file as
part of this deploy. If you ever suspect a hash mismatch, don't just trust
the in-file comment's example command output — recompute and diff both
values explicitly, the way this deploy did.

## Current versions

- `APP_VERSION`: `v11` (`index.html`)
- `CACHE_NAME`: `border-day-ledger-cache-v11` (`sw.js`)
