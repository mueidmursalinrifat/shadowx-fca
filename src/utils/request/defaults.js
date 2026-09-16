"use strict";

const constMod = require("../constants");
const getFrom = constMod.getFrom || constMod;
const { get, post, postFormData } = require("./methods");

function makeDefaults(html, userID, ctx) {
  let reqCounter = 1;
  const revision =
    getFrom(html || "", 'revision":', ",") ||
    getFrom(html || "", '"client_revision":', ",") ||
    "";
  function mergeWithDefaults(obj) {
    const base = {
      av: userID,
      __user: userID,
      __req: (reqCounter++).toString(36),
      __rev: revision,
      __a: 1,
    };
    if (ctx?.fb_dtsg) base.fb_dtsg = ctx.fb_dtsg;
    if (ctx?.jazoest) base.jazoest = ctx.jazoest;
    if (!obj) return base;
    for (const k of Object.keys(obj)) if (!(k in base)) base[k] = obj[k];
    return base;
  }
  return {
    get: (url, j, qs, ctxx, customHeader = {}) =>
      get(url, j, mergeWithDefaults(qs), ctx?.globalOptions, ctxx || ctx, customHeader),
    post: (url, j, form, ctxx, customHeader = {}) =>
      post(url, j, mergeWithDefaults(form), ctx?.globalOptions, ctxx || ctx, customHeader),
    postFormData: (url, j, form, qs, ctxx) =>
      postFormData(
        url,
        j,
        mergeWithDefaults(form),
        mergeWithDefaults(qs),
        ctx?.globalOptions,
        ctxx || ctx
      ),
  };
}

module.exports = {
  makeDefaults,
};
