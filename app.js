// Border Day Ledger — application logic
// Extracted from inline <script> blocks into this external file so the
// Content-Security-Policy can allow-list it via script-src 'self' with no
// sha256 hash to keep in sync — same pattern as the sibling tax-tracker app.
// See README.md for why this change was made (a CSP hash mismatch after
// deploying to GitHub Pages silently broke every button on the page).

(function(){
  // pdf.js worker — vendored locally at ./lib/pdf.worker.min.js (same
  // pdfjs-dist 3.11.174 package as ./lib/pdf.min.js loaded above). Used by
  // the attachment viewer to render PDF pages onto <canvas> instead of
  // relying on the browser's own PDF handling, which can silently trigger
  // a download or render blank depending on the browser's PDF setting.
  if(window.pdfjsLib){
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }

  // ---------------------------------------------------------------------
  // Build version — shown in the small badge fixed to the bottom-right of
  // the screen (visible even before unlocking). This is purely a display
  // label so you can eyeball "did my deploy actually land" and tell the
  // browser apart from what's on disk; it is NOT read by any update logic.
  //
  // It does NOT sync automatically with CACHE_NAME in sw.js — they live in
  // different files. Bump BOTH by hand on every deploy that changes any
  // shipped file:
  //   - here: APP_VERSION / APP_VERSION_DATE
  //   - sw.js: CACHE_NAME (e.g. ...-cache-v8 -> ...-cache-v9)
  // See the reminder comment next to CACHE_NAME in sw.js, and the deploy
  // checklist in README.md.
  //
  // If the badge doesn't match what you expect after deploying, that's a
  // signal the browser is still running old cached code — hard refresh
  // (Ctrl/Cmd+Shift+R) or clear the Service Worker/cache in devtools,
  // rather than assuming the deploy didn't work.
  // ---------------------------------------------------------------------
  const APP_VERSION = 'v12';
  const APP_VERSION_DATE = '2026-08-09';

  // Set immediately (not gated behind unlock) so the badge is visible on
  // the lock screen before the password is entered.
  const versionBadgeEl = document.getElementById('versionBadge');
  if(versionBadgeEl) versionBadgeEl.textContent = APP_VERSION + ' · ' + APP_VERSION_DATE;

  const STORAGE_TRIPS_KEY = 'border-ledger:trips';
  const STORAGE_SETTINGS_KEY = 'border-ledger:settings';

  // Detect whether we're running inside a Claude.ai artifact (window.storage
  // available) or as a standalone downloaded file (open via file:// or a
  // plain web server). When standalone, prefer IndexedDB for local storage
  // (much larger capacity than localStorage, important for image data), and
  // fall back to localStorage only if IndexedDB isn't available.
  const HAS_CLAUDE_STORAGE = (typeof window.storage !== 'undefined' && window.storage
    && typeof window.storage.get === 'function' && typeof window.storage.set === 'function');

  const IDB_NAME = 'border-ledger-db';
  const IDB_STORE = 'kv';
  let idbDB = null;         // set once IndexedDB is successfully opened
  let localBackendName = null; // 'idb' | 'localStorage', for the UI notice

  function openIndexedDB(){
    return new Promise((resolve, reject)=>{
      if(!('indexedDB' in window)){ reject(new Error('indexedDB not available')); return; }
      let req;
      try{ req = indexedDB.open(IDB_NAME, 1); }
      catch(e){ reject(e); return; }
      const timeout = setTimeout(()=> reject(new Error('indexedDB open timed out')), 2500);
      req.onupgradeneeded = (e)=>{
        const db = e.target.result;
        if(!db.objectStoreNames.contains(IDB_STORE)){
          db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e)=>{ clearTimeout(timeout); resolve(e.target.result); };
      req.onerror = (e)=>{ clearTimeout(timeout); reject((e.target && e.target.error) || new Error('indexedDB open failed')); };
      req.onblocked = ()=>{ clearTimeout(timeout); reject(new Error('indexedDB open blocked')); };
    });
  }

  function idbGet(key){
    return new Promise((resolve, reject)=>{
      try{
        const tx = idbDB.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = ()=> resolve(req.result ? req.result.value : null);
        req.onerror = ()=> reject(req.error);
      }catch(e){ reject(e); }
    });
  }

  function idbSet(key, value){
    return new Promise((resolve, reject)=>{
      try{
        const tx = idbDB.transaction(IDB_STORE, 'readwrite');
        const req = tx.objectStore(IDB_STORE).put({ key, value });
        req.onsuccess = ()=> resolve(true);
        req.onerror = ()=> reject(req.error);
      }catch(e){ reject(e); }
    });
  }

  function idbDelete(key){
    return new Promise((resolve, reject)=>{
      try{
        const tx = idbDB.transaction(IDB_STORE, 'readwrite');
        const req = tx.objectStore(IDB_STORE).delete(key);
        req.onsuccess = ()=> resolve(true);
        req.onerror = ()=> reject(req.error);
      }catch(e){ reject(e); }
    });
  }

  // try IndexedDB first when running standalone; only fall back to
  // localStorage if IndexedDB genuinely isn't usable in this browser/context
  async function initLocalBackend(){
    if(HAS_CLAUDE_STORAGE) return;
    try{
      idbDB = await openIndexedDB();
      localBackendName = 'idb';
    }catch(e){
      console.warn('[border-ledger] IndexedDB unavailable, falling back to localStorage:', e);
      idbDB = null;
      localBackendName = 'localStorage';
    }
  }

  // raw, UNENCRYPTED key/value access to whichever backend is active. Only the
  // crypto/lock module below should ever touch this directly; every other
  // part of the app goes through `appStorage`, which transparently encrypts.
  const rawStorage = {
    async get(key, shared){
      if(HAS_CLAUDE_STORAGE) return window.storage.get(key, shared);
      if(idbDB){
        const value = await idbGet(key);
        return (value === null || value === undefined) ? null : { key, value, shared: !!shared };
      }
      const raw = localStorage.getItem(key);
      return raw === null ? null : { key, value: raw, shared: !!shared };
    },
    async set(key, value, shared){
      if(HAS_CLAUDE_STORAGE) return window.storage.set(key, value, shared);
      if(idbDB){
        await idbSet(key, value);
        return { key, value, shared: !!shared };
      }
      localStorage.setItem(key, value); // throws if quota exceeded — caller handles it
      return { key, value, shared: !!shared };
    },
    async delete(key, shared){
      if(HAS_CLAUDE_STORAGE) return window.storage.delete(key, shared);
      if(idbDB){
        await idbDelete(key);
        return { key, deleted:true, shared: !!shared };
      }
      localStorage.removeItem(key);
      return { key, deleted:true, shared: !!shared };
    }
  };

  async function wipeAllLocalData(){
    if(HAS_CLAUDE_STORAGE){
      try{
        const listing = await window.storage.list('border-ledger:', false);
        const keys = (listing && listing.keys) || [];
        for(const k of keys){ try{ await window.storage.delete(k, false); }catch(e){} }
      }catch(e){ console.error('[border-ledger] wipe (claude storage) failed', e); }
    } else if(idbDB){
      await new Promise((resolve)=>{
        try{
          const tx = idbDB.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).clear();
          tx.oncomplete = ()=>resolve();
          tx.onerror = ()=>resolve();
        }catch(e){ resolve(); }
      });
    } else {
      Object.keys(localStorage).filter(k=>k.startsWith('border-ledger:')).forEach(k=>localStorage.removeItem(k));
    }
  }

  // ---------------------------------------------------------------------
  // App-lock: PBKDF2 (SHA-256) key derivation + AES-GCM encryption via
  // Web Crypto. Every value written through `appStorage` below (trip
  // records, settings, and every stored image) is stored as an encrypted
  // {iv, ct} envelope. The derived key only ever lives in memory for the
  // current session — nothing about the passcode itself is ever stored.
  // ---------------------------------------------------------------------
  const PBKDF2_ITERATIONS = 210000;
  const LOCK_META_KEY = 'border-ledger:lock-meta';
  const LOCK_CHECK_PLAINTEXT = 'border-ledger-unlock-check-v1';
  let sessionKey = null; // CryptoKey, in-memory only

  function randomBytes(n){ const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
  function bufToB64(buf){
    const bytes = new Uint8Array(buf);
    let bin = '';
    for(let i=0; i<bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64){
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for(let i=0; i<bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  async function deriveKey(passcode, saltBytes, iterations){
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name:'PBKDF2', salt: saltBytes, iterations: iterations || PBKDF2_ITERATIONS, hash:'SHA-256' },
      baseKey,
      { name:'AES-GCM', length:256 },
      false,
      ['encrypt','decrypt']
    );
  }

  async function aesEncryptString(key, plaintext){
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return { iv: bufToB64(iv), ct: bufToB64(ct) };
  }
  async function aesDecryptToString(key, envelope){
    const iv = new Uint8Array(b64ToBuf(envelope.iv));
    const ptBuf = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, b64ToBuf(envelope.ct));
    return new TextDecoder().decode(ptBuf);
  }

  async function getLockMeta(){
    const r = await rawStorage.get(LOCK_META_KEY, false).catch(()=>null);
    if(!r) return null;
    try{ return JSON.parse(r.value); }catch(e){ return null; }
  }
  async function saveLockMeta(meta){
    await rawStorage.set(LOCK_META_KEY, JSON.stringify(meta), false);
  }

  // Reads every existing record through `oldKey` (or as plaintext if oldKey
  // is null, for the very first setup) and rewrites it encrypted under
  // `newKey`. Used both for first-time setup (migrating any pre-existing
  // unencrypted data) and for changing the passcode later.
  async function reencryptAllData(oldKey, newKey){
    async function readPlain(rec){
      if(!rec) return null;
      if(!oldKey) return rec.value;
      const envelope = JSON.parse(rec.value);
      return aesDecryptToString(oldKey, envelope);
    }
    async function writeEncrypted(k, plaintext){
      const env = await aesEncryptString(newKey, plaintext);
      await rawStorage.set(k, JSON.stringify(env), false);
    }

    const tripsRec = await rawStorage.get(STORAGE_TRIPS_KEY, false).catch(()=>null);
    const settingsRec = await rawStorage.get(STORAGE_SETTINGS_KEY, false).catch(()=>null);
    const tripsPlain = await readPlain(tripsRec);
    const settingsPlain = await readPlain(settingsRec);

    let tripsArr = [];
    if(tripsPlain){ try{ tripsArr = JSON.parse(tripsPlain) || []; }catch(e){ tripsArr = []; } }

    if(tripsPlain !== null) await writeEncrypted(STORAGE_TRIPS_KEY, tripsPlain);
    if(settingsPlain !== null) await writeEncrypted(STORAGE_SETTINGS_KEY, settingsPlain);

    for(const t of tripsArr){
      const ids = t.imageIds || (t.hasImage ? ['legacy'] : []);
      for(const imgId of ids){
        const k = imageStorageKey(t.id, imgId);
        const rec = await rawStorage.get(k, false).catch(()=>null);
        const plain = await readPlain(rec);
        if(plain !== null) await writeEncrypted(k, plain);
      }
    }
  }

  async function setupPasscode(passcode){
    const salt = randomBytes(16);
    const newKey = await deriveKey(passcode, salt, PBKDF2_ITERATIONS);
    await reencryptAllData(null, newKey); // migrate any pre-existing plaintext data
    const check = await aesEncryptString(newKey, LOCK_CHECK_PLAINTEXT);
    await saveLockMeta({ v:1, salt: bufToB64(salt), iterations: PBKDF2_ITERATIONS, check });
    sessionKey = newKey;
  }

  // Checks a passcode against the stored lock-meta check value without
  // side effects (does not set sessionKey). Used by tryUnlock, changePasscode,
  // and biometric enrollment (to confirm identity before wrapping the passcode).
  async function verifyPasscodeAgainstMeta(passcode, meta){
    try{
      const salt = new Uint8Array(b64ToBuf(meta.salt));
      const key = await deriveKey(passcode, salt, meta.iterations || PBKDF2_ITERATIONS);
      const pt = await aesDecryptToString(key, meta.check);
      return pt === LOCK_CHECK_PLAINTEXT ? key : null;
    }catch(e){ return null; }
  }
  async function verifyPasscode(passcode){
    const meta = await getLockMeta();
    if(!meta) return false;
    return !!(await verifyPasscodeAgainstMeta(passcode, meta));
  }

  async function tryUnlock(passcode){
    const meta = await getLockMeta();
    if(!meta) return false;
    const key = await verifyPasscodeAgainstMeta(passcode, meta);
    if(!key) return false;
    sessionKey = key;
    return true;
  }

  async function changePasscode(oldPass, newPass){
    const meta = await getLockMeta();
    if(!meta) throw new Error('no-lock-meta');
    const oldKey = await verifyPasscodeAgainstMeta(oldPass, meta);
    if(!oldKey) throw new Error('wrong-old-passcode');

    const newSalt = randomBytes(16);
    const newKey = await deriveKey(newPass, newSalt, PBKDF2_ITERATIONS);
    await reencryptAllData(oldKey, newKey);
    const check = await aesEncryptString(newKey, LOCK_CHECK_PLAINTEXT);
    await saveLockMeta({ v:1, salt: bufToB64(newSalt), iterations: PBKDF2_ITERATIONS, check });
    sessionKey = newKey;
    // the old passcode is no longer valid — any biometric-wrapped copy of it
    // is now stale, so drop it rather than leave a silent way in with a dead passcode
    await disableBiometricUnlock();
  }

  // ---------------------------------------------------------------------
  // Optional biometric unlock (Face ID / Touch ID / Android fingerprint).
  // Dual-mode, decided once per enrollment:
  //
  //   1. PRF mode (preferred): the wrapping key is derived directly from
  //      the WebAuthn PRF extension output, so the key is cryptographically
  //      bound to the biometric result itself.
  //   2. Gate mode (fallback): the fingerprint/Face prompt is only a UX
  //      gate. A separate, randomly generated, NON-EXTRACTABLE AES-GCM key
  //      wraps the *actual passcode*; that wrapping key is stored as a real
  //      CryptoKey object (not exported bytes) via IndexedDB's structured
  //      clone, so page JS can use it to decrypt again later but can never
  //      read it out as raw bytes.
  //
  // PRF support is inconsistent across Android/Chrome versions/OEMs — on
  // some real devices `navigator.credentials.create()` with a `prf`
  // extension request fails outright, and on others `create()` succeeds but
  // never actually returns usable PRF output. enableBiometricUnlock() tries
  // PRF first and silently falls back to gate mode whenever either of those
  // happens, so enrollment succeeds either way. Which mode was used is
  // recorded in the stored record and tryBiometricUnlock() branches on it.
  // In both modes the passcode itself always remains the required
  // fallback/recovery mechanism.
  //
  // Because gate mode's wrapping key is a real (non-JSON-serializable)
  // CryptoKey object, this whole feature only works on the 'idb' local
  // backend (raw IndexedDB) — not the Claude.ai window.storage bridge or
  // the localStorage fallback, both of which only accept strings. In
  // practice that's not a real limitation: WebAuthn platform authenticators
  // only work over https/localhost on a real device anyway, which is
  // exactly the standalone-deploy 'idb' scenario.
  // ---------------------------------------------------------------------
  const BIO_META_KEY = 'border-ledger:biometric-unlock';

  function biometricSupported(){
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }
  async function biometricPlatformAvailable(){
    if(!biometricSupported()) return false;
    if(!idbDB) return false; // needs raw IndexedDB to store the CryptoKey object — see note above
    try{ return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch(e){ return false; }
  }

  async function deriveAesKeyFromPrfBytes(bytes){
    return crypto.subtle.importKey('raw', bytes, { name:'AES-GCM' }, false, ['encrypt','decrypt']);
  }

  function biometricCreateOptions(withPrf, salt){
    const opts = {
      challenge: randomBytes(32),
      rp: { name: '关口记录簿' },
      user: { id: randomBytes(16), name: 'border-ledger-local', displayName: '关口记录簿本机解锁' },
      pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
      authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required' },
      timeout: 60000,
      attestation: 'none'
    };
    if(withPrf) opts.extensions = { prf: { eval: { first: salt } } };
    return opts;
  }

  async function enableBiometricUnlock(currentPasscode){
    if(!(await biometricPlatformAvailable())){
      alert('这台设备/浏览器不支持指纹或 Face ID 解锁。');
      return false;
    }

    const salt = randomBytes(32);
    let cred = null;
    let prfRequested = true;

    // Attempt 1: register with the PRF extension requested — the stronger
    // binding, key is derived straight from the biometric result.
    try{
      cred = await navigator.credentials.create({ publicKey: biometricCreateOptions(true, salt) });
    }catch(e){
      console.warn('[border-ledger] biometric registration with PRF failed, retrying without PRF', e);
      prfRequested = false;
    }

    // Attempt 2 (fallback): some devices reject credentials.create() outright
    // the instant a `prf` extension is requested. If that happened, retry
    // the exact same registration without asking for PRF at all.
    if(!cred){
      try{
        cred = await navigator.credentials.create({ publicKey: biometricCreateOptions(false, salt) });
      }catch(e2){
        console.error('[border-ledger] biometric registration failed', e2);
        alert('设置指纹/Face ID 解锁失败（可能被取消或设备不支持），请重试。');
        return false;
      }
    }

    // Figure out whether we actually got usable PRF output. It can come
    // back immediately on create(), or only on a follow-up get() on some
    // platforms — and on others it never comes back at all.
    let prfBytes = null;
    if(prfRequested){
      const ext = cred.getClientExtensionResults();
      if(ext && ext.prf && ext.prf.results && ext.prf.results.first){
        prfBytes = ext.prf.results.first;
      } else {
        try{
          const assertion = await navigator.credentials.get({
            publicKey: {
              challenge: randomBytes(32),
              allowCredentials: [{ id: cred.rawId, type:'public-key' }],
              userVerification: 'required',
              extensions: { prf: { eval: { first: salt } } }
            }
          });
          const aext = assertion.getClientExtensionResults();
          prfBytes = aext && aext.prf && aext.prf.results && aext.prf.results.first;
        }catch(e3){ /* leave prfBytes null — falls through to gate mode below */ }
      }
    }

    const iv = randomBytes(12);

    if(prfBytes){
      const bioKey = await deriveAesKeyFromPrfBytes(prfBytes);
      const ctBuf = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, bioKey, new TextEncoder().encode(currentPasscode));
      await idbSet(BIO_META_KEY, {
        v: 3,
        method: 'prf',
        credentialId: bufToB64(cred.rawId),
        salt: bufToB64(salt),
        iv: bufToB64(iv),
        ct: bufToB64(ctBuf)
      });
    } else {
      const wrappingKey = await crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
      const ctBuf = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, wrappingKey, new TextEncoder().encode(currentPasscode));
      await idbSet(BIO_META_KEY, {
        v: 3,
        method: 'gate',
        credentialId: bufToB64(cred.rawId),
        wrappingKey,
        iv: bufToB64(iv),
        ct: bufToB64(ctBuf)
      });
    }
    return true;
  }

  async function disableBiometricUnlock(){
    if(!idbDB) return;
    await idbDelete(BIO_META_KEY).catch(()=>{});
  }

  // returns true on success (also sets sessionKey via tryUnlock); false on
  // any failure/cancellation — caller should fall back to the passcode field
  async function tryBiometricUnlock(){
    if(!idbDB) return false;
    const rec = await idbGet(BIO_META_KEY).catch(()=>null);
    if(!rec) return false;
    // v1/v2 records predate the method field — infer from shape so existing
    // enrollments (created by earlier app versions) keep working.
    const method = rec.method || (rec.wrappingKey ? 'gate' : (rec.salt ? 'prf' : null));
    if(!method) return false;

    if(method === 'prf'){
      let assertion;
      try{
        assertion = await navigator.credentials.get({
          publicKey: {
            challenge: randomBytes(32),
            allowCredentials: [{ id: b64ToBuf(rec.credentialId), type:'public-key' }],
            userVerification: 'required',
            timeout: 60000,
            extensions: { prf: { eval: { first: new Uint8Array(b64ToBuf(rec.salt)) } } }
          }
        });
      }catch(e){ return false; }

      const ext = assertion.getClientExtensionResults();
      const prfBytes = ext && ext.prf && ext.prf.results && ext.prf.results.first;
      if(!prfBytes) return false;

      try{
        const bioKey = await deriveAesKeyFromPrfBytes(prfBytes);
        const iv = new Uint8Array(b64ToBuf(rec.iv));
        const ptBuf = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, bioKey, b64ToBuf(rec.ct));
        const passcode = new TextDecoder().decode(ptBuf);
        return await tryUnlock(passcode);
      }catch(e){
        console.error('[border-ledger] biometric (prf) unwrap failed', e);
        return false;
      }
    }

    // gate mode
    if(!rec.wrappingKey) return false;
    try{
      await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{ id: b64ToBuf(rec.credentialId), type:'public-key' }],
          userVerification: 'required',
          timeout: 60000
        }
      });
    }catch(e){ return false; }

    try{
      const iv = new Uint8Array(b64ToBuf(rec.iv));
      const ptBuf = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, rec.wrappingKey, b64ToBuf(rec.ct));
      const passcode = new TextDecoder().decode(ptBuf);
      return await tryUnlock(passcode);
    }catch(e){
      console.error('[border-ledger] biometric (gate) unwrap failed', e);
      return false;
    }
  }



  // transparent encrypt-before-write / decrypt-after-read wrapper — every
  // other part of the app reads/writes through this, unaware of the crypto
  const appStorage = {
    async get(key, shared){
      const r = await rawStorage.get(key, shared);
      if(!r) return null;
      if(!sessionKey) throw new Error('app is locked');
      let envelope;
      try{ envelope = JSON.parse(r.value); }
      catch(e){ throw new Error('corrupt or unencrypted record for ' + key); }
      if(!envelope || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string'){
        throw new Error('corrupt envelope for ' + key);
      }
      const plaintext = await aesDecryptToString(sessionKey, envelope);
      return { key, value: plaintext, shared: !!shared };
    },
    async set(key, value, shared){
      if(!sessionKey) throw new Error('app is locked');
      const envelope = await aesEncryptString(sessionKey, value);
      return rawStorage.set(key, JSON.stringify(envelope), shared);
    },
    async delete(key, shared){
      return rawStorage.delete(key, shared);
    }
  };

  let trips = [];
  let settings = { base: 'SG' };

  const saveStatusEl = document.getElementById('saveStatus');
  const baseLocationEl = document.getElementById('baseLocation');
  const destSelect = document.getElementById('destSelect');
  const otherNameField = document.getElementById('otherNameField');
  const otherNameInput = document.getElementById('otherName');
  const tripForm = document.getElementById('tripForm');
  const yearCardsEl = document.getElementById('yearCards');
  const overviewYearSelectEl = document.getElementById('overviewYearSelect');
  let selectedOverviewYear = new Date().getFullYear();
  const tripTableWrap = document.getElementById('tripTableWrap');
  const tripImageInput = document.getElementById('tripImage');
  const cameraInput = document.getElementById('cameraInput');
  const cameraBtn = document.getElementById('cameraBtn');
  const transportModeEl = document.getElementById('transportMode');
  const routeDetailEl = document.getElementById('routeDetail');
  const imageThumbList = document.getElementById('imageThumbList');
  const imgModalOverlay = document.getElementById('imgModalOverlay');
  const imgModalImg = document.getElementById('imgModalImg');
  const imgModalCloseBtn = document.getElementById('imgModalCloseBtn');
  const imgModalPrevBtn = document.getElementById('imgModalPrevBtn');
  const imgModalNextBtn = document.getElementById('imgModalNextBtn');
  const imgModalCounter = document.getElementById('imgModalCounter');
  const imgModalPdfWrap = document.getElementById('imgModalPdfWrap');
  const imgModalSaveBtn = document.getElementById('imgModalSaveBtn');

  // pending image state for the form currently being filled
  let pendingNewImages = [];        // array of new dataURL strings picked but not yet saved
  let existingImagesForEdit = [];   // [{imgId, dataURL}] loaded when editing a trip that already has images
  let removedExistingImageIds = new Set(); // imgIds marked for removal on save (edit mode)

  // 'legacy' keeps backward compatibility with trips saved before multi-image
  // support, which stored a single image under a key with no imgId suffix
  function imageStorageKey(tripId, imgId){
    if(!imgId || imgId === 'legacy') return 'border-ledger:image:' + tripId;
    return 'border-ledger:image:' + tripId + ':' + imgId;
  }

  // wraps a storage call with a couple of quiet retries — the storage backend
  // occasionally hiccups on a request that would otherwise succeed, so retry
  // silently before treating it as a real failure
  async function withRetry(fn, retries=2, delayMs=350){
    let lastErr;
    for(let i=0; i<=retries; i++){
      try{
        return await fn();
      }catch(e){
        lastErr = e;
        if(i < retries) await new Promise(res => setTimeout(res, delayMs * (i+1)));
      }
    }
    throw lastErr;
  }

  // sets a text value and confirms it actually landed by reading it back —
  // a "successful" write here isn't always trustworthy on its own, so we
  // don't consider it done until a follow-up read matches what we sent
  async function setVerified(key, payload, attempts=3){
    for(let attempt=0; attempt<attempts; attempt++){
      try{
        await appStorage.set(key, payload, false);
      }catch(e){
        console.error('[border-ledger] storage.set failed for', key, 'attempt', attempt+1, e);
      }

      try{
        const check = await appStorage.get(key, false);
        if(check && check.value === payload) return true;
        console.warn('[border-ledger] verification mismatch for', key, 'attempt', attempt+1,
          check ? ('got ' + check.value.length + ' chars, expected ' + payload.length) : 'no value returned');
      }catch(e2){
        console.error('[border-ledger] verification read failed for', key, 'attempt', attempt+1, e2);
      }

      if(attempt < attempts - 1) await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
    }
    return false;
  }

  async function getTripImage(tripId, imgId){
    try{
      const r = await withRetry(() => appStorage.get(imageStorageKey(tripId, imgId), false));
      return r ? r.value : null;
    }catch(e){ return null; }
  }

  // fetches every image belonging to a trip, in the order listed in imageIds
  async function getTripImages(trip){
    const ids = trip.imageIds || [];
    const results = [];
    for(const imgId of ids){
      const dataURL = await getTripImage(trip.id, imgId);
      if(dataURL) results.push({ imgId, dataURL });
    }
    return results;
  }

  // returns true only once we've read the value back and confirmed it matches
  async function setTripImage(tripId, imgId, dataURL){
    return setVerified(imageStorageKey(tripId, imgId), dataURL);
  }

  async function deleteTripImage(tripId, imgId){
    try{ await withRetry(() => appStorage.delete(imageStorageKey(tripId, imgId), false)); }
    catch(e){ /* ignore if already missing */ }
  }

  async function deleteAllTripImages(trip){
    const ids = trip.imageIds || [];
    for(const imgId of ids){
      await deleteTripImage(trip.id, imgId);
    }
  }

  function newImageId(){
    return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Attachments are stored as a single data: URL string per imgId (same as
  // always) — the mime prefix on that string is enough to tell a PDF apart
  // from an image, so no schema change / migration is needed.
  function isPdfDataURL(s){
    return typeof s === 'string' && s.startsWith('data:application/pdf');
  }

  // used when importing JSON backups — accepts either kind of attachment
  // data URL, rejecting anything else that might have ended up in the file
  function isSupportedAttachmentDataURL(s){
    return typeof s === 'string' && (s.startsWith('data:image') || s.startsWith('data:application/pdf'));
  }

  // PDFs are stored as-is (no client-side compression available like the
  // JPEG re-encode below), so just read the raw file to a data URL.
  function readFileAsDataURL(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=> resolve(reader.result);
      reader.onerror = (err)=>{ console.error('[border-ledger] file read failed', err); reject(err); };
      reader.readAsDataURL(file);
    });
  }

  // resize + compress an image file down to a data URL, capping the longest side
  function resizeImageFile(file, maxDim, quality){
    return new Promise((resolve, reject)=>{
      const img = new Image();
      const reader = new FileReader();
      reader.onload = ()=>{
        img.onload = ()=>{
          let { width, height } = img;
          if(width > maxDim || height > maxDim){
            if(width >= height){ height = Math.round(height * (maxDim/width)); width = maxDim; }
            else { width = Math.round(width * (maxDim/height)); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // iteratively lower quality / dimensions until the payload is a safe size
          let q = quality;
          let dataURL = canvas.toDataURL('image/jpeg', q);
          let guard = 0;
          while(dataURL.length > 700000 && guard < 6){
            q = Math.max(0.35, q - 0.15);
            dataURL = canvas.toDataURL('image/jpeg', q);
            guard++;
          }
          console.log('[border-ledger] image encoded:', Math.round(dataURL.length/1024) + 'KB', 'quality=' + q.toFixed(2), width+'x'+height);
          resolve(dataURL);
        };
        img.onerror = (err)=>{ console.error('[border-ledger] image decode failed', err); reject(err); };
        img.src = reader.result;
      };
      reader.onerror = (err)=>{ console.error('[border-ledger] file read failed', err); reject(err); };
      reader.readAsDataURL(file);
    });
  }

  async function handleIncomingImageFiles(fileList){
    const files = Array.from(fileList || []);
    for(const file of files){
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
      const isImage = file.type.startsWith('image/');
      if(!isImage && !isPdf) continue;
      try{
        if(isPdf){
          if(file.size > 8 * 1024 * 1024){ alert('已跳过 "' + file.name + '"（PDF 超过 8MB）'); continue; }
          const dataURL = await readFileAsDataURL(file);
          pendingNewImages.push(dataURL);
        } else {
          const dataURL = await resizeImageFile(file, 1400, 0.82);
          pendingNewImages.push(dataURL);
        }
      }catch(e){
        alert('有一个文件处理失败，已跳过：' + file.name);
      }
    }
    renderImageThumbList();
  }

  tripImageInput.addEventListener('change', async ()=>{
    await handleIncomingImageFiles(tripImageInput.files);
    tripImageInput.value = ''; // clear so picking the same file again still fires 'change'
  });

  cameraBtn.addEventListener('click', ()=>{
    cameraInput.click();
  });

  cameraInput.addEventListener('change', async ()=>{
    await handleIncomingImageFiles(cameraInput.files);
    cameraInput.value = ''; // clear so taking another photo still fires 'change'
  });

  function attachmentThumbMarkup(dataURL, altText){
    return isPdfDataURL(dataURL)
      ? '<div class="pdf-thumb-icon">📄<span>PDF</span></div>'
      : '<img class="image-thumb" src="' + dataURL + '" alt="' + altText + '">';
  }

  function renderImageThumbList(){
    const items = [];
    existingImagesForEdit.forEach(({imgId, dataURL})=>{
      if(removedExistingImageIds.has(imgId)) return;
      items.push(
        '<div class="image-thumb-item">' +
          attachmentThumbMarkup(dataURL, '已上传图片') +
          '<button type="button" class="image-thumb-remove" data-action="removeExistingImage" data-img-id="' + escapeHtml(imgId) + '" title="移除">×</button>' +
        '</div>'
      );
    });
    pendingNewImages.forEach((dataURL, idx)=>{
      items.push(
        '<div class="image-thumb-item pending">' +
          attachmentThumbMarkup(dataURL, '待上传图片') +
          '<span class="thumb-size">' + Math.round(dataURL.length/1024) + 'KB</span>' +
          '<button type="button" class="image-thumb-remove" data-action="removePendingImage" data-idx="' + idx + '" title="移除">×</button>' +
        '</div>'
      );
    });
    imageThumbList.innerHTML = items.join('');
  }

  function removePendingImage(idx){
    pendingNewImages.splice(idx, 1);
    renderImageThumbList();
  }
  function removeExistingImageFromEdit(imgId){
    removedExistingImageIds.add(imgId);
    renderImageThumbList();
  }

  // event delegation: avoids inline onclick="" handlers so the page can run
  // under a CSP with no 'unsafe-inline' in script-src
  imageThumbList.addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-action]');
    if(!btn || !imageThumbList.contains(btn)) return;
    if(btn.dataset.action === 'removeExistingImage'){
      removeExistingImageFromEdit(btn.dataset.imgId);
    }else if(btn.dataset.action === 'removePendingImage'){
      removePendingImage(Number(btn.dataset.idx));
    }
  });

  function resetImageFormState(){
    pendingNewImages = [];
    existingImagesForEdit = [];
    removedExistingImageIds = new Set();
    tripImageInput.value = '';
    renderImageThumbList();
  }

  // simple gallery state for the image viewer modal
  let modalImages = [];
  let modalIndex = 0;

  // ---------------------------------------------------------------------
  // Mobile hardware/gesture back-button handling for the image viewer.
  // Without this, pressing back while the modal is open closes the whole
  // PWA (it's the only entry in the history stack), which feels like the
  // app crashed. Fix: push a dummy history entry when the modal opens, so
  // "back" just pops that entry (handled via popstate) and closes the
  // modal instead of leaving the app. If the modal is closed by any other
  // means (X button, tapping the backdrop, swiping to the next/prev image
  // doesn't count), we consume that dummy entry ourselves via history.back()
  // so the history stack doesn't accumulate stale entries.
  // ---------------------------------------------------------------------
  let modalHistoryPushed = false;

  function openImageModal(images, startIndex){
    modalImages = images;
    modalIndex = startIndex || 0;
    updateModalView();
    imgModalOverlay.classList.add('open');
    history.pushState({ imgModal: true }, '');
    modalHistoryPushed = true;
  }
  // Bumped on every modal navigation/close so an in-flight async PDF render
  // from a page the user has since left can detect it's stale and bail out
  // instead of drawing canvases into a wrapper nobody's looking at anymore.
  let pdfRenderToken = 0;

  function updateModalView(){
    const cur = modalImages[modalIndex] || '';
    const isPdf = isPdfDataURL(cur);
    const multi = modalImages.length > 1;
    imgModalCounter.textContent = multi ? (modalIndex+1) + ' / ' + modalImages.length : '';
    imgModalPrevBtn.style.display = multi ? 'flex' : 'none';
    imgModalNextBtn.style.display = multi ? 'flex' : 'none';
    imgModalPrevBtn.disabled = modalIndex <= 0;
    imgModalNextBtn.disabled = modalIndex >= modalImages.length - 1;
    imgModalSaveBtn.href = cur;
    imgModalSaveBtn.setAttribute('download', isPdf ? 'border-ledger-attachment.pdf' : 'border-ledger-photo.jpg');

    if(isPdf){
      pdfRenderToken++;
      imgModalImg.src = '';
      imgModalImgWrap.style.display = 'none';
      imgModalPdfWrap.style.display = 'flex';
      imgModalHint.style.display = 'none';
      renderPdfIntoModal(cur, pdfRenderToken);
    } else {
      pdfRenderToken++; // invalidate any still-rendering PDF from the previous item
      imgModalPdfWrap.style.display = 'none';
      imgModalPdfWrap.innerHTML = '';
      imgModalImgWrap.style.display = 'flex';
      imgModalHint.style.display = '';
      imgModalImg.src = cur;
    }
    resetImageZoom();
  }

  // Decodes a data:application/pdf;base64,... URL and draws each page onto
  // its own <canvas> inside #imgModalPdfWrap via pdf.js — deliberately not
  // an <iframe src="data:..."> or a direct navigation, since both can
  // silently fail (blank iframe, or the browser treating it as a download)
  // depending on the browser's own PDF-handling setting.
  async function renderPdfIntoModal(dataURL, token){
    imgModalPdfWrap.innerHTML = '<div style="padding:32px; text-align:center; color:var(--grey-text); font-size:12px;">加载中…</div>';
    try{
      const base64 = dataURL.substring(dataURL.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for(let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      if(token !== pdfRenderToken) return; // user moved on before this resolved

      imgModalPdfWrap.innerHTML = '';
      const containerWidth = Math.min(imgModalPdfWrap.clientWidth || 600, 640);
      for(let pageNum=1; pageNum<=pdf.numPages; pageNum++){
        const page = await pdf.getPage(pageNum);
        if(token !== pdfRenderToken) return;
        const unscaledViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.1, (containerWidth - 16) / unscaledViewport.width);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        imgModalPdfWrap.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        if(token !== pdfRenderToken) return;
      }
    }catch(e){
      if(token !== pdfRenderToken) return;
      console.error('[border-ledger] pdf render failed', e);
      imgModalPdfWrap.innerHTML = '<div style="padding:32px; text-align:center; color:var(--stamp); font-size:12px;">PDF 预览失败，可点击右上角「保存副本」下载后查看。</div>';
    }
  }

  // fromPopstate: true when we're closing *because* the back button already
  // popped our history entry (so we must NOT call history.back() again, or
  // we'd navigate one step further back than intended).
  function closeImageModal(fromPopstate){
    imgModalOverlay.classList.remove('open');
    imgModalImg.src = '';
    pdfRenderToken++;
    imgModalPdfWrap.style.display = 'none';
    imgModalPdfWrap.innerHTML = '';
    modalImages = [];
    resetImageZoom();
    if(modalHistoryPushed){
      modalHistoryPushed = false;
      if(!fromPopstate) history.back();
    }
  }
  window.addEventListener('popstate', ()=>{
    if(imgModalOverlay.classList.contains('open')) closeImageModal(true);
  });
  imgModalPrevBtn.addEventListener('click', ()=>{ if(modalIndex > 0){ modalIndex--; updateModalView(); } });
  imgModalNextBtn.addEventListener('click', ()=>{ if(modalIndex < modalImages.length - 1){ modalIndex++; updateModalView(); } });
  imgModalCloseBtn.addEventListener('click', ()=>closeImageModal(false));
  imgModalOverlay.addEventListener('click', (e)=>{
    if(e.target === imgModalOverlay) closeImageModal(false);
  });

  // -----------------------------------------------------------------------
  // Pinch-to-zoom for the image viewer (two-finger gesture on mobile, with
  // drag-to-pan once zoomed). Fixes two mobile issues:
  //   1. an oversized source image could stretch the flex row wider than
  //      the viewport and push the prev/next buttons off-screen — solved
  //      above by wrapping the <img> in .img-modal-imgwrap (min-width:0,
  //      overflow:hidden) so the image is always clipped to the available
  //      space instead of resizing its siblings;
  //   2. there was no way to enlarge a photo to read fine print — solved
  //      here with a standard two-pointer pinch gesture.
  // -----------------------------------------------------------------------
  const imgModalImgWrap = document.getElementById('imgModalImgWrap');
  const imgModalHint = document.getElementById('imgModalHint');
  let zoomScale = 1, zoomX = 0, zoomY = 0;
  const ZOOM_MIN = 1, ZOOM_MAX = 4;
  let pinchStartDist = 0, pinchStartScale = 1;
  let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0, isPanning = false;
  const activePointers = new Map();

  function applyZoomTransform(){
    imgModalImg.style.transform = 'translate(' + zoomX + 'px,' + zoomY + 'px) scale(' + zoomScale + ')';
    imgModalImg.classList.toggle('zoomed', zoomScale > 1.01);
  }
  function resetImageZoom(){
    zoomScale = 1; zoomX = 0; zoomY = 0; isPanning = false;
    activePointers.clear();
    applyZoomTransform();
  }
  function pointerDist(pts){
    const a = pts[0], b = pts[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  imgModalImgWrap.addEventListener('pointerdown', (e)=>{
    if(!imgModalImg.src) return;
    activePointers.set(e.pointerId, e);
    imgModalImgWrap.setPointerCapture(e.pointerId);
    if(activePointers.size === 2){
      pinchStartDist = pointerDist([...activePointers.values()]);
      pinchStartScale = zoomScale;
    } else if(activePointers.size === 1 && zoomScale > 1.01){
      isPanning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panOriginX = zoomX; panOriginY = zoomY;
    }
  });
  imgModalImgWrap.addEventListener('pointermove', (e)=>{
    if(!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, e);
    if(activePointers.size === 2){
      const dist = pointerDist([...activePointers.values()]);
      if(pinchStartDist > 0){
        zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchStartScale * (dist / pinchStartDist)));
        applyZoomTransform();
      }
    } else if(isPanning && zoomScale > 1.01){
      zoomX = panOriginX + (e.clientX - panStartX);
      zoomY = panOriginY + (e.clientY - panStartY);
      applyZoomTransform();
    }
  });
  function endPointer(e){
    activePointers.delete(e.pointerId);
    if(activePointers.size < 2) pinchStartDist = 0;
    if(activePointers.size === 0){
      isPanning = false;
      if(zoomScale < 1.01){ zoomScale = 1; zoomX = 0; zoomY = 0; applyZoomTransform(); }
    }
  }
  imgModalImgWrap.addEventListener('pointerup', endPointer);
  imgModalImgWrap.addEventListener('pointercancel', endPointer);
  imgModalImgWrap.addEventListener('pointerleave', (e)=>{ if(activePointers.has(e.pointerId)) endPointer(e); });
  // Double-click/double-tap as a quick desktop-friendly toggle too.
  imgModalImgWrap.addEventListener('dblclick', ()=>{
    if(zoomScale > 1.01){ resetImageZoom(); } else { zoomScale = 2; applyZoomTransform(); }
  });

  function flashStatus(msg){
    saveStatusEl.innerHTML = '';
    saveStatusEl.textContent = msg;
    setTimeout(()=>{ if(saveStatusEl.textContent===msg) saveStatusEl.textContent=''; }, 1800);
  }

  // shows a persistent error with a manual retry button (does not auto-clear)
  function flashRetryableError(msg, retryFn){
    saveStatusEl.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '重试';
    btn.style.cssText = 'font-family:var(--sans);font-size:11px;color:var(--stamp);text-decoration:underline;background:none;border:none;cursor:pointer;padding:0;';
    btn.addEventListener('click', ()=>{
      saveStatusEl.textContent = '重试中…';
      retryFn();
    });
    saveStatusEl.appendChild(span);
    saveStatusEl.appendChild(btn);
  }

  async function loadAll(){
    try{
      const t = await withRetry(() => appStorage.get(STORAGE_TRIPS_KEY, false));
      trips = t ? JSON.parse(t.value) : [];
    }catch(e){ trips = []; }
    // migrate trips saved before multi-image support: a single legacy image
    // (if any) was stored under a key with no imgId suffix
    trips.forEach(trip => {
      if(!trip.imageIds && trip.hasImage){
        trip.imageIds = ['legacy'];
      }
      if(!trip.imageIds) trip.imageIds = [];
      delete trip.hasImage;
    });
    try{
      const s = await withRetry(() => appStorage.get(STORAGE_SETTINGS_KEY, false));
      settings = s ? JSON.parse(s.value) : { base:'SG' };
    }catch(e){ settings = { base:'SG' }; }
    baseLocationEl.value = settings.base || 'SG';
    render();
  }

  async function saveTrips(){
    const payload = JSON.stringify(trips);
    const ok = await setVerified(STORAGE_TRIPS_KEY, payload);
    if(ok) flashStatus('已保存');
    else flashRetryableError('保存失败', saveTrips);
  }

  async function saveSettings(){
    const payload = JSON.stringify(settings);
    const ok = await setVerified(STORAGE_SETTINGS_KEY, payload);
    if(ok) flashStatus('设置已保存');
    else flashRetryableError('保存失败', saveSettings);
  }

  destSelect.addEventListener('change', ()=>{
    otherNameField.style.display = destSelect.value === 'OTHER' ? 'flex' : 'none';
  });

  baseLocationEl.addEventListener('change', ()=>{
    settings.base = baseLocationEl.value;
    saveSettings();
    render();
  });

  if(overviewYearSelectEl){
    overviewYearSelectEl.addEventListener('change', ()=>{
      selectedOverviewYear = parseInt(overviewYearSelectEl.value, 10);
      renderYearCards();
    });
  }

  let editingId = null;

  tripForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const dest = destSelect.value;
    const otherName = otherNameInput.value.trim();
    const start = document.getElementById('startDate').value;
    const end = document.getElementById('endDate').value;
    const note = document.getElementById('tripNote').value.trim();
    const transportMode = transportModeEl.value;
    const route = routeDetailEl.value.trim();

    if(!start || !end){ return; }
    if(new Date(end) < new Date(start)){ alert('返回日期不能早于出发日期'); return; }
    if(dest === 'OTHER' && !otherName){ alert('请填写国家名称'); return; }

    if(editingId){
      const idx = trips.findIndex(t => t.id === editingId);
      if(idx !== -1){
        // start from existing images minus any the user removed
        let imageIds = (trips[idx].imageIds || []).filter(id2 => !removedExistingImageIds.has(id2));
        const removedIds = Array.from(removedExistingImageIds);
        let failedCount = 0;
        for(const dataURL of pendingNewImages){
          const imgId = newImageId();
          const ok = await setTripImage(editingId, imgId, dataURL);
          if(ok) imageIds.push(imgId); else failedCount++;
        }
        trips[idx] = { id: editingId, dest, otherName: dest==='OTHER' ? otherName : '', start, end, note, transportMode, route, imageIds };
        saveTrips();
        cancelEdit();
        render();
        // clean up storage for images the user actually removed, now that save succeeded
        for(const imgId of removedIds) await deleteTripImage(editingId, imgId);
        if(failedCount > 0) flashRetryableError(
          `记录已更新，但 ${failedCount} 张图片未能保存` + (HAS_CLAUDE_STORAGE ? '' : '（本地浏览器存储空间可能已用满，试试删掉几张旧图片再传）'),
          ()=>startEdit(editingId)
        );
        else flashStatus('已更新记录');
      }
    } else {
      const newId = 't' + Date.now() + Math.floor(Math.random()*1000);
      let imageIds = [];
      let failedCount = 0;
      for(const dataURL of pendingNewImages){
        const imgId = newImageId();
        const ok = await setTripImage(newId, imgId, dataURL);
        if(ok) imageIds.push(imgId); else failedCount++;
      }
      trips.push({
        id: newId,
        dest, otherName: dest==='OTHER' ? otherName : '',
        start, end, note, transportMode, route, imageIds
      });
      saveTrips();
      tripForm.reset();
      otherNameField.style.display = 'none';
      transportModeEl.value = 'AIR';
      resetImageFormState();
      render();
      if(failedCount > 0) flashRetryableError(
        `行程已保存，但 ${failedCount} 张图片未能保存` + (HAS_CLAUDE_STORAGE ? '' : '（本地浏览器存储空间可能已用满，试试删掉几张旧图片再传）'),
        ()=>startEdit(newId)
      );
    }
  });

  async function startEdit(id){
    const t = trips.find(x => x.id === id);
    if(!t) return;
    editingId = id;
    destSelect.value = t.dest;
    otherNameField.style.display = t.dest === 'OTHER' ? 'flex' : 'none';
    otherNameInput.value = t.otherName || '';
    document.getElementById('startDate').value = t.start;
    document.getElementById('endDate').value = t.end;
    document.getElementById('tripNote').value = t.note || '';
    transportModeEl.value = t.transportMode || 'AIR';
    routeDetailEl.value = t.route || '';

    resetImageFormState();
    if(t.imageIds && t.imageIds.length > 0){
      existingImagesForEdit = await getTripImages(t);
      renderImageThumbList();
    }

    document.getElementById('formTitle').textContent = '编辑行程';
    document.getElementById('submitBtn').textContent = '保存修改';
    document.getElementById('cancelEditField').style.display = 'flex';
    document.getElementById('tripForm').scrollIntoView({ behavior:'smooth', block:'center' });
  }

  function cancelEdit(){
    editingId = null;
    tripForm.reset();
    otherNameField.style.display = 'none';
    transportModeEl.value = 'AIR';
    routeDetailEl.value = '';
    resetImageFormState();
    document.getElementById('formTitle').textContent = '新增行程';
    document.getElementById('submitBtn').textContent = '添加记录';
    document.getElementById('cancelEditField').style.display = 'none';
  }

  document.getElementById('cancelEditBtn').addEventListener('click', cancelEdit);

  async function deleteTrip(id){
    if(editingId === id) cancelEdit();
    const t = trips.find(x => x.id === id);
    trips = trips.filter(x => x.id !== id);
    saveTrips();
    if(t) await deleteAllTripImages(t);
    render();
  }

  async function viewTripImage(id){
    const t = trips.find(x => x.id === id);
    if(!t) return;
    const images = await getTripImages(t);
    if(images.length === 0){ alert('附件暂时无法读取，请稍后再试一次。'); return; }
    openImageModal(images.map(i => i.dataURL), 0);
  }

  function destLabel(trip){
    if(trip.dest === 'MY') return '马来西亚';
    if(trip.dest === 'SG') return '新加坡';
    return trip.otherName || '其他';
  }

  function destTagClass(trip){
    if(trip.dest === 'MY') return 'my';
    if(trip.dest === 'SG') return 'sg';
    return 'other';
  }

  // inclusive day count between two ISO date strings
  function daysInclusive(startISO, endISO){
    const s = new Date(startISO + 'T00:00:00Z');
    const e = new Date(endISO + 'T00:00:00Z');
    return Math.round((e - s) / 86400000) + 1;
  }

  function isLeap(y){ return (y%4===0 && y%100!==0) || y%400===0; }

  function overlapDaysInYear(startISO, endISO, year){
    const yStart = new Date(Date.UTC(year,0,1));
    const yEnd = new Date(Date.UTC(year,11,31));
    const s = new Date(startISO + 'T00:00:00Z');
    const e = new Date(endISO + 'T00:00:00Z');
    const from = s > yStart ? s : yStart;
    const to = e < yEnd ? e : yEnd;
    if(to < from) return 0;
    return Math.round((to - from) / 86400000) + 1;
  }

  function computeYearlyData(){
    const currentYear = new Date().getFullYear();
    let years = new Set([currentYear]);
    trips.forEach(t=>{
      const sy = new Date(t.start+'T00:00:00Z').getUTCFullYear();
      const ey = new Date(t.end+'T00:00:00Z').getUTCFullYear();
      for(let y=sy; y<=ey; y++) years.add(y);
    });
    const sortedYears = Array.from(years).sort((a,b)=>b-a);

    return sortedYears.map(year=>{
      const totalDays = isLeap(year) ? 366 : 365;
      let myDays=0, sgDays=0, otherDays=0;
      const otherBreakdown = {};
      trips.forEach(t=>{
        const d = overlapDaysInYear(t.start, t.end, year);
        if(d<=0) return;
        if(t.dest==='MY') myDays += d;
        else if(t.dest==='SG') sgDays += d;
        else {
          otherDays += d;
          const key = t.otherName || '其他';
          otherBreakdown[key] = (otherBreakdown[key]||0) + d;
        }
      });
      const accountedAway = myDays + sgDays + otherDays - (settings.base==='MY'?myDays:0) - (settings.base==='SG'?sgDays:0);
      // remaining days go to base
      let remaining = totalDays - myDays - sgDays - otherDays;
      if(remaining < 0) remaining = 0; // overlapping entries safeguard
      if(settings.base === 'SG') sgDays += remaining;
      else myDays += remaining;

      return { year, totalDays, myDays, sgDays, otherDays, otherBreakdown };
    });
  }

  function renderOverviewYearSelect(data){
    if(!overviewYearSelectEl) return;
    if(data.length === 0){
      const y = new Date().getFullYear();
      overviewYearSelectEl.innerHTML = `<option value="${y}">${y}</option>`;
      selectedOverviewYear = y;
      return;
    }
    if(!data.some(d => d.year === selectedOverviewYear)){
      selectedOverviewYear = data[0].year;
    }
    overviewYearSelectEl.innerHTML = data.map(d=>`<option value="${d.year}">${d.year}</option>`).join('');
    overviewYearSelectEl.value = String(selectedOverviewYear);
  }

  function renderYearCards(){
    const allData = computeYearlyData();
    renderOverviewYearSelect(allData);
    if(trips.length===0){
      yearCardsEl.innerHTML = '<div class="empty-state">还没有任何行程记录 —— 添加第一条行程，年度统计会自动出现在这里。</div>';
      return;
    }
    const data = allData.filter(d => d.year === selectedOverviewYear);
    yearCardsEl.innerHTML = data.map(d=>{
      const myPct = (d.myDays/d.totalDays*100).toFixed(1);
      const sgPct = (d.sgDays/d.totalDays*100).toFixed(1);
      const otherPct = (d.otherDays/d.totalDays*100).toFixed(1);

      const myHit = d.myDays >= 182;
      const sgHit = d.sgDays >= 183;

      const otherList = Object.entries(d.otherBreakdown)
        .sort((a,b)=>b[1]-a[1])
        .map(([name,days])=>`<span class="stamp other">${escapeHtml(name)} <span class="n">${days}</span> 天</span>`)
        .join('');

      return `
        <div class="year-card">
          <div class="year-head">
            <span class="year-num">${d.year}</span>
            <span class="year-total">全年 ${d.totalDays} 天</span>
          </div>
          <div class="bar">
            <div class="bar-seg seg-my" style="width:${myPct}%" title="马来西亚 ${d.myDays} 天"></div>
            <div class="bar-seg seg-sg" style="width:${sgPct}%" title="新加坡 ${d.sgDays} 天"></div>
            <div class="bar-seg seg-other" style="width:${otherPct}%" title="其他 ${d.otherDays} 天"></div>
          </div>
          <div class="stamp-row">
            <span class="stamp my">马来西亚 <span class="n">${d.myDays}</span> 天</span>
            <span class="stamp sg">新加坡 <span class="n">${d.sgDays}</span> 天</span>
            ${d.otherDays>0 ? `<span class="stamp other">其他国家合计 <span class="n">${d.otherDays}</span> 天</span>` : ''}
            ${otherList}
          </div>
          <div class="threshold-note">
            <span>马来西亚 182 天门槛：<span class="${myHit?'hit':'ok'}">${d.myDays} / 182 ${myHit?'（已达）':''}</span></span>
            <span>新加坡 183 天门槛：<span class="${sgHit?'hit':'ok'}">${d.sgDays} / 183 ${sgHit?'（已达）':''}</span></span>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeHtml(str){
    if(!str) return '';
    return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  const TRANSPORT_LABELS = {
    AIR: '✈️ 飞机',
    LAND: '🚗 陆路',
    SEA: '🚢 海路',
    OTHER: '其他'
  };
  const TRANSPORT_ICONS = {
    AIR: '✈️',
    LAND: '🚗',
    SEA: '🚢',
    OTHER: '❔'
  };
  const TRANSPORT_LABELS_EN = {
    AIR: 'Air',
    LAND: 'Land',
    SEA: 'Sea',
    OTHER: 'Other'
  };
  function transportLabel(t){ return TRANSPORT_LABELS[t.transportMode] || TRANSPORT_LABELS.AIR; }
  function transportIcon(t){ return TRANSPORT_ICONS[t.transportMode] || TRANSPORT_ICONS.AIR; }
  function transportLabelEn(t){ return TRANSPORT_LABELS_EN[t.transportMode] || TRANSPORT_LABELS_EN.AIR; }

  function renderTripTable(){
    if(trips.length===0){
      tripTableWrap.innerHTML = '<div class="empty-state">暂无记录</div>';
      return;
    }
    const sorted = [...trips].sort((a,b)=> new Date(b.start) - new Date(a.start));
    const rows = sorted.map(t=>{
      const d = daysInclusive(t.start, t.end);
      return `
        <tr>
          <td data-label="目的地"><span class="tag ${destTagClass(t)}">${escapeHtml(destLabel(t))}</span></td>
          <td data-label="出发">${t.start}</td>
          <td data-label="返回">${t.end}</td>
          <td data-label="天数">${d} 天</td>
          <td data-label="交通方式"><span class="transport-tag" title="${transportLabel(t)}">${transportIcon(t)}</span></td>
          <td data-label="路线">${t.route ? `<span class="route-text">${escapeHtml(t.route)}</span>` : '—'}</td>
          <td data-label="备注">${t.note ? escapeHtml(t.note) : '—'}</td>
          <td data-label="图片">${(t.imageIds && t.imageIds.length > 0) ? `<button class="view-image-link" data-action="viewImage" data-trip-id="${escapeHtml(t.id)}">查看图片 (${t.imageIds.length})</button>` : '—'}</td>
          <td data-label="操作">
            <div class="row-actions">
              <button data-action="editTrip" data-trip-id="${escapeHtml(t.id)}" title="编辑">✏️</button>
              <button data-action="removeTrip" data-trip-id="${escapeHtml(t.id)}" title="删除">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    tripTableWrap.innerHTML = `
      <table>
        <thead>
          <tr><th>目的地</th><th>出发</th><th>返回</th><th>天数</th><th>交通方式</th><th>路线</th><th>备注</th><th>图片</th><th>操作</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // event delegation: avoids inline onclick="" handlers so the page can run
  // under a CSP with no 'unsafe-inline' in script-src
  tripTableWrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-action]');
    if(!btn || !tripTableWrap.contains(btn)) return;
    const id = btn.dataset.tripId;
    if(btn.dataset.action === 'viewImage') viewTripImage(id);
    else if(btn.dataset.action === 'editTrip') startEdit(id);
    else if(btn.dataset.action === 'removeTrip') deleteTrip(id);
  });

  function renderYearSelect(){
    const data = computeYearlyData();
    const printYearSelect = document.getElementById('printYearSelect');
    const archiveYearSelect = document.getElementById('archiveYearSelect');
    const selects = [printYearSelect, archiveYearSelect];

    if(data.length === 0){
      const fallback = `<option value="${new Date().getFullYear()}">${new Date().getFullYear()}</option>`;
      selects.forEach(sel => { if(sel) sel.innerHTML = fallback; });
      return;
    }
    const optionsHtml = data.map(d => `<option value="${d.year}">${d.year}</option>`).join('');
    selects.forEach(sel => {
      if(!sel) return;
      const prevValue = sel.value;
      sel.innerHTML = optionsHtml;
      if(data.some(d => String(d.year) === prevValue)) sel.value = prevValue;
    });
  }

  function render(){
    renderYearCards();
    renderTripTable();
    renderYearSelect();
    refreshStorageMeter(); // fire-and-forget; updates the meter asynchronously
  }

  function formatBytes(n){
    if(n < 1024) return n + ' B';
    if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(2) + ' MB';
  }

  async function refreshStorageMeter(){
    const textEl = document.getElementById('storageMeterText');
    const barEl = document.getElementById('storageBar');
    const fillEl = document.getElementById('storageBarFill');
    const subEl = document.getElementById('storageMeterSub');
    if(!textEl) return;

    try{
      let totalBytes = JSON.stringify(trips).length + JSON.stringify(settings).length;
      let imageBytes = 0;
      let imageCount = 0;

      for(const t of trips){
        const images = await getTripImages(t);
        for(const { dataURL } of images){
          totalBytes += dataURL.length;
          imageBytes += dataURL.length;
          imageCount++;
        }
      }

      textEl.textContent = `本工具数据占用：约 ${formatBytes(totalBytes)}` +
        (imageCount > 0 ? `（含 ${imageCount} 张图片，约 ${formatBytes(imageBytes)}）` : '');

      if(HAS_CLAUDE_STORAGE){
        barEl.style.display = 'none';
        subEl.textContent = '每条记录（如每张图片）上限约 5MB';
        return;
      }

      // standalone mode — try to show real browser quota usage
      if(navigator.storage && navigator.storage.estimate){
        try{
          const est = await navigator.storage.estimate();
          if(est && est.quota){
            const pct = Math.min(100, (est.usage / est.quota) * 100);
            barEl.style.display = 'block';
            fillEl.style.width = pct.toFixed(1) + '%';
            fillEl.className = 'storage-bar-fill' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '');
            subEl.textContent = `此浏览器总配额约 ${formatBytes(est.quota)}，已用 ${formatBytes(est.usage)}（含该浏览器此来源下的其他数据）`;
            return;
          }
        }catch(e){ /* estimate not available — fall through */ }
      }
      barEl.style.display = 'none';
      subEl.textContent = localBackendName === 'idb'
        ? '（此浏览器不支持查询总配额，但 IndexedDB 通常容量比较宽裕）'
        : '（此浏览器不支持查询总配额；localStorage 通常总容量约 5–10MB，图片较多时容易存满）';
    }catch(e){
      console.error('[border-ledger] storage meter refresh failed', e);
      textEl.textContent = '存储用量暂时无法计算';
    }
  }

  async function tripToExportObject(t){
    const base = { dest: t.dest, otherName: t.otherName || '', start: t.start, end: t.end, note: t.note || '', transportMode: t.transportMode || 'AIR', route: t.route || '' };
    const images = await getTripImages(t);
    if(images.length > 0) base.images = images.map(i => i.dataURL);
    return base;
  }

  const EXPORT_ENVELOPE_MARKER = 'borderLedgerEncryptedBackup';

  function triggerDownload(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // If the export-encryption toggle is on, prompts for a backup password and
  // returns an encrypted envelope (self-contained: includes its own salt/iv,
  // independent of the app's own passcode) wrapping either JSON text or raw
  // ZIP bytes. Returns null if the user cancels the password prompt, or
  // { encrypted:false } if the toggle is off (caller exports plaintext).
  async function maybeEncryptExportPayload(data, isBinary, originalFormat){
    const toggle = document.getElementById('exportEncryptToggle');
    if(!toggle || !toggle.checked) return { encrypted:false };

    const pass = await showPassPrompt({
      title: '设置备份密码',
      subtitle: '为这份导出文件设置一个密码，恢复时需要输入相同密码解密。请妥善保管此密码——忘记将无法恢复这份备份。',
      confirmField: true, cancelable: true, submitLabel: '加密并导出', minLength: 4
    });
    if(pass === null) return null;

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(pass, salt, PBKDF2_ITERATIONS);
    const plainBytes = isBinary ? data : new TextEncoder().encode(data);
    const ctBuf = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, plainBytes);
    const envelope = {
      [EXPORT_ENVELOPE_MARKER]: true,
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: bufToB64(salt),
      iv: bufToB64(iv),
      originalFormat,
      ciphertext: bufToB64(ctBuf)
    };
    return { encrypted:true, envelopeJSON: JSON.stringify(envelope) };
  }

  async function exportJSON(){
    flashStatus('正在打包（含图片可能需要几秒）…');
    const exportTrips = [];
    for(const t of trips){
      exportTrips.push(await tripToExportObject(t));
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      settings,
      trips: exportTrips
    };
    const jsonText = JSON.stringify(payload, null, 2);
    const today = new Date().toISOString().slice(0,10);

    const result = await maybeEncryptExportPayload(jsonText, false, 'json');
    if(result === null){ flashStatus('已取消导出'); return; }

    if(result.encrypted){
      triggerDownload(new Blob([result.envelopeJSON], { type:'application/json' }), `border-day-ledger-${today}.encrypted.json`);
      flashStatus('已导出加密备份（JSON）');
    } else {
      triggerDownload(new Blob([jsonText], { type:'application/json' }), `border-day-ledger-${today}.json`);
      flashStatus('已导出 JSON（含图片，未加密）');
    }
  }

  async function exportZIP(){
    if(typeof JSZip === 'undefined'){
      alert('ZIP 组件加载失败（可能是网络问题），请刷新页面重试，或先用「导出为 JSON」备份。');
      return;
    }
    flashStatus('正在打包 ZIP（含图片可能需要几秒）…');
    try{
      const zip = new JSZip();
      const imagesFolder = zip.folder('images');
      const exportTrips = [];

      for(let i=0; i<trips.length; i++){
        const t = trips[i];
        const base = { dest: t.dest, otherName: t.otherName || '', start: t.start, end: t.end, note: t.note || '', transportMode: t.transportMode || 'AIR', route: t.route || '' };
        const images = await getTripImages(t);
        if(images.length > 0){
          base.images = [];
          images.forEach((img, j)=>{
            const ext = isPdfDataURL(img.dataURL) ? 'pdf' : 'jpg';
            const filename = `t${i}_${j}_${img.imgId}.${ext}`;
            const base64Data = (img.dataURL.split(',')[1]) || '';
            imagesFolder.file(filename, base64Data, { base64: true });
            base.images.push(filename);
          });
        }
        exportTrips.push(base);
      }

      const manifest = { exportedAt: new Date().toISOString(), settings, trips: exportTrips };
      zip.file('trips.json', JSON.stringify(manifest, null, 2));

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const today = new Date().toISOString().slice(0,10);

      const arrayBuffer = await blob.arrayBuffer();
      const result = await maybeEncryptExportPayload(arrayBuffer, true, 'zip');
      if(result === null){ flashStatus('已取消导出'); return; }

      if(result.encrypted){
        triggerDownload(new Blob([result.envelopeJSON], { type:'application/json' }), `border-day-ledger-${today}.encrypted.json`);
        flashStatus('已导出加密备份（ZIP）');
      } else {
        triggerDownload(blob, `border-day-ledger-${today}.zip`);
        flashStatus('已导出 ZIP（含图片，未加密）');
      }
    }catch(e){
      console.error('[border-ledger] ZIP export failed', e);
      alert('打包 ZIP 失败，请换用「导出为 JSON」试试。');
    }
  }

  // Decrypts an encrypted-backup envelope (produced by maybeEncryptExportPayload)
  // and routes the recovered content into the normal JSON or ZIP import path.
  async function importEncryptedEnvelope(envelope){
    if(envelope.kdf !== 'PBKDF2-SHA256' || !envelope.salt || !envelope.iv || !envelope.ciphertext){
      alert('这个加密备份文件格式无法识别。');
      return;
    }
    let attempts = 0;
    while(attempts < 5){
      const pass = await showPassPrompt({
        title: '输入备份密码',
        subtitle: '这是一份加密备份，请输入导出时设置的密码来解密。',
        cancelable: true, submitLabel: '解密并导入', minLength: 1
      });
      if(pass === null) return;
      try{
        const salt = new Uint8Array(b64ToBuf(envelope.salt));
        const iv = new Uint8Array(b64ToBuf(envelope.iv));
        const key = await deriveKey(pass, salt, envelope.iterations || PBKDF2_ITERATIONS);
        const ctBuf = b64ToBuf(envelope.ciphertext);
        const ptBuf = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ctBuf);

        if(envelope.originalFormat === 'zip'){
          let zip2;
          try{ zip2 = await JSZip.loadAsync(ptBuf); }
          catch(e){ alert('解密成功，但备份内容已损坏，无法解析。'); return; }
          const manifestEntry = zip2.file('trips.json');
          if(!manifestEntry){ alert('这个备份里没有找到 trips.json。'); return; }
          const manifest = JSON.parse(await manifestEntry.async('string'));
          await processZipImportPayload(zip2, manifest);
        } else {
          const text = new TextDecoder().decode(ptBuf);
          const parsed = JSON.parse(text);
          await processJSONImportPayload(parsed);
        }
        return;
      }catch(e){
        attempts++;
        if(attempts >= 5){ alert('密码错误次数过多，已取消导入。'); return; }
        alert('密码错误，或文件已损坏，请重新输入。');
      }
    }
  }

  async function archiveYear(year){
    year = Number(year);
    const matching = trips.filter(t => new Date(t.start + 'T00:00:00Z').getUTCFullYear() === year);
    if(matching.length === 0){
      alert(`${year} 年（按出发日期算）没有可归档的记录。`);
      return;
    }
    const imageCount = matching.reduce((sum, t) => sum + (t.imageIds ? t.imageIds.length : 0), 0);

    const proceed = confirm(
      `即将归档 ${year} 年的 ${matching.length} 条记录${imageCount>0 ? '（含 ' + imageCount + ' 张图片）' : ''}。\n\n` +
      `流程：先下载这一年的完整备份 JSON → 你确认已保存好 → 再从本工具里删除这些记录以释放空间。\n\n` +
      `以后需要的话，可以用「导入 JSON」把这份备份重新导回来。\n\n是否继续？`
    );
    if(!proceed) return;

    flashStatus(`正在打包 ${year} 年数据…`);
    const exportTrips = [];
    for(const t of matching){
      exportTrips.push(await tripToExportObject(t));
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      archivedYear: year,
      settings,
      trips: exportTrips
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `border-day-ledger-archive-${year}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    // give the browser a moment to actually start the download before
    // asking whether it's safe to delete
    await new Promise(res => setTimeout(res, 400));

    const confirmDelete = confirm(
      `备份文件应该已经开始下载了（"border-day-ledger-archive-${year}.json"）。\n\n` +
      `确认已经保存好了吗？点击「确定」会从本工具里删除这 ${matching.length} 条 ${year} 年的记录以释放空间；` +
      `点击「取消」则保留记录不删（备份已经下载，可以之后再手动清理）。`
    );
    if(!confirmDelete){
      flashStatus(`已导出 ${year} 年备份，未删除记录`);
      return;
    }

    flashStatus('正在删除…');
    for(const t of matching){
      await deleteAllTripImages(t);
    }
    const matchIds = new Set(matching.map(t => t.id));
    trips = trips.filter(t => !matchIds.has(t.id));
    await saveTrips();
    render();
    flashStatus(`已归档并删除 ${year} 年的 ${matching.length} 条记录`);
  }

  document.getElementById('archiveBtn').addEventListener('click', ()=>{
    const year = document.getElementById('archiveYearSelect').value;
    if(year) archiveYear(year);
  });

  function preparePrintView(year){
    year = Number(year);
    const totalDays = isLeap(year) ? 366 : 365;
    let myDays=0, sgDays=0, otherDays=0;
    const otherBreakdown = {};
    const relevantTrips = [];

    trips.forEach(t=>{
      const d = overlapDaysInYear(t.start, t.end, year);
      if(d<=0) return;
      relevantTrips.push({ t, daysInYear: d });
      if(t.dest==='MY') myDays += d;
      else if(t.dest==='SG') sgDays += d;
      else {
        otherDays += d;
        const key = t.otherName || '其他';
        otherBreakdown[key] = (otherBreakdown[key]||0) + d;
      }
    });
    let remaining = totalDays - myDays - sgDays - otherDays;
    if(remaining < 0) remaining = 0;
    if(settings.base === 'SG') sgDays += remaining; else myDays += remaining;

    relevantTrips.sort((a,b)=> new Date(a.t.start) - new Date(b.t.start));

    function destLabelEn(t){
      if(t.dest === 'MY') return 'Malaysia';
      if(t.dest === 'SG') return 'Singapore';
      return t.otherName || 'Other';
    }

    const rows = relevantTrips.map(({t, daysInYear})=>{
      return `<tr>
        <td>${escapeHtml(destLabelEn(t))}</td>
        <td>${t.start}</td>
        <td>${t.end}</td>
        <td>${daysInYear} days</td>
        <td>${transportLabelEn(t)}</td>
        <td>${t.route ? escapeHtml(t.route) : '—'}</td>
        <td>${t.note ? escapeHtml(t.note) : '—'}</td>
      </tr>`;
    }).join('');

    const otherListEn = Object.entries(otherBreakdown)
      .sort((a,b)=>b[1]-a[1])
      .map(([name,days])=>`<span class="stamp other">${escapeHtml(name)} <span class="n">${days}</span> days</span>`)
      .join('');

    const myHit = myDays >= 182;
    const sgHit = sgDays >= 183;

    const printArea = document.getElementById('printArea');
    printArea.innerHTML = `
      <div class="print-header">
        <svg class="print-logo" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
          <circle cx="120" cy="120" r="118" fill="#F2EEE3" stroke="#C9BFA6" stroke-width="1.5"/>
          <circle cx="120" cy="120" r="104" fill="none" stroke="#1E2A44" stroke-width="4" stroke-dasharray="4 9"/>
          <g transform="translate(120,124)">
            <rect x="-32" y="-34" width="9" height="52" rx="1.5" fill="#1E2A44"/>
            <rect x="23" y="-34" width="9" height="52" rx="1.5" fill="#1E2A44"/>
            <rect x="-36" y="-44" width="72" height="10" rx="1.5" fill="#1E2A44"/>
            <g transform="rotate(-28)">
              <rect x="-3" y="-3" width="46" height="7" rx="3" fill="#A63A2E"/>
              <circle cx="-3" cy="0.5" r="5" fill="#A63A2E"/>
            </g>
            <rect x="-40" y="20" width="80" height="6" rx="2" fill="#3E6259"/>
            <g transform="translate(-52,4)">
              <path d="M0,-14 C7,-14 12,-9 12,-2 C12,7 0,18 0,18 C0,18 -12,7 -12,-2 C-12,-9 -7,-14 0,-14 Z" fill="#3E6259"/>
              <circle cx="0" cy="-2" r="4.2" fill="#F2EEE3"/>
            </g>
            <g transform="translate(52,4)">
              <path d="M0,-14 C7,-14 12,-9 12,-2 C12,7 0,18 0,18 C0,18 -12,7 -12,-2 C-12,-9 -7,-14 0,-14 Z" fill="#A63A2E"/>
              <circle cx="0" cy="-2" r="4.2" fill="#F2EEE3"/>
            </g>
          </g>
        </svg>
        <div>
          <div class="print-title">${year} Annual Border Day Report</div>
          <div class="print-sub" style="margin-bottom:0;">Generated: ${new Date().toLocaleString('en-US')} &middot; Base location: ${settings.base==='SG'?'Singapore':'Malaysia'}</div>
        </div>
      </div>
      <div style="margin-bottom:14px;"></div>
      <div class="print-stamp-row">
        <span class="stamp my">Malaysia <span class="n">${myDays}</span> days</span>
        <span class="stamp sg">Singapore <span class="n">${sgDays}</span> days</span>
        ${otherDays>0 ? `<span class="stamp other">Other countries (total) <span class="n">${otherDays}</span> days</span>` : ''}
        ${otherListEn}
      </div>
      <table class="print-table">
        <thead><tr><th>Destination</th><th>Departure</th><th>Return</th><th>Days in ${year}</th><th>Transport</th><th>Route</th><th>Note</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7">No trips recorded this year (entire year counted as base location)</td></tr>'}</tbody>
      </table>
      <div class="print-footer">
        Malaysia 182-day threshold: ${myDays} / 182 ${myHit?'(reached)':''}&nbsp;&nbsp;&middot;&nbsp;&nbsp;Singapore 183-day threshold: ${sgDays} / 183 ${sgHit?'(reached)':''}<br>
        Day counts use a simplified method where both departure and return dates count as full days. For official rules, please refer to LHDN / IRAS guidance or a qualified tax advisor.
      </div>
    `;
  }

  function isValidTrip(t){
    return t && typeof t === 'object'
      && (t.dest === 'MY' || t.dest === 'SG' || t.dest === 'OTHER')
      && typeof t.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.start)
      && typeof t.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.end);
  }

  // shared body of the plaintext JSON import — also reused by
  // importEncryptedEnvelope() once it has decrypted an encrypted backup
  async function processJSONImportPayload(parsed){
    const incomingTrips = Array.isArray(parsed.trips) ? parsed.trips.filter(isValidTrip) : [];
    if(incomingTrips.length === 0){
      alert('文件中没有找到有效的行程记录。');
      return;
    }

    const skippedCount = (Array.isArray(parsed.trips) ? parsed.trips.length : 0) - incomingTrips.length;
    const imageCount = incomingTrips.filter(t => typeof t.image === 'string' && isSupportedAttachmentDataURL(t.image)).length;
    const mode = confirm(
      `找到 ${incomingTrips.length} 条行程记录${imageCount>0 ? '（含 ' + imageCount + ' 个附件）' : ''}` +
      `${skippedCount>0 ? '（跳过 ' + skippedCount + ' 条格式不正确的记录）' : ''}。\n\n` +
      `点击「确定」= 合并到现有记录\n点击「取消」= 用导入内容替换现有全部记录`
    );

    flashStatus('正在导入…');

    // build fresh trip objects with new ids, restoring any attached image(s)/PDF(s) to storage
    // accepts both the current "images" array format and the older single "image" field
    let failedImageCount = 0;
    async function buildTripFromImport(t){
      const newId = 't' + Date.now() + Math.floor(Math.random()*100000) + Math.floor(Math.random()*100000);
      const sourceImages = Array.isArray(t.images) ? t.images
        : (typeof t.image === 'string' ? [t.image] : []);
      const imageIds = [];
      for(const dataURL of sourceImages){
        if(!isSupportedAttachmentDataURL(dataURL)) continue;
        const imgId = newImageId();
        const ok = await setTripImage(newId, imgId, dataURL);
        if(ok) imageIds.push(imgId); else failedImageCount++;
      }
      return {
        id: newId,
        dest: t.dest,
        otherName: t.dest === 'OTHER' ? (t.otherName || '') : '',
        start: t.start,
        end: t.end,
        note: t.note || '',
        transportMode: ['AIR','LAND','SEA','OTHER'].includes(t.transportMode) ? t.transportMode : 'AIR',
        route: t.route || '',
        imageIds
      };
    }

    const builtTrips = [];
    for(const t of incomingTrips){
      builtTrips.push(await buildTripFromImport(t));
    }

    if(mode){
      // merge with existing records
      trips = trips.concat(builtTrips);
    } else {
      // replace — first drop images belonging to the records being discarded
      for(const old of trips){
        await deleteAllTripImages(old);
      }
      trips = builtTrips;
    }

    if(parsed.settings && (parsed.settings.base === 'MY' || parsed.settings.base === 'SG')){
      if(confirm(`导入文件中的常驻地设置为「${parsed.settings.base === 'SG' ? '新加坡' : '马来西亚'}」，是否应用？`)){
        settings.base = parsed.settings.base;
        baseLocationEl.value = settings.base;
        await saveSettings();
      }
    }

    await saveTrips();
    render();
    flashStatus(failedImageCount > 0 ? `导入完成（${failedImageCount} 张图片未能保存）` : '导入完成');
  }

  function importJSON(file){
    const reader = new FileReader();
    reader.onload = async ()=>{
      let parsed;
      try{
        parsed = JSON.parse(reader.result);
      }catch(e){
        alert('无法解析该文件，请确认是从本工具导出的 JSON 文件。');
        return;
      }
      if(parsed && parsed[EXPORT_ENVELOPE_MARKER] === true){
        await importEncryptedEnvelope(parsed);
        return;
      }
      await processJSONImportPayload(parsed);
    };
    reader.onerror = ()=>{ alert('读取文件失败，请重试。'); };
    reader.readAsText(file);
  }

  // shared body of the ZIP import — also reused by importEncryptedEnvelope()
  // once it has decrypted an encrypted ZIP backup into an in-memory JSZip
  async function processZipImportPayload(zip, manifest){
    const incomingTrips = Array.isArray(manifest.trips) ? manifest.trips.filter(isValidTrip) : [];
    if(incomingTrips.length === 0){
      alert('文件中没有找到有效的行程记录。');
      return;
    }

    const skippedCount = (Array.isArray(manifest.trips) ? manifest.trips.length : 0) - incomingTrips.length;
    const totalImages = incomingTrips.reduce((sum, t) => sum + (Array.isArray(t.images) ? t.images.length : 0), 0);
    const mode = confirm(
      `找到 ${incomingTrips.length} 条行程记录${totalImages>0 ? '（含 ' + totalImages + ' 张图片）' : ''}` +
      `${skippedCount>0 ? '（跳过 ' + skippedCount + ' 条格式不正确的记录）' : ''}。\n\n` +
      `点击「确定」= 合并到现有记录\n点击「取消」= 用导入内容替换现有全部记录`
    );

    flashStatus('正在导入…');
    let failedImageCount = 0;

    async function buildTripFromZipImport(t){
      const newId = 't' + Date.now() + Math.floor(Math.random()*100000) + Math.floor(Math.random()*100000);
      const imageIds = [];
      if(Array.isArray(t.images)){
        for(const filename of t.images){
          const entry = zip.file('images/' + filename) || zip.file(filename);
          if(!entry){ failedImageCount++; continue; }
          try{
            const base64Data = await entry.async('base64');
            const mimePrefix = /\.pdf$/i.test(filename) ? 'data:application/pdf;base64,' : 'data:image/jpeg;base64,';
            const dataURL = mimePrefix + base64Data;
            const imgId = newImageId();
            const ok = await setTripImage(newId, imgId, dataURL);
            if(ok) imageIds.push(imgId); else failedImageCount++;
          }catch(e){ failedImageCount++; }
        }
      }
      return {
        id: newId,
        dest: t.dest,
        otherName: t.dest === 'OTHER' ? (t.otherName || '') : '',
        start: t.start,
        end: t.end,
        note: t.note || '',
        transportMode: ['AIR','LAND','SEA','OTHER'].includes(t.transportMode) ? t.transportMode : 'AIR',
        route: t.route || '',
        imageIds
      };
    }

    const builtTrips = [];
    for(const t of incomingTrips){
      builtTrips.push(await buildTripFromZipImport(t));
    }

    if(mode){
      trips = trips.concat(builtTrips);
    } else {
      for(const old of trips){
        await deleteAllTripImages(old);
      }
      trips = builtTrips;
    }

    if(manifest.settings && (manifest.settings.base === 'MY' || manifest.settings.base === 'SG')){
      if(confirm(`导入文件中的常驻地设置为「${manifest.settings.base === 'SG' ? '新加坡' : '马来西亚'}」，是否应用？`)){
        settings.base = manifest.settings.base;
        baseLocationEl.value = settings.base;
        await saveSettings();
      }
    }

    await saveTrips();
    render();
    flashStatus(failedImageCount > 0 ? `导入完成（${failedImageCount} 张图片未能保存）` : '导入完成');
  }

  async function importZIP(file){
    if(typeof JSZip === 'undefined'){
      alert('ZIP 组件加载失败（可能是网络问题），请刷新页面重试。');
      return;
    }
    flashStatus('正在解析…');
    let zip;
    try{
      zip = await JSZip.loadAsync(file);
    }catch(e){
      // not a real ZIP archive — it might be an encrypted-backup envelope
      // (produced when "导出加密" was on for a ZIP export)
      try{
        const text = await file.text();
        const maybeEnvelope = JSON.parse(text);
        if(maybeEnvelope && maybeEnvelope[EXPORT_ENVELOPE_MARKER] === true){
          await importEncryptedEnvelope(maybeEnvelope);
          return;
        }
      }catch(e2){ /* fall through to the generic error below */ }
      alert('无法解析该 ZIP 文件，请确认是从本工具导出的备份。');
      return;
    }

    const manifestEntry = zip.file('trips.json');
    if(!manifestEntry){
      alert('这个 ZIP 里没有找到 trips.json，请确认是从本工具导出的备份。');
      return;
    }
    let manifest;
    try{
      manifest = JSON.parse(await manifestEntry.async('string'));
    }catch(e){
      alert('trips.json 内容有问题，无法解析。');
      return;
    }

    await processZipImportPayload(zip, manifest);
  }

  document.getElementById('exportBtn').addEventListener('click', exportJSON);
  document.getElementById('exportZipBtn').addEventListener('click', exportZIP);
  document.getElementById('importBtn').addEventListener('click', ()=>{
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) importJSON(file);
    e.target.value = '';
  });
  document.getElementById('importZipBtn').addEventListener('click', ()=>{
    document.getElementById('importZipFile').click();
  });
  document.getElementById('importZipFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) importZIP(file);
    e.target.value = '';
  });
  document.getElementById('printBtn').addEventListener('click', ()=>{
    const year = document.getElementById('printYearSelect').value;
    preparePrintView(year);
    window.print();
  });
  document.getElementById('printToggleBtn').addEventListener('click', ()=>{
    const section = document.getElementById('printSection');
    section.style.display = (section.style.display === 'none') ? 'block' : 'none';
  });
  document.getElementById('archiveToggleBtn').addEventListener('click', ()=>{
    const section = document.getElementById('archiveSection');
    section.style.display = (section.style.display === 'none') ? 'block' : 'none';
  });

  function showStorageModeNote(){
    const note = document.getElementById('storageModeNote');
    if(!note) return;
    if(HAS_CLAUDE_STORAGE){
      note.style.display = 'none';
      return;
    }
    note.style.display = 'block';
    if(localBackendName === 'idb'){
      note.textContent = '⚠ 当前在本地浏览器打开（非 Claude.ai 内），数据用浏览器的 IndexedDB 存在这台电脑这个浏览器里，容量比较宽裕，图片也能存。建议定期用下面的「导出为 JSON」备份，换电脑/换浏览器打开需要重新导入。';
    } else {
      note.textContent = '⚠ 当前在本地浏览器打开（非 Claude.ai 内），此浏览器不支持 IndexedDB，已退回用 localStorage 保存，容量较小（尤其是图片，容易存满）。建议定期用下面的「导出为 JSON」备份，换电脑/换浏览器打开需要重新导入。';
    }
  }

  // ---------------------------------------------------------------------
  // Reusable passcode-prompt modal. Returns a Promise<string|null> resolving
  // to the entered passcode, or null if the user cancelled (only possible
  // when cancelable is true).
  // ---------------------------------------------------------------------
  const lockOverlayEl = document.getElementById('lockOverlay');
  const lockTitleEl = document.getElementById('lockTitle');
  const lockSubtitleEl = document.getElementById('lockSubtitle');
  const lockBioBtn = document.getElementById('lockBioBtn');
  const lockPass1El = document.getElementById('lockPass1');
  const lockPass2El = document.getElementById('lockPass2');
  const lockErrorEl = document.getElementById('lockError');
  const lockSubmitBtn = document.getElementById('lockSubmitBtn');
  const lockCancelBtn = document.getElementById('lockCancelBtn');
  const lockFootnoteEl = document.getElementById('lockFootnote');

  function showPassPrompt(opts){
    return new Promise((resolve)=>{
      lockTitleEl.textContent = opts.title || '';
      lockSubtitleEl.textContent = opts.subtitle || '';
      lockPass1El.value = '';
      lockPass2El.value = '';
      lockErrorEl.textContent = '';
      lockPass1El.placeholder = opts.placeholder1 || '密码';
      lockPass2El.style.display = opts.confirmField ? 'block' : 'none';
      lockCancelBtn.style.display = opts.cancelable ? 'inline-block' : 'none';
      lockSubmitBtn.textContent = opts.submitLabel || '确定';
      lockBioBtn.style.display = opts.bioButton ? 'block' : 'none';
      lockFootnoteEl.innerHTML = '';
      if(opts.showForgotLink){
        const a = document.createElement('a');
        a.textContent = '忘记密码？';
        a.addEventListener('click', ()=>{ cleanup(); resolve('__FORGOT__'); });
        lockFootnoteEl.appendChild(a);
      }
      lockOverlayEl.classList.add('open');
      setTimeout(()=> lockPass1El.focus(), 50);

      function cleanup(){
        lockOverlayEl.classList.remove('open');
        lockSubmitBtn.removeEventListener('click', onSubmit);
        lockCancelBtn.removeEventListener('click', onCancel);
        lockBioBtn.removeEventListener('click', onBio);
        lockPass1El.removeEventListener('keydown', onKey);
        lockPass2El.removeEventListener('keydown', onKey);
      }
      function onSubmit(){
        const v1 = lockPass1El.value;
        const v2 = lockPass2El.value;
        const minLen = opts.minLength || 4;
        if(!v1 || v1.length < minLen){ lockErrorEl.textContent = `密码至少需要 ${minLen} 位`; return; }
        if(opts.confirmField && v1 !== v2){ lockErrorEl.textContent = '两次输入的密码不一致'; return; }
        cleanup();
        resolve(v1);
      }
      function onCancel(){ cleanup(); resolve(null); }
      function onBio(){ cleanup(); resolve('__BIO__'); }
      function onKey(e){ if(e.key === 'Enter'){ e.preventDefault(); onSubmit(); } }
      lockSubmitBtn.addEventListener('click', onSubmit);
      lockCancelBtn.addEventListener('click', onCancel);
      lockBioBtn.addEventListener('click', onBio);
      lockPass1El.addEventListener('keydown', onKey);
      lockPass2El.addEventListener('keydown', onKey);
    });
  }

  async function confirmResetAllData(){
    if(!confirm('忘记密码将导致这台设备上已加密保存的全部数据（行程记录、图片、设置）永久无法恢复，且必须清空后才能重新开始使用。此操作不可撤销，确定要继续吗？')) return false;
    return confirm('请再次确认：真的要清空全部数据并重新设置密码吗？此操作无法撤销。');
  }

  async function runSetupFlow(){
    while(true){
      const pass = await showPassPrompt({
        title: '🔒 设置访问密码',
        subtitle: '首次使用需要设置一个密码，用于加密保护这台设备上保存的所有数据（行程记录、图片、设置）。请牢记此密码——如果忘记，加密数据将无法恢复。',
        confirmField: true, cancelable: false, submitLabel: '设置密码', minLength: 4
      });
      if(pass){
        flashStatusSafe('正在加密初始化…');
        await setupPasscode(pass);
        return;
      }
    }
  }

  async function runUnlockFlow(){
    const bioRec = idbDB ? await idbGet(BIO_META_KEY).catch(()=>null) : null;
    const canBio = !!bioRec && await biometricPlatformAvailable();

    if(canBio){
      const ok = await tryBiometricUnlock();
      if(ok) return;
      // fell through — user cancelled, failed verification, or it's
      // otherwise unavailable right now; drop to the password prompt below
    }

    while(true){
      const pass = await showPassPrompt({
        title: '🔒 输入密码解锁',
        subtitle: '请输入访问密码以解密并查看你的行程记录。',
        confirmField: false, cancelable: false, submitLabel: '解锁',
        showForgotLink: true, minLength: 1, bioButton: canBio
      });
      if(pass === '__BIO__'){
        const ok = await tryBiometricUnlock();
        if(ok) return;
        lockErrorEl.textContent = '指纹/Face ID 验证失败，请重试或输入密码。';
        continue;
      }
      if(pass === '__FORGOT__'){
        const wipe = await confirmResetAllData();
        if(wipe){
          await wipeAllLocalData();
          location.reload();
          return;
        }
        continue;
      }
      const ok = await tryUnlock(pass);
      if(ok) return;
      lockErrorEl.textContent = '密码错误，请重试。';
      await new Promise(res=>setTimeout(res, 0));
    }
  }

  function flashStatusSafe(msg){ try{ flashStatus(msg); }catch(e){ console.log(msg); } }

  async function refreshBioButtonLabel(){
    const btn = document.getElementById('bioToggleBtn');
    if(!btn) return;
    const supported = await biometricPlatformAvailable();
    if(!supported){
      btn.textContent = '指纹/Face ID 解锁（此设备不支持）';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    const rec = idbDB ? await idbGet(BIO_META_KEY).catch(()=>null) : null;
    btn.textContent = rec ? '🔓 关闭指纹/Face ID 解锁' : '👆 启用指纹/Face ID 解锁';
    btn.dataset.enabled = rec ? '1' : '0';
  }

  document.getElementById('bioToggleBtn').addEventListener('click', async ()=>{
    const btn = document.getElementById('bioToggleBtn');
    if(btn.dataset.enabled === '1'){
      if(confirm('确定要关闭指纹/Face ID 解锁吗？之后仍可以用密码解锁。')){
        await disableBiometricUnlock();
        await refreshBioButtonLabel();
        flashStatus('已关闭指纹/Face ID 解锁');
      }
      return;
    }
    const pass = await showPassPrompt({
      title: '启用指纹 / Face ID 解锁',
      subtitle: '请先输入当前密码以确认身份，随后系统会请求你完成一次指纹或 Face ID 验证。',
      cancelable: true, submitLabel: '下一步', minLength: 1
    });
    if(pass === null) return;
    const ok = await verifyPasscode(pass);
    if(!ok){ alert('密码不正确。'); return; }
    const enabled = await enableBiometricUnlock(pass);
    if(enabled){
      flashStatus('已启用指纹/Face ID 解锁');
      await refreshBioButtonLabel();
    }
  });

  document.getElementById('changePassBtn').addEventListener('click', async ()=>{
    const oldPass = await showPassPrompt({
      title: '更改密码', subtitle: '请输入当前密码以继续。',
      cancelable: true, submitLabel: '下一步', minLength: 1
    });
    if(oldPass === null) return;
    const newPass = await showPassPrompt({
      title: '设置新密码', subtitle: '请输入新密码并确认。',
      confirmField: true, cancelable: true, submitLabel: '确认更改', minLength: 4
    });
    if(newPass === null) return;
    flashStatus('正在更新加密…');
    try{
      await changePasscode(oldPass, newPass);
      flashStatus('密码已更新（指纹/Face ID 解锁已重置，如需请重新启用）');
      await refreshBioButtonLabel();
    }catch(e){
      alert('当前密码不正确，未更改密码。');
    }
  });

  document.getElementById('lockNowBtn').addEventListener('click', async ()=>{
    sessionKey = null;
    lockOverlayEl.classList.add('open');
    await runUnlockFlow();
    lockOverlayEl.classList.remove('open');
    await loadAll();
  });

  document.getElementById('infoNoteBtn').addEventListener('click', ()=>{
    const box = document.getElementById('infoNoteBox');
    const btn = document.getElementById('infoNoteBtn');
    const willShow = box.style.display === 'none';
    box.style.display = willShow ? 'block' : 'none';
    btn.textContent = willShow ? '收起说明' : 'ℹ️ 说明';
  });

  (async function init(){
    await initLocalBackend();
    showStorageModeNote();
    const meta = await getLockMeta();
    lockOverlayEl.classList.add('open');
    if(!meta){
      await runSetupFlow();
    } else {
      await runUnlockFlow();
    }
    lockOverlayEl.classList.remove('open');
    await loadAll();
    await refreshBioButtonLabel();
  })();
})();

  // registers the offline app-shell cache — safe to skip silently if this
  // copy isn't served over https/localhost (service workers require that)
  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{
      navigator.serviceWorker.register('sw.js').catch((e)=>{
        console.warn('[border-day-ledger] service worker registration skipped:', e);
      });
    });
  }
