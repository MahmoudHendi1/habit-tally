// Google API client for the reminder job: service-account sign-in, Firestore REST (v1) and FCM HTTP v1.
// Zero npm dependencies: only `node:` modules and the global `fetch` of Node 22. This module never logs.
// Contract: docs/contracts.md sections 4, 7 and 9.
//
// readServiceAccount(env) -> key object
//   Parses env.FIREBASE_SERVICE_ACCOUNT. Throws ConfigError when it is missing, not JSON, or lacks a non-empty
//   string client_email, private_key or project_id. The message never contains any part of the value.
//
// createGoogle({ serviceAccount, projectId?, firestoreEmulatorHost?, fcmBaseUrl?,
//                fetch?, now?, sleep?, timeoutMs? }) -> google
//   serviceAccount         the key object (always required; throws ConfigError when a needed field is missing)
//   projectId              default serviceAccount.project_id
//   fetch, now, sleep      for tests: fetch(url, init), now() in ms, sleep(ms) (the wait before a retry)
//   timeoutMs              limit for one HTTP request, default 20000
//   firestoreEmulatorHost  'host:port'. Firestore then goes to http://<host>/v1/... with `Authorization: Bearer
//                          owner`, and no token is requested for Firestore calls
//   fcmBaseUrl             replaces https://fcm.googleapis.com (a token is still requested, from the key's token_uri)
//   Empty strings count as "not given", so the job can pass the environment straight through:
//     createGoogle({ serviceAccount: readServiceAccount(env), projectId: env.GCLOUD_PROJECT,
//                    firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST, fcmBaseUrl: env.FCM_BASE_URL })
//
// Doc = { id, path, data, updateTime }: `path` is relative to the documents root ('users/abc/habits/h1'), `id` is
//   its last segment, `data` is plain JSON, `updateTime` is the server's RFC 3339 string (pass it back unchanged).
//   Every Doc has a non-empty updateTime: an answer without one is refused (GoogleError BAD_RESPONSE).
// Paths are 'collection/doc[/collection/doc...]'; a malformed path throws TypeError before any request.
//
//   google.getDoc(path)                    -> Doc | null     null on any HTTP 404 (no such document)
//   google.listDocs(collectionPath, { limit? }) -> Doc[]     every page (300 per request), ordered by id; [] for
//       an empty or missing collection. limit (a whole number >= 1): stop asking for pages once that many
//       documents are collected and return at most that many. Gives up with GoogleError BAD_RESPONSE after 200
//       pages (60,000 documents) or when the server repeats a page token.
//   google.queryEqual(collectionId, field, value) -> Doc[]   root collection only, `field == value`, e.g.
//                                                            queryEqual('devices', 'uid', uid)
//   google.setDoc(path, data, { ifUpdateTime?, ifMissing? }) -> Doc   replaces the whole document (creates it if
//       needed) and returns it with its new updateTime. ifUpdateTime: only if the stored document's updateTime is
//       exactly this string (the claim of an existing bookmark). ifMissing: true = only if the document does not
//       exist (first run). Not both. When the condition does not hold: PreconditionError, nothing is written.
//       The options are checked strictly, before any request: ifUpdateTime, when the key is present at all, must
//       be an RFC 3339 string as returned in Doc.updateTime (so `{ ifUpdateTime: doc?.updateTime }` on a missing
//       document throws TypeError and can never become an unconditional write); ifMissing must be true, false
//       or absent. A write that collides with another one (409 ABORTED) is sent again, up to 3 attempts in all.
//       Sent as a one-write `documents:commit` with the precondition (currentDocument.updateTime or
//       currentDocument.exists=false) in the JSON body: the Firestore emulator misreads the updateTime
//       precondition when it is a query parameter of PATCH.
//   google.deleteDoc(path)                 -> undefined      deleting a missing document is not an error
//   google.sendPush(fid, data)             -> 'sent' | 'unregistered'
//       Sends the data-only message of contracts section 7; `data` must be an object of strings (the job passes
//       { title, body, tag, url }). 'unregistered' = HTTP 404 AND the FCM error code UNREGISTERED (the
//       `errorCode` of the google.firebase.fcm.v1.FcmError detail): delete that device. 429 and 5xx are retried
//       once (after 1 s, or Retry-After up to 5 s). Everything else throws GoogleError: every 400, and every
//       other 404 (Google's generic NOT_FOUND for a wrong address looks the same apart from that detail).
//       Delete a device only on the return value 'unregistered', never because of a thrown error's code.
//
// Retries and time: only sendPush (once, on 429 or 5xx) and a setDoc that hit ABORTED are sent again; every other
//   failure throws at once. Each HTTP request, the token request included, can take up to the timeout (20 s).
//
// Values: strings, booleans, null, arrays and plain objects map to the matching Firestore types. Whole numbers
//   (safe integers) are stored as integerValue and read back as numbers; other finite numbers are doubleValue.
//   On read a timestampValue becomes its RFC 3339 string. undefined, NaN, Infinity, Dates etc. throw TypeError.
//
// Errors (all exported):
//   ConfigError        the key is missing or unusable (a private_key that cannot sign is found on the first call
//                      that needs a token). Never contains key material.
//   GoogleError        any failed call. `.status` = HTTP status (0 = no response: network error or timeout),
//                      `.code` = short code: Google's error status ('PERMISSION_DENIED'), the FCM error code
//                      ('UNREGISTERED', 'QUOTA_EXCEEDED'), the OAuth error ('invalid_grant'), 'HTTP_<status>' when
//                      the body has none, 'NETWORK', 'TIMEOUT' or 'BAD_RESPONSE' (an answer this module cannot
//                      use). `.message` holds only the operation name, status and code: never the key, a token,
//                      a request body or text sent by the server.
//                      `.detail` (not shown when an error is printed; at most 300 chars) is the server's own
//                      message. It can contain an installation ID or a habit name: never print it.
//   PreconditionError  extends GoogleError: the setDoc condition did not hold (another run claimed the slot).
//   Wrong argument types (a programming error) throw TypeError.
// The access token is requested on first use, kept in memory and reused until a minute before it expires.
// Also exported: PUSH_TARGET_FIELD, encodeValue(json) and decodeValue(firestoreValue).

import { sign } from 'node:crypto';

/** FCM target field. `fid` = Firebase installation ID. The documented fallback is `token`, which also accepts
 *  an installation ID during FCM's migration: change this one constant if `fid` is refused (plan L3.0). */
export const PUSH_TARGET_FIELD = 'fid';

const SCOPES = 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token'; // only when the key has no token_uri
const TOKEN_LIFETIME_S = 3600;
const PAGE_SIZE = 300;
const MAX_PAGES = 200;
const UPDATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/; // RFC 3339
const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
const TIMEOUT_MS = 20000;
const RETRY_MS = 1000;
const RETRY_MAX_MS = 5000;
const COMMIT_ATTEMPTS = 3;
const COMMIT_RETRY_MS = 200;
const KEY_FIELDS = ['client_email', 'private_key', 'project_id'];

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

export class GoogleError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', detail = '' } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    Object.defineProperty(this, 'detail', { value: detail, enumerable: false });
  }
}

export class PreconditionError extends GoogleError {}

const unreadable = (op, status) => new GoogleError(`${op} failed: unreadable response`, { status, code: 'BAD_RESPONSE' });

const missingKeyFields = (key) => KEY_FIELDS.filter((f) => typeof key?.[f] !== 'string' || !key[f]);

export function readServiceAccount(env) {
  const raw = env?.FIREBASE_SERVICE_ACCOUNT;
  if (typeof raw !== 'string' || !raw.trim()) throw new ConfigError('FIREBASE_SERVICE_ACCOUNT is not set');
  let key;
  try { key = JSON.parse(raw); } catch { key = null; } // the parser's own message would quote the value
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    throw new ConfigError('FIREBASE_SERVICE_ACCOUNT is not a JSON service account key');
  }
  const missing = missingKeyFields(key);
  if (missing.length) throw new ConfigError(`FIREBASE_SERVICE_ACCOUNT has no ${missing.join(', ')}`);
  return key;
}

const isPlain = (v) => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** Plain JSON value -> Firestore Value. */
export function encodeValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Number.isFinite(v)) return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (isPlain(v)) return { mapValue: { fields: encodeFields(v) } };
  throw new TypeError('Firestore data must be plain JSON (string, finite number, boolean, null, array, object)');
}

const encodeFields = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encodeValue(v)]));

/** Firestore Value -> plain JSON value. */
export function decodeValue(v) {
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  for (const k of ['stringValue', 'booleanValue', 'timestampValue', 'referenceValue', 'bytesValue', 'geoPointValue']) {
    if (k in v) return v[k];
  }
  return null;
}

// Object.fromEntries defines own properties, so a field called `__proto__` cannot reach the prototype.
const decodeFields = (fields) => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decodeValue(v)]));

/** The FCM error code of an error answer (`errorCode` of its FcmError detail), or undefined. */
function fcmErrorCode(json) {
  const details = json?.error?.details;
  return Array.isArray(details) ? details.find((d) => d?.['@type'] === FCM_ERROR)?.errorCode : undefined;
}

function toDoc(raw) {
  // Without a name or an update time the document cannot be addressed or claimed: refuse it.
  if (typeof raw?.name !== 'string' || typeof raw.updateTime !== 'string' || !raw.updateTime) {
    throw unreadable('Firestore read', 200);
  }
  const path = raw.name.slice(raw.name.indexOf('/documents/') + '/documents/'.length);
  const id = path.slice(path.lastIndexOf('/') + 1);
  return { id, path, data: decodeFields(raw.fields), updateTime: raw.updateTime };
}

/** Checks a path ('a/b' for a document, 'a' or 'a/b/c' for a collection) and returns it URL-encoded. */
function urlPath(path, isDoc) {
  const parts = typeof path === 'string' ? path.split('/') : [''];
  if (parts.length % 2 !== (isDoc ? 0 : 1) || parts.some((s) => !s || s === '.' || s === '..')) {
    throw new TypeError(isDoc ? 'Not a document path' : 'Not a collection path');
  }
  return parts.map(encodeURIComponent).join('/');
}

export function createGoogle(options = {}) {
  const key = options.serviceAccount;
  const missing = missingKeyFields(key);
  if (missing.length) throw new ConfigError(`The service account key has no ${missing.join(', ')}`);
  const projectId = options.projectId || key.project_id;
  const emulatorHost = options.firestoreEmulatorHost || '';
  if (!/^[\w.:-]+$/.test(projectId)) throw new ConfigError('The project id is not valid');
  if (emulatorHost && !/^[\w.:[\]-]+$/.test(emulatorHost)) {
    throw new ConfigError('The Firestore emulator host must be host:port');
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => { setTimeout(done, ms); }));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const tokenUri = key.token_uri || TOKEN_URI;
  const privateKey = key.private_key.replace(/\\n/g, '\n'); // tolerate a key pasted with escaped newlines
  const docsName = `projects/${projectId}/databases/(default)/documents`;
  const docsRoot = `${emulatorHost ? `http://${emulatorHost}` : 'https://firestore.googleapis.com'}/v1/${docsName}`;
  const fcmBase = (options.fcmBaseUrl || 'https://fcm.googleapis.com').replace(/\/+$/, '');
  const pushUrl = `${fcmBase}/v1/projects/${projectId}/messages:send`;
  let token = null; // { value, expiresAt }
  let pendingToken = null;
  let assertion = ''; // the last signed JWT: as secret as the token it buys

  /** One HTTP exchange -> { status, ok, json, retryAfter }; json is undefined when the body is not JSON. */
  async function call(op, url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The race ends the wait even if `fetch` (or reading the body) ignores the abort signal.
    const gaveUp = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    const exchange = async () => {
      const answer = await fetchFn(url, { ...init, signal: controller.signal });
      return [answer, await answer.text()];
    };
    let res, text;
    try {
      [res, text] = await Promise.race([exchange(), gaveUp]);
    } catch {
      throw controller.signal.aborted ? new GoogleError(`${op} failed: no answer in time`, { code: 'TIMEOUT' })
        : new GoogleError(`${op} failed: network error`, { code: 'NETWORK' });
    } finally {
      clearTimeout(timer);
    }
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
    return { status: res.status, ok: res.ok, json, retryAfter: Number(res.headers.get('retry-after')) || 0 };
  }

  /** Error for a non-2xx response. Google APIs answer { error: { code, message, status, details[] } } (runQuery
   *  wraps it in an array); the token endpoint answers { error: 'invalid_grant', error_description }. */
  function failure(op, r, Kind = GoogleError) {
    const body = Array.isArray(r.json) ? r.json[0] : r.json;
    const e = body?.error;
    const named = typeof e === 'string' ? e : fcmErrorCode(body) || e?.status;
    // A code is one word; anything else from the server (it could be anything) is replaced by the status.
    const code = typeof named === 'string' && /^[A-Za-z_]{1,40}$/.test(named) ? named : `HTTP_${r.status}`;
    let detail = String((typeof e === 'string' ? body.error_description : e?.message) ?? '');
    for (const secret of [token?.value, assertion, privateKey, key.private_key]) {
      if (secret) detail = detail.split(secret).join('[removed]');
    }
    return new Kind(`${op} failed: HTTP ${r.status} ${code}`, { status: r.status, code, detail: detail.slice(0, 300) });
  }

  function expectJson(op, r) {
    if (!r.ok) throw failure(op, r);
    if (r.json === undefined || r.json === null) throw unreadable(op, r.status);
    return r.json;
  }

  async function requestToken() {
    const iat = Math.floor(now() / 1000);
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id && { kid: String(key.private_key_id) }) };
    const claims = { iss: key.client_email, scope: SCOPES, aud: tokenUri, iat, exp: iat + TOKEN_LIFETIME_S };
    const unsigned = `${part(header)}.${part(claims)}`;
    let signature;
    try { signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url'); } catch {
      throw new ConfigError('The service account private_key is not a usable RSA key');
    }
    assertion = `${unsigned}.${signature}`;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    const json = expectJson('token request', await call('token request', tokenUri, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    }));
    if (typeof json.access_token !== 'string' || !json.access_token) throw unreadable('token request', 200);
    token = { value: json.access_token, expiresAt: now() + (Number(json.expires_in) || TOKEN_LIFETIME_S) * 1000 };
    return token.value;
  }

  async function accessToken() {
    if (token && now() < token.expiresAt - 60000) return token.value;
    pendingToken ??= requestToken().finally(() => { pendingToken = null; }); // parallel callers share one request
    return pendingToken;
  }

  async function firestore(op, method, suffix, body) {
    const authorization = emulatorHost ? 'Bearer owner' : `Bearer ${await accessToken()}`;
    return call(op, docsRoot + suffix, body === undefined ? { method, headers: { authorization } }
      : { method, headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  return {
    async getDoc(path) {
      const r = await firestore('getDoc', 'GET', `/${urlPath(path, true)}`);
      return r.status === 404 ? null : toDoc(expectJson('getDoc', r));
    },

    async listDocs(collectionPath, options = {}) {
      const limit = options?.limit ?? Infinity;
      if (!isPlain(options) || (limit !== Infinity && !(Number.isSafeInteger(limit) && limit >= 1))) {
        throw new TypeError('listDocs limit must be a whole number of at least 1');
      }
      const base = `/${urlPath(collectionPath, false)}`;
      const docs = [];
      const seen = new Set();
      for (let pageToken = ''; ;) {
        const size = Math.min(PAGE_SIZE, limit - docs.length); // never ask (and pay) for more than is wanted
        const suffix = `${base}?pageSize=${size}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const page = expectJson('listDocs', await firestore('listDocs', 'GET', suffix));
        docs.push(...(Array.isArray(page.documents) ? page.documents : []).map(toDoc));
        pageToken = page.nextPageToken;
        if (docs.length >= limit) return docs.slice(0, limit);
        if (!pageToken) return docs;
        // A server that never ends the list, or hands the same page out again, must not keep the job running.
        if (seen.has(pageToken) || seen.size + 1 >= MAX_PAGES) throw unreadable('listDocs', 200);
        seen.add(pageToken);
      }
    },

    async queryEqual(collectionId, field, value) {
      if (!/^[A-Za-z_]\w*$/.test(String(field))) throw new TypeError('Not a simple field name');
      urlPath(collectionId, false);
      const rows = expectJson('queryEqual', await firestore('queryEqual', 'POST', ':runQuery', { structuredQuery: {
        from: [{ collectionId }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encodeValue(value) } },
      } }));
      // The answer is an array of { document?, readTime }; an empty result is one entry without a document.
      return (Array.isArray(rows) ? rows : []).filter((row) => row.document).map((row) => toDoc(row.document));
    },

    async setDoc(path, data, options = {}) {
      if (!isPlain(data)) throw new TypeError('Document data must be a plain object');
      if (!isPlain(options)) throw new TypeError('setDoc options must be a plain object');
      // A condition that was asked for must never be dropped: a present but unusable value is an error, not
      // "no condition" (an unconditional write would take a slot another run already has).
      const conditional = 'ifUpdateTime' in options;
      const { ifUpdateTime, ifMissing = false } = options;
      if (conditional && (typeof ifUpdateTime !== 'string' || !UPDATE_TIME.test(ifUpdateTime))) {
        throw new TypeError('ifUpdateTime must be the updateTime string of a document');
      }
      if (typeof ifMissing !== 'boolean') throw new TypeError('ifMissing must be true or false');
      if (conditional && ifMissing) throw new TypeError('Use ifUpdateTime or ifMissing, not both');
      urlPath(path, true);
      const fields = encodeFields(data);
      const write = { update: { name: `${docsName}/${path}`, fields } }; // no updateMask: replaces every field
      if (conditional) write.currentDocument = { updateTime: ifUpdateTime };
      if (ifMissing) write.currentDocument = { exists: false };
      let r;
      for (let attempt = 1; ; attempt += 1) {
        r = await firestore('setDoc', 'POST', ':commit', { writes: [write] });
        // ABORTED (409) = this write collided with another one and was not applied. Firestore says to send it
        // again; the condition is then checked against whatever the other writer left.
        if (r.ok || attempt === COMMIT_ATTEMPTS || failure('setDoc', r).code !== 'ABORTED') break;
        await sleep(COMMIT_RETRY_MS * attempt);
      }
      if (!r.ok && write.currentDocument) {
        // A failed condition is FAILED_PRECONDITION (400), or ALREADY_EXISTS (409) for exists=false, or NOT_FOUND
        // (404) for an updateTime on a document that is gone. Anything else stays a plain GoogleError, notably
        // NOT_FOUND for exists=false (there is no such database) and an ABORTED that outlasted its retries.
        const err = failure('setDoc', r, PreconditionError);
        if (['FAILED_PRECONDITION', ifMissing ? 'ALREADY_EXISTS' : 'NOT_FOUND'].includes(err.code)) throw err;
      }
      const updateTime = expectJson('setDoc', r).writeResults?.[0]?.updateTime;
      if (typeof updateTime !== 'string' || !updateTime) throw unreadable('setDoc', r.status);
      return { id: path.slice(path.lastIndexOf('/') + 1), path, data: decodeFields(fields), updateTime };
    },

    async deleteDoc(path) {
      const r = await firestore('deleteDoc', 'DELETE', `/${urlPath(path, true)}`);
      if (!r.ok && r.status !== 404) throw failure('deleteDoc', r);
    },

    async sendPush(fid, data) {
      if (typeof fid !== 'string' || !fid) throw new TypeError('sendPush needs an installation id');
      if (!isPlain(data) || Object.values(data).some((v) => typeof v !== 'string')) {
        throw new TypeError('Push data must be an object of strings');
      }
      const body = JSON.stringify({ message: {
        [PUSH_TARGET_FIELD]: fid, data, webpush: { headers: { TTL: '1800', Urgency: 'high' } },
      } });
      for (let attempt = 1; ; attempt += 1) {
        const headers = { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' };
        const r = await call('sendPush', pushUrl, { method: 'POST', headers, body });
        if (r.ok) return 'sent';
        const err = failure('sendPush', r);
        // Only FCM's own "this installation is gone" counts. Google's generic 404 NOT_FOUND (a wrong address or
        // project) has no FcmError detail, and must not make the job delete devices.
        if (r.status === 404 && fcmErrorCode(r.json) === 'UNREGISTERED') return 'unregistered';
        if (attempt > 1 || (r.status !== 429 && r.status < 500)) throw err;
        await sleep(Math.min(Math.max(RETRY_MS, r.retryAfter * 1000), RETRY_MAX_MS));
      }
    },
  };
}
