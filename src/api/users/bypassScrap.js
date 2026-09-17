module.exports = function (defaultFuncs, api, ctx) {
  const utils = require("../../utils/sifuShim");
  return function Bypass() {
    return defaultFuncs
      .post("https://web.facebook.com/api/graphql/", ctx.jar, {
        av: api.getCurrentUserID(),
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "FBScrapingWarningMutation",
        variables: "{}",
        server_timestamps: true,
        doc_id: "23944951558421605",
        fb_dtsg: ctx.fb_dtsg
      })
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (resData.errors) {
          throw resData; 
        }
        utils.log.info("fbScrap", "Done Bypassed!");
        return resData.data.fb_scraping_warning_clear;
      })
      .catch(function (err) {
        utils.log.error("fbScrap", err);
        throw err;
      });
  };
};
