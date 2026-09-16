"use strict";

const FormData = require("form-data");
const headersMod = require("../headers");
const getHeaders = headersMod.getHeaders || headersMod;
const { client } = require("./client");
const { cfg } = require("./config");
const { requestWithRetry } = require("./retry");
const {
  getType,
  toStringVal,
  isStream,
  isBlobLike,
  isPairArrayList,
} = require("./helpers");

function cleanGet(url, ctx) {
  return requestWithRetry(() => client.get(url, cfg()), 3, 1000, ctx);
}

function get(url, reqJar, qs, options, ctx, customHeader) {
  const headers = getHeaders(url, options, ctx, customHeader);
  return requestWithRetry(
    () => client.get(url, cfg({ reqJar, headers, params: qs, proxyUrl: options?.proxy })),
    3,
    1000,
    ctx
  );
}

function post(url, reqJar, form, options, ctx, customHeader) {
  const headers = getHeaders(url, options, ctx, customHeader);
  const ct = String(
    headers["Content-Type"] || headers["content-type"] || "application/x-www-form-urlencoded"
  ).toLowerCase();
  let data;
  if (ct.includes("json")) {
    data = JSON.stringify(form || {});
    headers["Content-Type"] = "application/json";
  } else {
    const p = new URLSearchParams();
    if (form && typeof form === "object") {
      for (const k of Object.keys(form)) {
        let v = form[k];
        if (isPairArrayList(v)) {
          for (const [kk, vv] of v) p.append(`${k}[${kk}]`, toStringVal(vv));
          continue;
        }
        if (Array.isArray(v)) {
          for (const x of v) {
            if (Array.isArray(x) && x.length === 2 && typeof x[1] !== "object")
              p.append(k, toStringVal(x[1]));
            else p.append(k, toStringVal(x));
          }
          continue;
        }
        if (getType(v) === "Object") v = JSON.stringify(v);
        p.append(k, toStringVal(v));
      }
    }
    data = p.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return requestWithRetry(
    () => client.post(url, data, cfg({ reqJar, headers, proxyUrl: options?.proxy })),
    3,
    1000,
    ctx
  );
}

async function postFormData(url, reqJar, form, qs, options, ctx) {
  const fd = new FormData();
  if (form && typeof form === "object") {
    for (const k of Object.keys(form)) {
      const v = form[k];
      if (v === undefined || v === null) continue;
      if (isPairArrayList(v)) {
        for (const [kk, vv] of v)
          fd.append(
            `${k}[${kk}]`,
            typeof vv === "object" && !Buffer.isBuffer(vv) && !isStream(vv)
              ? JSON.stringify(vv)
              : vv
          );
        continue;
      }
      if (Array.isArray(v)) {
        for (const x of v) {
          if (
            Array.isArray(x) &&
            x.length === 2 &&
            x[1] &&
            typeof x[1] === "object" &&
            !Buffer.isBuffer(x[1]) &&
            !isStream(x[1])
          ) {
            fd.append(k, x[0], x[1]);
          } else if (
            Array.isArray(x) &&
            x.length === 2 &&
            typeof x[1] !== "object"
          ) {
            fd.append(k, toStringVal(x[1]));
          } else if (
            x &&
            typeof x === "object" &&
            "value" in x &&
            "options" in x
          ) {
            fd.append(k, x.value, x.options || {});
          } else if (isStream(x) || Buffer.isBuffer(x) || typeof x === "string") {
            fd.append(k, x);
          } else if (isBlobLike(x)) {
            const buf = Buffer.from(await x.arrayBuffer());
            fd.append(k, buf, {
              filename: x.name || k,
              contentType: x.type || undefined,
            });
          } else {
            fd.append(k, JSON.stringify(x));
          }
        }
        continue;
      }
      if (v && typeof v === "object" && "value" in v && "options" in v) {
        fd.append(k, v.value, v.options || {});
        continue;
      }
      if (isStream(v) || Buffer.isBuffer(v) || typeof v === "string") {
        fd.append(k, v);
        continue;
      }
      if (isBlobLike(v)) {
        const buf = Buffer.from(await v.arrayBuffer());
        fd.append(k, buf, {
          filename: v.name || k,
          contentType: v.type || undefined,
        });
        continue;
      }
      if (typeof v === "number" || typeof v === "boolean") {
        fd.append(k, toStringVal(v));
        continue;
      }
      fd.append(k, JSON.stringify(v));
    }
  }
  const headers = { ...getHeaders(url, options, ctx), ...fd.getHeaders() };
  return requestWithRetry(
    () => client.post(url, fd, cfg({ reqJar, headers, params: qs, proxyUrl: options?.proxy })),
    3,
    1000,
    ctx
  );
}

module.exports = {
  cleanGet,
  get,
  post,
  postFormData,
};
