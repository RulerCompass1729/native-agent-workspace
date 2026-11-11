'use strict';
// Observe the OS's actual display event. Instrumentation must not suppress B1.
const { randomUUID } = require('node:crypto');
function showQuestionNotification(notification, ledger, source) {
  let attemptId = null, displayed = false;
  const gap = reason => { try { ledger?.markQuestionMetricGap(reason); } catch { /* The open epoch remains uncertain. */ } };
  const ack = status => {
    if (!attemptId) return;
    try { ledger.ackQuestionSend(attemptId, status); }
    catch { gap('write-failed'); }
  };
  try {
    const id = randomUUID();
    ledger.beginQuestionSend({ attemptId: id, questionId: source?.questionId ?? null,
      deliveryId: source?.deliveryId ?? null, sourceEventId: source?.eventId ?? null, channel: 'notification' });
    attemptId = id;
  } catch { gap('unobserved-send'); }
  if (!notification) { ack('failed'); return; }
  try {
    notification.on('show', () => {
      if (displayed) { gap('unexpected-display'); return; }
      displayed = true; ack('shown');
    });
    notification.once('failed', () => ack('failed'));
  } catch { gap('unobserved-send'); }
  // show() returns void. Without a show/failed event the intent stays unknown.
  try { notification.show(); }
  catch (error) { ack('unknown'); throw error; }
}
module.exports = { showQuestionNotification };
