/**
 * Names of extension events
 *
 * @enum {string}
 */
const EVENT_NAMES = {
  REQUEST_SCREENSHARE: 'RequestScreenSharing',
  ON_REQUEST_FAILED: 'RequestScreenSharingFail',
  ON_EXTENSION_OK: 'RequestScreenSharingOk',
};

const peerConnectionConfig = {
  iceServers: [{
    urls: 'stun:stun.services.mozilla.com',
  }, {
    urls: 'stun:stun.l.google.com:19302',
  }],
};

const wsConn = new WebSocket(`wss://${window.location.host}`);

let localVideoStream; // MediaStream
let peerConn; // RTCPeerConnection

// DOM references
const videoElement = document.getElementById('video-playback');
const startCallButton = document.getElementById('start-call-button');
const endCallButton = document.getElementById('end-call-button');

let resolveScreenshareRequest = null;
let rejectScreenshareRequest = null;


/*
 * Functions for requesting screenshare
 * ============================================================= */

/**
 * Handle incoming messages from extension
 */
function onScreenShareExtensionMessages(event) {
  // Ignore messages from other domains
  if (event.origin !== window.location.origin) return;

  const { type } = event.data;

  // Initiate screen-capture
  if (type === EVENT_NAMES.ON_EXTENSION_OK) {
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: event.data.streamId,
          maxWidth: 1920,
          maxHeight: 1080,
        },
      },
    };

    navigator.webkitGetUserMedia(
      constraints,
      resolveScreenshareRequest,
      rejectScreenshareRequest
    );
  }

  if (type === EVENT_NAMES.ON_REQUEST_FAILED) {
    console.log('User cancelled screensharing!');
  }
}

/**
 * Send message to extension with request initiation of screenshare
 */
function requestScreenShare() {
  window.postMessage({ type: EVENT_NAMES.REQUEST_SCREENSHARE }, '*');

  return new Promise((resolve, reject) => {
    resolveScreenshareRequest = resolve;
    rejectScreenshareRequest = reject;
  })
    .then((stream) => {
      resolveScreenshareRequest = null;
      rejectScreenshareRequest = null;

      return stream;
    });
}

// Listen for messages, and handle those posted by extension
window.addEventListener('message', onScreenShareExtensionMessages);

/*
 * Functions for WebRTC communcation
 * ============================================================= */

/**
 * Close PeerConnection and reset UI
 */
function endCall() {
  peerConn.close();
  peerConn = null;
  startCallButton.removeAttribute('disabled');
  endCallButton.setAttribute('disabled', true);

  if (localVideoStream) {
    localVideoStream
      .getTracks()
      .forEach((track) => { track.stop(); });
  }

  videoElement.src = '';
}

/**
 * Send offer SDP-message via WebSocket connection
 */
function createAndSendOffer() {
  peerConn.createOffer(
    (offer) => {
      const offerSdp = new RTCSessionDescription(offer);
      peerConn.setLocalDescription(
        offerSdp,
        () => { wsConn.send(JSON.stringify({ sdp: offerSdp })); },
        console.error
      );
    },
    console.error
  );
}

/**
 * Send answer SDP-message via WebSocket connection
 */
function createAndSendAnswer() {
  peerConn.createAnswer(
    (answer) => {
      const answerSdp = new RTCSessionDescription(answer);
      peerConn.setLocalDescription(
        answerSdp,
        () => { wsConn.send(JSON.stringify({ sdp: answerSdp })); },
        console.error
      );
    },
    console.error
  );
}

function prepareCall() {
  peerConn = new RTCPeerConnection(peerConnectionConfig);
  // send any ice candidates to the other peer
  peerConn.onicecandidate = (evt) => {
    if (!evt || !evt.candidate) return;
    wsConn.send(JSON.stringify({ candidate: evt.candidate }));
  };

  // once remote stream arrives, update UI and show it in the video element
  peerConn.onaddstream = (evt) => {
    // Update button states
    startCallButton.setAttribute('disabled', true);
    endCallButton.removeAttribute('disabled');
    // set remote video stream as source for video element
    videoElement.src = URL.createObjectURL(evt.stream);
  };
}

function answerCall() {
  prepareCall();
  setTimeout(() => createAndSendAnswer(), 1000);
}

wsConn.onmessage = function onWsConnMessage(evt) {
  if (!peerConn) answerCall();
  const signal = JSON.parse(evt.data);
  if (signal.sdp) {
    console.log('Received SDP from remote peer.');
    peerConn.setRemoteDescription(new RTCSessionDescription(signal.sdp));
  } else if (signal.candidate) {
    console.log('Received ICECandidate from remote peer.');
    peerConn.addIceCandidate(new RTCIceCandidate(signal.candidate));
  } else if (signal.closeConnection) {
    console.log('Received "closeConnection" signal from remote peer.');
    endCall();
  }
};

// Initiate a call, sharing the scren
function initiateCall() {
  prepareCall();
  // get the local stream and send it
  requestScreenShare()
    .then((stream) => {
      localVideoStream = stream;
      peerConn.addStream(localVideoStream);
      createAndSendOffer();
    })
    .catch(console.error);
}

function addEventListeners() {
  startCallButton.removeAttribute('disabled');
  startCallButton.addEventListener('click', initiateCall);
  endCallButton.addEventListener('click', () => {
    endCall();
    wsConn.send(JSON.stringify({ closeConnection: true }));
  });
}

window.addEventListener('load', addEventListeners);
