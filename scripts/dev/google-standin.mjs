// Local stand-ins for the two Google services the reminder job needs besides Firestore: the OAuth token
// endpoint and FCM HTTP v1 (there is no FCM emulator). For tests and local runs only: it listens on
// 127.0.0.1, sends nothing anywhere and keeps everything it receives in memory.
//
//   const google = await startGoogleStandIn({ publicKey });
//   google.tokenUri     put it in the fake service account's token_uri
//   google.fcmBaseUrl   pass it to the job as FCM_BASE_URL
//   google.tokens       [{ grantType, claims, signed }] one entry per token request; `signed` says whether the
//                       JWT's RS256 signature fits `publicKey` (null when no key was given)
//   google.pushes       [{ path, authorized, body }] one entry per push request; `authorized` says whether the
//                       request carried a token this stand-in gave out
//   await google.close()
//
// A push request without such a token is refused with 401, like the real service.

import { createServer } from 'node:http';
import { createVerify, randomBytes } from 'node:crypto';

/** @param {{ publicKey?: import('node:crypto').KeyObject | string }} [options] */
export async function startGoogleStandIn({ publicKey } = {}) {
  const tokens = [], pushes = [], issued = new Set();

  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const answer = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (req.method === 'POST' && path === '/token') {
      const form = new URLSearchParams(text);
      const [head, claims, signature] = String(form.get('assertion') ?? '').split('.');
      let parsed = null, signed = null;
      try { parsed = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')); } catch { /* recorded as null */ }
      if (publicKey) {
        try {
          signed = createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
        } catch { signed = false; }
      }
      tokens.push({ grantType: form.get('grant_type'), claims: parsed, signed });
      if (signed === false) return answer(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      const token = `standin-${randomBytes(12).toString('hex')}`;
      issued.add(token);
      return answer(200, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
    }

    if (req.method === 'POST' && /^\/v1\/projects\/[^/]+\/messages:send$/.test(path)) {
      const authorized = issued.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      let body = null;
      try { body = JSON.parse(text); } catch { /* recorded as null */ }
      pushes.push({ path, authorized, body });
      if (!authorized) return answer(401, { error: { code: 401, message: 'No valid token.', status: 'UNAUTHENTICATED' } });
      if (!body) return answer(400, { error: { code: 400, message: 'Not JSON.', status: 'INVALID_ARGUMENT' } });
      return answer(200, { name: `${path.replace(/^\/v1\//, '').replace(/:send$/, '')}/${pushes.length}` });
    }

    return answer(404, { error: { code: 404, message: 'Not found.', status: 'NOT_FOUND' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  return {
    tokenUri: `${base}/token`,
    fcmBaseUrl: base,
    tokens,
    pushes,
    close: () => new Promise((resolve) => { server.close(() => resolve(undefined)); server.closeAllConnections(); }),
  };
}
