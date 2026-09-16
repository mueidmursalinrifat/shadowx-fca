/**
 * Modified by Mueid Mursalin Rifat
 * HTTP Get Helper Function with Clean Promise & Callback Handling
 */

"use strict";

const { getType } = require("../../utils/format");
const { get } = require("../../utils/request");

const httpGetFactory = function (defaultFuncs, api, ctx) {
  return function httpGet(url, form, callback, notAPI) {
    let resolveFunc;
    let rejectFunc;

    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    // Handle optional 'form' parameter when callback is passed as second argument
    if (
      !callback &&
      (getType(form) === "Function" || getType(form) === "AsyncFunction")
    ) {
      callback = form;
      form = {};
    }

    form = form || {};

    const handleCallback = (err, data) => {
      if (typeof callback === "function") {
        callback(err, data);
      }
      if (err) {
        rejectFunc(err);
      } else {
        resolveFunc(data);
      }
    };

    const executor = notAPI ? get : (defaultFuncs?.get || get);

    executor(url, ctx.jar, form, ctx.globalOptions || {})
      .then((resData) => {
        let data = resData?.data ?? resData;
        if (typeof data === "object") {
          try {
            data = JSON.stringify(data, null, 2);
          } catch {
            // Retain object if stringify fails
          }
        }
        handleCallback(null, data);
      })
      .catch((err) => {
        console.error("httpGet error:", err?.message || err);
        handleCallback(err, null);
      });

    return returnPromise;
  };
};

module.exports = httpGetFactory;
