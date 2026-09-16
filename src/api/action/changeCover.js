/**d
 * Change Facebook Profile Cover Photo via GraphQL Mutation.
 */

"use strict";

const log = require("../../../func/logAdapter");
const { isReadableStream } = require("../../utils/constants");
const { parseAndCheckLogin } = require("../../utils/client");
const { getType } = require("../../utils/format");

module.exports = function (defaultFuncs, api, ctx) {
  function handleUpload(image, callback) {
    const userID = ctx.i_userID || ctx.userID;

    const form = {
      profile_id: userID,
      photo_source: 57,
      av: userID,
      file: image
    };

    defaultFuncs
      .postFormData(
        "https://www.facebook.com/profile/picture/upload/",
        ctx.jar,
        form,
        {}
      )
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (!resData || resData.error || resData.errors || !resData.payload) {
          throw resData || new Error("Cover image upload failed");
        }

        if (!resData.payload.fbid) {
          throw new Error("Facebook did not return photo ID");
        }

        callback(null, resData);
      })
      .catch(function (err) {
        log.error("handleCoverUpload", err);
        callback(err);
      });
  }

  return function changeCover(image, callback) {
    let resolveFunc;
    let rejectFunc;

    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (
      !callback &&
      (getType(image) === "Function" || getType(image) === "AsyncFunction")
    ) {
      callback = image;
      image = null;
    }

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

    if (!isReadableStream(image)) {
      handleCallback(new Error("Image is not a readable stream"));
      return returnPromise;
    }

    handleUpload(image, function (err, payload) {
      if (err) {
        return handleCallback(err);
      }

      const userID = ctx.i_userID || ctx.userID;
      const photoID = payload?.payload?.fbid;

      if (!photoID) {
        return handleCallback(new Error("Cover photo ID not found"));
      }

      const variables = {
        input: {
          attribution_id_v2:
            `ProfileCometCollectionRoot.react,` +
            `comet.profile.collection.photos_by,unexpected,` +
            `${Date.now()},770083,,;` +
            `ProfileCometCollectionRoot.react,` +
            `comet.profile.collection.photos_albums,unexpected,` +
            `${Date.now()},470774,,;` +
            `ProfileCometCollectionRoot.react,` +
            `comet.profile.collection.photos,unexpected,` +
            `${Date.now()},94740,,;` +
            `ProfileCometCollectionRoot.react,` +
            `comet.profile.collection.saved_reels_on_profile,unexpected,` +
            `${Date.now()},89669,,;` +
            `ProfileCometCollectionRoot.react,` +
            `comet.profile.collection.reels_tab,unexpected,` +
            `${Date.now()},152201,,`,

          cover_photo_id: String(photoID),
          focus: {
            x: 0.5,
            y: 1
          },
          target_user_id: String(userID),
          actor_id: String(userID),
          client_mutation_id: Math.round(Math.random() * 19).toString()
        },
        scale: 1,
        contextualProfileContext: null
      };

      const form = {
        av: String(userID),
        fb_api_req_friendly_name: "ProfileCometCoverPhotoUpdateMutation",
        fb_api_caller_class: "RelayModern",
        doc_id: "8247793861913071",
        server_timestamps: true,
        variables: JSON.stringify(variables)
      };

      defaultFuncs
        .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
        .then(parseAndCheckLogin(ctx, defaultFuncs))
        .then(function (resData) {
          if (!resData || resData.error || resData.errors) {
            throw resData || new Error("Cover photo update failed");
          }

          const finalData = Array.isArray(resData) ? resData[0] : resData;

          const coverURL =
            finalData?.data?.user_update_cover_photo?.user?.cover_photo?.photo?.url ||
            resData?.data?.user_update_cover_photo?.user?.cover_photo?.photo?.url;

          if (!coverURL) {
            return handleCallback(null, finalData);
          }

          return handleCallback(null, coverURL);
        })
        .catch(function (err) {
          log.error("changeCover", err?.message || err);
          return handleCallback(err);
        });
    });

    return returnPromise;
  };
};
