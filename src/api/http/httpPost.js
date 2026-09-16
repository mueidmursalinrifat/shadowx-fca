/**
 * Modified by Mueid Mursalin Rifat
 * HTTP Post Helper Function with Clean Promise/Callback Handling
 */

"use strict";

const { post } = require("../../utils/request");
const { getType } = require("../../utils/format");

const httpPostFactory = function (defaultFuncs, api, ctx) {
  return function httpPost(url, form, callback, notAPI) {
    let resolveFunc;
    let rejectFunc;

    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    // Callback parameter handling
    if (
      !callback &&
      (getType(form) === "Function" || getType(form) === "AsyncFunction")
    ) {
      callback = form;
      form = {};
    }

    if (typeof callback !== "function") {
      callback = () => {};
    }

    form = form || {};

    const handleCallback = (err, data) => {
      callback(err, data);
      if (err) {
        rejectFunc(err);
      } else {
        resolveFunc(data);
      }
    };

    const executor = notAPI ? post : (defaultFuncs?.post || post);

    // Dynamic execution
    executor(url, ctx.jar, form, ctx.globalOptions || {})
      .then((resData) => {
        let data = resData?.data ?? resData;
        if (typeof data === "object") {
          try {
            data = JSON.stringify(data, null, 2);
          } catch {
            // retain object if JSON stringify fails
          }
        }
        handleCallback(null, data);
      })
      .catch((err) => {
        console.error("httpPost error:", err?.message || err);
        handleCallback(err, null);
      });

    return returnPromise;
  };
};

module.exports = httpPostFactory;

