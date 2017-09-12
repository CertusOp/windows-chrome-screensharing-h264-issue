/**
 * Names of extension events.
 *
 * @enum {string}
 */
const EXTENSION_MESSAGES = {
  REQUEST_SCREENSHARE: 'RequestScreenSharing',
  ON_REQUEST_FAILED: 'RequestScreenSharingFail',
  ON_EXTENSION_OK: 'RequestScreenSharingOk',
};

const port = window.chrome.runtime.connect(window.chrome.runtime.id);

port.onMessage.addListener((message) => {
  window.postMessage(message, '*');
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return; // Exit if event comes from remote source

  const { type } = event.data;

  if (
    type === EXTENSION_MESSAGES.STOP_SCREENSHARE ||
    type === EXTENSION_MESSAGES.REQUEST_SCREENSHARE
  ) {
    port.postMessage(event.data);
  }
}, false);

console.log('[Screensharing Extension] Content script running.');
