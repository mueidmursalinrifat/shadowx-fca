"use strict";

const logger = require("../../../func/logger");
const { makeParsable } = require("./textUtils");
const { delay, createEmit, headerOf, buildUrl, formatCookie } = require("./helpers");
const { createMaybeAutoLogin } = require("./autoLogin");

/**
 * Trả về hàm async (res) => parsed | throw.
 * Xử lý: retry 5xx, parse JSON, redirect, cookie/DTSG, checkpoint và auto login.
 */
function parseAndCheckLogin(ctx, http, retryCount = 0) {
  const emit = createEmit(ctx);
  const helpers = { buildUrl, headerOf, formatCookie };
  const maybeAutoLogin = createMaybeAutoLogin(ctx, http, helpers, emit, parseAndCheckLogin);

  return async function handleResponse(res) {
    const status = res?.status ?? 0;

    // Retry khi 5xx
    if (status >= 500 && status < 600) {
      if (retryCount >= 5) {
        const err = new Error(
          "Request retry failed. Check the `res` and `statusCode` property on this error."
        );
        err.statusCode = status;
        err.res = res?.data;
        err.error =
          "Request retry failed. Check the `res` and `statusCode` property on this error.";
        logger(`parseAndCheckLogin: Max retries (5) reached for status ${status}`, "error");
        throw err;
      }
      const baseDelay = retryCount === 0 ? 1500 : 1000 * Math.pow(2, retryCount);
      const jitter = Math.floor(Math.random() * 200);
      const retryTime = Math.min(baseDelay + jitter, 10000);
      const method = String(res?.config?.method || "GET").toUpperCase();
      const url = buildUrl(res?.config);
      logger(
        `parseAndCheckLogin: [${method}] ${url || "(no url)"} -> Retrying request (attempt ${
          retryCount + 1
        }/5) after ${retryTime}ms for status ${status}`,
        "warn"
      );
      await delay(retryTime);
      const ctype = String(
        headerOf(res?.config?.headers, "content-type") || ""
      ).toLowerCase();
      const isMultipart = ctype.includes("multipart/form-data");
      const payload = res?.config?.data;
      const params = res?.config?.params;
      const nextRetry = retryCount + 1;
      try {
        if (method === "GET") {
          const newData = await http.get(url, ctx.jar, params || null, ctx.globalOptions, ctx);
          return await parseAndCheckLogin(ctx, http, nextRetry)(newData);
        }
        if (isMultipart) {
          const newData = await http.postFormData(
            url,
            ctx.jar,
            payload,
            params,
            ctx.globalOptions,
            ctx
          );
          return await parseAndCheckLogin(ctx, http, nextRetry)(newData);
        }
        const newData = await http.post(url, ctx.jar, payload, ctx.globalOptions, ctx);
        return await parseAndCheckLogin(ctx, http, nextRetry)(newData);
      } catch (retryErr) {
        if (
          retryErr?.code === "ERR_INVALID_CHAR" ||
          (retryErr?.message && retryErr.message.includes("Invalid character in header"))
        ) {
          logger(
            `parseAndCheckLogin: Invalid header detected, aborting retry. Error: ${retryErr.message}`,
            "error"
          );
          const err = new Error(
            "Invalid header content detected. Request aborted to prevent crash."
          );
          err.error = "Invalid header content";
          err.statusCode = status;
          err.res = res?.data;
          err.originalError = retryErr;
          throw err;
        }
        if (nextRetry >= 5) {
          logger(
            `parseAndCheckLogin: Max retries reached, returning error instead of crashing`,
            "error"
          );
          const err = new Error(
            "Request retry failed after 5 attempts. Check the `res` and `statusCode` property on this error."
          );
          err.statusCode = status;
          err.res = res?.data;
          err.error = "Request retry failed after 5 attempts";
          err.originalError = retryErr;
          throw err;
        }
        return await parseAndCheckLogin(ctx, http, nextRetry)(res);
      }
    }

    if (status === 404) return;
    if (status !== 200) {
      const err = new Error(
        "parseAndCheckLogin got status code: " +
          status +
          ". Bailing out of trying to parse response."
      );
      err.statusCode = status;
      err.res = res?.data;
      throw err;
    }

    const resBodyRaw = res?.data;
    const body = typeof resBodyRaw === "string" ? makeParsable(resBodyRaw) : resBodyRaw;
    let parsed;
    try {
      parsed = typeof body === "object" && body !== null ? body : JSON.parse(body);
    } catch (e) {
      const err = new Error("JSON.parse error. Check the `detail` property on this error.");
      err.error = "JSON.parse error. Check the `detail` property on this error.";
      err.detail = e;
      err.res = resBodyRaw;
      throw err;
    }

    const method = String(res?.config?.method || "GET").toUpperCase();
    if (parsed?.redirect && method === "GET") {
      const redirectRes = await http.get(parsed.redirect, ctx.jar, null, ctx.globalOptions, ctx);
      return await parseAndCheckLogin(ctx, http)(redirectRes);
    }

    // Cookie từ jsmods
    if (
      parsed?.jsmods &&
      parsed.jsmods.require &&
      Array.isArray(parsed.jsmods.require[0]) &&
      parsed.jsmods.require[0][0] === "Cookie"
    ) {
      parsed.jsmods.require[0][3][0] = String(parsed.jsmods.require[0][3][0] || "").replace(
        "_js_",
        ""
      );
      const requireCookie = parsed.jsmods.require[0][3];
      await ctx.jar.setCookie(
        formatCookie(requireCookie, "facebook"),
        "https://www.facebook.com"
      );
      await ctx.jar.setCookie(
        formatCookie(requireCookie, "messenger"),
        "https://www.messenger.com"
      );
    }

    // DTSG token
    if (parsed?.jsmods && Array.isArray(parsed.jsmods.require)) {
      for (const item of parsed.jsmods.require) {
        if (item[0] === "DTSG" && item[1] === "setToken") {
          ctx.fb_dtsg = item[3][0];
          ctx.ttstamp = "2";
          for (let j = 0; j < ctx.fb_dtsg.length; j++) ctx.ttstamp += ctx.fb_dtsg.charCodeAt(j);
          break;
        }
      }
    }

    if (parsed?.error === 1357001) {
      const err = new Error("Facebook blocked the login");
      err.error = "login_blocked";
      err.res = parsed;
      emit("loginBlocked", { res: parsed });
      throw err;
    }

    const resData = parsed;
    const resStr = JSON.stringify(resData);

    if (
      resStr.includes("XCheckpointFBScrapingWarningController") ||
      resStr.includes("601051028565049")
    ) {
      emit("checkpoint", { type: "scraping_warning", res: resData });
      return await maybeAutoLogin(resData, res?.config);
    }
    if (
      resStr.includes("https://www.facebook.com/login.php?") ||
      String(parsed?.redirect || "").includes("login.php?")
    ) {
      return await maybeAutoLogin(resData, res?.config);
    }
    if (resStr.includes("1501092823525282")) {
      logger("Bot checkpoint 282 detected, please check the account!", "error");
      const err = new Error("Checkpoint 282 detected");
      err.error = "checkpoint_282";
      err.res = resData;
      emit("checkpoint", { type: "282", res: resData });
      emit("checkpoint_282", { res: resData });
      throw err;
    }
    if (resStr.includes("828281030927956")) {
      logger("Bot checkpoint 956 detected, please check the account!", "error");
      const err = new Error("Checkpoint 956 detected");
      err.error = "checkpoint_956";
      err.res = resData;
      emit("checkpoint", { type: "956", res: resData });
      emit("checkpoint_956", { res: resData });
      throw err;
    }

    return parsed;
  };
}

module.exports = {
  parseAndCheckLogin
};
