'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'nh_session';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEV_FALLBACK_SECRET = 'dev-insecure-session-secret-change-me';

let warnedAboutDevSecret = false;

function isProductionDeployment() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.VERCEL === 'true';
}

/**
 * Resolves the HMAC signing secret. Fails fast in production so a deployment
 * never issues sessions signed with a well-known key.
 */
function getSecret() {
  const secret = (process.env.SESSION_SECRET || '').trim();
  if (secret) return secret;

  if (isProductionDeployment()) {
    throw new Error('SESSION_SECRET must be set in production. Refusing to sign sessions with a shared dev key.');
  }

  if (!warnedAboutDevSecret) {
    warnedAboutDevSecret = true;
    console.warn('[auth] SESSION_SECRET not set; using an insecure development secret. Do not use this in production.');
  }
  return DEV_FALLBACK_SECRET;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function sign(payloadSegment) {
  return base64url(crypto.createHmac('sha256', getSecret()).update(payloadSegment).digest());
}

/**
 * Creates a signed, stateless session token.
 * @param {{ sub: number|string, identifier: string }} claims
 */
function createSessionToken(claims, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    sub: claims.sub,
    identifier: claims.identifier,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const payloadSegment = base64url(JSON.stringify(payload));
  return `${payloadSegment}.${sign(payloadSegment)}`;
}

/**
 * Verifies a session token and returns its claims, or null when invalid/expired.
 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [payloadSegment, providedSignature] = token.split('.');
  if (!payloadSegment || !providedSignature) return null;

  let expectedSignature;
  try {
    expectedSignature = sign(payloadSegment);
  } catch (err) {
    console.error('[auth] cannot verify session:', err.message);
    return null;
  }

  const expectedBuf = Buffer.from(expectedSignature);
  const providedBuf = Buffer.from(providedSignature);
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(payloadSegment).toString('utf8'));
  } catch (err) {
    return null;
  }

  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

/**
 * Startup guard: force a clear failure in production when SESSION_SECRET is
 * missing, rather than 500-ing later on the first signup/login.
 */
function assertSessionSecretConfigured() {
  getSecret();
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const jar = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) jar[key] = decodeURIComponent(value);
  }
  return jar;
}

function setSessionCookie(res, token, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ];
  if (isProductionDeployment()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProductionDeployment()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/**
 * Populates req.user from the session cookie when present and valid.
 * Never rejects the request — use requireAuth for that.
 */
function attachUser(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  const claims = token ? verifySessionToken(token) : null;
  req.user = claims ? { id: claims.sub, identifier: claims.identifier } : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_SECONDS,
  assertSessionSecretConfigured,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
};
