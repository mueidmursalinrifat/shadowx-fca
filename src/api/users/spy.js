"use strict";

module.exports = (defaultFuncs, api, ctx) => {
    return async function spy(userID, callback) {
        let resolveFunc = () => {}, rejectFunc = () => {};
        const returnPromise = new Promise((resolve, reject) => {
            resolveFunc = resolve;
            rejectFunc  = reject;
        });

        if (typeof callback !== "function") {
            callback = (err, data) => {
                if (err) return rejectFunc(err);
                resolveFunc(data);
            };
        }

        try {
            const uid = String(userID).trim();
            if (!/^\d{1,20}$/.test(uid)) {
                return callback(new Error("spy: invalid user ID — must be numeric"));
            }

            const infoMap = await api.getUserInfo(uid);
            const info    = infoMap?.[uid] || null;

            if (!info) return callback(new Error(`spy: could not retrieve info for UID ${uid}`));

            callback(null, info);
        } catch (err) {
            callback(err);
        }

        return returnPromise;
    };
};
