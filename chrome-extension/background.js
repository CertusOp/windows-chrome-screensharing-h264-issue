const dataSources = ['screen', 'window'];

/**
 * Names of extension events.
 *
 * @enum {string}
 */
const EVENT_NAMES = {
  REQUEST_SCREENSHARE: 'RequestScreenSharing',
  ON_REQUEST_FAILED: 'RequestScreenSharingFail',
  ON_EXTENSION_OK: 'RequestScreenSharingOk',
};

/**
 * Request screensharing viachrome.desktopCapture.chooseDesktopMedia
 *
 * @param {any} port
 * @param {string} msg
 */
function requestScreenSharing(port, msg) {
  console.log('port', port);
  console.log('msg', msg);
  window.chrome.desktopCapture.chooseDesktopMedia(
    dataSources,
    port.sender.tab,
    (streamId) => { // Callback
      const responseMessage = Object.assign({}, msg);
      if (streamId) {
        responseMessage.type = EVENT_NAMES.ON_EXTENSION_OK;
        responseMessage.streamId = streamId;
      } else {
        responseMessage.type = EVENT_NAMES.ON_REQUEST_FAILED;
      }

      port.postMessage(responseMessage);
    }
  );
}

// Route events from webapp to the corresponding functions
window.chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message) => {
    if (message.type === EVENT_NAMES.REQUEST_SCREENSHARE) {
      requestScreenSharing(port, message);
    }
  });
});

// Inititiate content-script.js
window.chrome.tabs.query(
  {
    active: true,
    currentWindow: true,
  },
  (tabs) => {
    const tabId = tabs[0].id;
    window.chrome.tabs.executeScript(
      tabId,
      { file: 'content-script.js' },
      () => console.log('[Screensharing Extension] Injected content-script.')
    );
  }
);
