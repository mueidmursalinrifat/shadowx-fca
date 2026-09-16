/**
 * Send a friend request to a Facebook user.
 */

"use strict";

const log = require("../../../func/logAdapter");
const { parseAndCheckLogin } = require("../../utils/client");
const { formatID } = require("../../utils/format");

module.exports = function (defaultFuncs, api, ctx) {
  return function addFriend(userID, callback) {
    let resolveFunc;
    let rejectFunc;

    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

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

    /*
     * Validate user ID
     */
    let targetID;
    try {
      targetID = formatID(userID);
    } catch (err) {
      handleCallback(err);
      return returnPromise;
    }

    if (!targetID) {
      handleCallback(new Error("Invalid user ID"));
      return returnPromise;
    }

    if (String(targetID) === String(ctx.userID)) {
      handleCallback(new Error("You cannot send a friend request to yourself"));
      return returnPromise;
    }

    /*
     * Facebook friend request payload
     */
    const form = {
      uid: String(targetID),
      viewer_id: String(ctx.userID),
      source: "profile_button",
      ref: "profile",
      floc: "profile",
      nctr: "profile"
    };

    defaultFuncs
      .post(
        "https://www.facebook.com/ajax/friends/requests/send/",
        ctx.jar,
        form
      )
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (!resData) {
          throw new Error("Empty response from Facebook");
        }

        if (resData.error || resData.errors || resData.errorDescription) {
          throw resData;
        }

        const payload = resData.payload;

        if (payload) {
          if (payload.error || payload.err) {
            throw payload;
          }

          if (payload.errorDescription) {
            throw new Error(payload.errorDescription);
          }
        }

        const result = {
          success: true,
          userID: String(targetID),
          response: resData
        };

        return handleCallback(null, result);
      })
      .catch(function (err) {
        log.error("addFriend", err?.message || err);
        return handleCallback(err);
      });

    return returnPromise;
  };
};

