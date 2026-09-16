"use strict";

const { getIdentity } = require("./clientIdentity");

// Sanitize header value to remove invalid characters
function sanitizeHeaderValue(value) {
  if (value === null || value === undefined) return "";
  let str = String(value);

  // Remove array-like strings (e.g., "["performAutoLogin"]")
  // This handles cases where arrays were accidentally stringified
  if (str.trim().startsWith("[") && str.trim().endsWith("]")) {
    // Try to detect if it's a stringified array and remove it
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        // If it's an array, return empty string (invalid header value)
        return "";
      }
    } catch {
      // Not valid JSON, continue with normal sanitization
    }
  }

  // Remove invalid characters for HTTP headers:
  // - Control characters (0x00-0x1F, except HTAB 0x09)
  // - DEL character (0x7F)
  // - Newlines and carriage returns
  // - Square brackets (often indicate array stringification issues)
  str = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F\r\n\[\]]/g, "").trim();

  return str;
}

// Sanitize header name to ensure it's valid
function sanitizeHeaderName(name) {
  if (!name || typeof name !== "string") return "";
  // Remove invalid characters for HTTP header names
  return name.replace(/[^\x21-\x7E]/g, "").trim();
}

function getHeaders(url, options, ctx, customHeader) {
  const u = new URL(url);
  // Resolve one internally-consistent identity (UA + matching client hints)
  // instead of hard-coding a browser version here that could contradict
  // what other subsystems (MQTT, upload) claim to be.
  const identity = getIdentity(options?.userAgent);
  const ua = identity.userAgent;
  const referer = options?.referer || "https://www.facebook.com/";
  const origin = referer.replace(/\/+$/, "");
  const contentType = options?.contentType || "application/x-www-form-urlencoded";
  const acceptLang = options?.acceptLanguage || identity.acceptLanguage;
  const headers = {
    Host: sanitizeHeaderValue(u.host),
    Origin: sanitizeHeaderValue(origin),
    Referer: sanitizeHeaderValue(referer),
    "User-Agent": sanitizeHeaderValue(ua),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": sanitizeHeaderValue(acceptLang),
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": sanitizeHeaderValue(contentType),
    Connection: "keep-alive",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Requested-With": "XMLHttpRequest",
    Pragma: "no-cache",
    "Cache-Control": "no-cache"
  };
  // Only attach Chromium client hints when the identity actually has them
  // (a non-Chrome UA supplied by the caller intentionally omits these, so we
  // never claim client hints that contradict the User-Agent string).
  if (identity.secChUa) headers["sec-ch-ua"] = identity.secChUa;
  if (identity.secChUaMobile) headers["sec-ch-ua-mobile"] = identity.secChUaMobile;
  if (identity.secChUaPlatform) headers["sec-ch-ua-platform"] = identity.secChUaPlatform;
  if (identity.secChUaArch) headers["sec-ch-ua-arch"] = identity.secChUaArch;
  if (identity.secChUaBitness) headers["sec-ch-ua-bitness"] = identity.secChUaBitness;
  if (identity.secChUaFullVersionList) headers["sec-ch-ua-full-version-list"] = identity.secChUaFullVersionList;
  if (identity.secChUaPlatformVersion) headers["sec-ch-ua-platform-version"] = identity.secChUaPlatformVersion;
  if (ctx?.region) {
    const regionValue = sanitizeHeaderValue(ctx.region);
    if (regionValue) headers["X-MSGR-Region"] = regionValue;
  }
  if (customHeader && typeof customHeader === "object") {
    // Filter customHeader to only include valid HTTP header values (strings, numbers, booleans)
    // Exclude functions, objects, arrays, and other non-serializable values
    for (const [key, value] of Object.entries(customHeader)) {
      // Skip null, undefined, functions, objects, and arrays
      if (value === null || value === undefined || typeof value === "function") {
        continue;
      }
      if (typeof value === "object") {
        // Arrays are objects in JavaScript, so check for arrays explicitly
        if (Array.isArray(value)) {
          continue;
        }
        // Skip plain objects (but allow null which is already handled above)
        continue;
      }
      // Only allow strings, numbers, and booleans - convert to string and sanitize
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const sanitizedKey = sanitizeHeaderName(key);
        const sanitizedValue = sanitizeHeaderValue(value);
        if (sanitizedKey && sanitizedValue !== "") {
          headers[sanitizedKey] = sanitizedValue;
        }
      }
    }
  }
  // Final pass: sanitize all header values to ensure no invalid characters
  const sanitizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const sanitizedKey = sanitizeHeaderName(key);
    const sanitizedValue = sanitizeHeaderValue(value);
    if (sanitizedKey && sanitizedValue !== "") {
      sanitizedHeaders[sanitizedKey] = sanitizedValue;
    }
  }
  return sanitizedHeaders;
}

module.exports = { getHeaders };
