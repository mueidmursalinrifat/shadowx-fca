"use strict";

// Cookie helpers extracted from client.js

function saveCookies(jar) {
  return res => {
    try {
      const setCookie = res?.headers?.["set-cookie"];
      if (Array.isArray(setCookie) && setCookie.length) {
        const url =
          res?.request?.res?.responseUrl ||
          (res?.config?.baseURL
            ? new URL(res.config.url || "/", res.config.baseURL).toString()
            : res?.config?.url || "https://www.facebook.com");
        for (const c of setCookie) {
          try {
            jar.setCookieSync(c, url);
          } catch {
            // ignore per-cookie errors
          }
        }
      }
    } catch {
      // ignore unexpected cookie parsing errors
    }
    return res;
  };
}

function getAppState(jar) {
  if (!jar || typeof jar.getCookiesSync !== "function") return [];
  const urls = ["https://www.facebook.com"];
  const all = urls.flatMap(u => {
    try {
      return jar.getCookiesSync(u) || [];
    } catch {
      return [];
    }
  });
  const seen = new Set();
  const out = [];
  for (const c of all) {
    const key = c.key || c.name;
    if (!key) continue;
    const id = key + "|" + (c.domain || "") + "|" + (c.path || "/");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      key,
      value: c.value,
      domain: c.domain || ".facebook.com",
      path: c.path || "/",
      hostOnly: !!c.hostOnly,
      creation: c.creation || new Date(),
      lastAccessed: c.lastAccessed || new Date(),
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expires: c.expires && c.expires !== "Infinity" ? c.expires : "Infinity"
    });
  }
  return out;
}

module.exports = {
  saveCookies,
  getAppState
};

