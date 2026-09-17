'use strict';

module.exports = function (defaultFuncs, api, ctx) {
  return function sendTypingIndicatorMqtt(isTyping, threadID, callback) {
    if (!ctx.mqttClient) {
      throw new Error('Not connected to MQTT');
    }

    ctx.wsReqNumber += 1;

    api.getThreadInfo(threadID)
      .then(threadData => {
        const isGroupThread = threadData.isGroup ? 1 : 0;

        const taskPayload = {
          thread_key: threadID,
          is_group_thread: isGroupThread,
          is_typing: isTyping ? 1 : 0,
          attribution: 0
        };

        const content = {
          app_id: '2220391788200892',
          payload: JSON.stringify({
            label: '3',
            payload: JSON.stringify(taskPayload),
            version: '25393437286970779'
          }),
          request_id: ctx.wsReqNumber,
          type: 4
        };

        ctx.mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1, retain: false });
      })
      .catch(() => {
        throw new Error('sendTypingIndicatorMqtt: Failed to get thread info for threadID ' + threadID);
      });
  };
};
