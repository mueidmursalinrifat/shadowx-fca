'use strict';

const utils = require("../../utils/sifuShim");

function isCallable(func) {
  try {
    Reflect.apply(func, null, []);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = function (defaultFuncs, api, ctx) {
  return function changeBlockedStatusMqtt(userID, status, type, callback) {
    if (!ctx.mqttClient) {
      throw new Error('Not connected to MQTT');
    }

    ctx.wsReqNumber += 1;
    ctx.wsTaskNumber += 1;

    const label = '334';
    let userBlockAction = 0;

    switch (type) {
      case 'messenger':
        userBlockAction = status ? 1 : 0;
        break;
      case 'facebook':
        userBlockAction = status ? 3 : 2;
        break;
      default:
        throw new Error('Invalid type — use "messenger" or "facebook"');
    }

    const taskPayload = {
      blockee_id: userID,
      request_id: utils.getGUID(),
      user_block_action: userBlockAction
    };

    const task = {
      failure_count: null,
      label,
      payload: JSON.stringify(taskPayload),
      queue_name: 'native_sync_block',
      task_id: ctx.wsTaskNumber
    };

    const content = {
      app_id: '2220391788200892',
      payload: JSON.stringify({
        tasks: [task],
        epoch_id: parseInt(utils.generateOfflineThreadingID()),
        version_id: '25393437286970779'
      }),
      request_id: ctx.wsReqNumber,
      type: 3
    };

    if (isCallable(callback)) {
      ctx.reqCallbacks[ctx.wsReqNumber] = callback;
    }

    ctx.mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1, retain: false });
  };
};
