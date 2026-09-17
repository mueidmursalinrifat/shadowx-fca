'use strict';

const utils = require("../../utils/sifuShim");

module.exports = function (defaultFuncs, api, ctx) {
  return function getPendingRequests(callback) {
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const form = {
      av: ctx.i_userID || ctx.userID,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'FriendingCometFriendRequestsRootQueryRelayPreloader',
      doc_id: '4499164963466303',
      variables: JSON.stringify({ input: { scale: 3 } })
    };

    defaultFuncs
      .post('https://www.facebook.com/api/graphql/', ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(resData => {
        const listRequest = resData.data?.viewer?.friending_possibilities?.edges || [];

        const simplified = listRequest.map(req => {
          const node = req.node || {};
          return {
            id: node.id,
            name: node.name,
            profilePic: node.profile_picture?.uri || null,
            url: node.url,
            time: req.time,
            mutualFriends: node.social_context_top_mutual_friends?.map(f => ({
              id: f.id,
              name: f.name,
              profilePic: f.profile_picture?.uri || null,
              url: f.url
            })) || []
          };
        });

        if (callback) callback(null, simplified);
        resolveFunc(simplified);
      })
      .catch(err => {
        utils.error('getPendingRequests', err);
        if (callback) callback(err);
        rejectFunc(err);
      });

    return returnPromise;
  };
};
