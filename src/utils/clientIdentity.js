"use strict";
/**
 * Centralized client-identity configuration.
 *
 * Problem this solves:
 *   Previously, User-Agent / sec-ch-ua / platform / arch / Accept-Language were
 *   hard-coded independently in several files (headers.js, connectMqtt.js,
 *   uploadAttachment.js, module/login.js, module/options.js) with DIFFERENT
 *   Chrome versions (121 / 125 / 139 / 143) and mismatched client hints.
 *   A single HTTP session that claims to be Chrome 121 in one request and
 *   Chrome 143 (with matching sec-ch-ua) in the next is internally
 *   inconsistent - it looks like two different browsers sharing one cookie
 *   jar, which is exactly the kind of implementation bug that produces
 *   "abnormal session" / forced logout behavior server-side.
 *
 * This module is the SINGLE source of truth for what a session claims to be.
 * It does not rotate, randomize, or otherwise try to evade detection - it
 * simply makes sure every subsystem (HTTP, MQTT/WebSocket, file upload)
 * agrees on one coherent, stable identity for the lifetime of a session.
 */

// One version pin used everywhere. Bump this in one place when needed.
const CHROME_VERSION = "139.0.0.0";
const CHROME_MAJOR = CHROME_VERSION.split(".")[0];

const DEFAULT_IDENTITY = Object.freeze({
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
  acceptLanguage: "en-US,en;q=0.9",
  secChUa: `"Chromium";v="${CHROME_MAJOR}", "Not;A=Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`,
  secChUaMobile: "?0",
  secChUaPlatform: '"Windows"',
  secChUaArch: '"x86"',
  secChUaBitness: '"64"',
  secChUaFullVersionList: `"Chromium";v="${CHROME_VERSION}", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="${CHROME_VERSION}"`,
  secChUaPlatformVersion: '"15.0.0"'
});

/**
 * Derive a Chrome major version from a User-Agent string, if it looks like
 * one of our own default UAs. Used so that if a caller supplies a custom
 * Chrome UA via options, the client-hint headers we generate still line up
 * with it instead of silently claiming a different version.
 */
function extractChromeVersion(userAgent) {
  if (typeof userAgent !== "string") return null;
  const m = userAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, major: m[1] };
}

/**
 * Build one internally-consistent identity object for a session.
 * - No arguments: returns the stable default identity.
 * - customUserAgent: if it's a recognizable Chrome UA, the sec-ch-ua/
 *   full-version-list are regenerated to match that exact version instead
 *   of contradicting it. Non-Chrome UAs get the UA respected as-is but no
 *   Chromium client hints are attached (since claiming Chromium hints next
 *   to a non-Chromium UA is itself a contradiction).
 *
 * This function is pure - it never mutates process-wide state and never
 * changes its answer for the same input, so it is safe to call repeatedly
 * for the same session without identity drift.
 */
function getIdentity(customUserAgent) {
  if (!customUserAgent || customUserAgent === DEFAULT_IDENTITY.userAgent) {
    return DEFAULT_IDENTITY;
  }

  const parsed = extractChromeVersion(customUserAgent);
  if (!parsed) {
    // Unknown / non-Chrome UA supplied explicitly by the caller: respect it,
    // but do not attach Chromium-specific client hints that would contradict it.
    return Object.freeze({
      userAgent: customUserAgent,
      acceptLanguage: DEFAULT_IDENTITY.acceptLanguage,
      secChUa: undefined,
      secChUaMobile: undefined,
      secChUaPlatform: undefined,
      secChUaArch: undefined,
      secChUaBitness: undefined,
      secChUaFullVersionList: undefined,
      secChUaPlatformVersion: undefined
    });
  }

  return Object.freeze({
    userAgent: customUserAgent,
    acceptLanguage: DEFAULT_IDENTITY.acceptLanguage,
    secChUa: `"Chromium";v="${parsed.major}", "Not;A=Brand";v="24", "Google Chrome";v="${parsed.major}"`,
    secChUaMobile: "?0",
    secChUaPlatform: DEFAULT_IDENTITY.secChUaPlatform,
    secChUaArch: DEFAULT_IDENTITY.secChUaArch,
    secChUaBitness: DEFAULT_IDENTITY.secChUaBitness,
    secChUaFullVersionList: `"Chromium";v="${parsed.full}", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="${parsed.full}"`,
    secChUaPlatformVersion: DEFAULT_IDENTITY.secChUaPlatformVersion
  });
}

/**
 * Resolve the identity that should be used for a given session context.
 * Caches the resolved identity on the context object so it stays stable
 * (does not get recomputed / drift) for the lifetime of that session, per
 * requirement: "keep the identity stable for the lifetime of one
 * authenticated session".
 */
function getSessionIdentity(ctx) {
  if (ctx && ctx._identity) return ctx._identity;
  const identity = getIdentity(ctx && ctx.globalOptions && ctx.globalOptions.userAgent);
  if (ctx) ctx._identity = identity;
  return identity;
}

module.exports = {
  CHROME_VERSION,
  DEFAULT_IDENTITY,
  getIdentity,
  getSessionIdentity
};
