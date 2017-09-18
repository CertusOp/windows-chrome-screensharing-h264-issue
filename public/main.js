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
const codecCheckboxContainer = document.getElementById('codec-checkbox-container');
const h264Checkbox = document.getElementById('checkbox-use-h264');

// Populated by the requsetScreenShare function
let resolveScreenshareRequest = null;
let rejectScreenshareRequest = null;

/**
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

/**
 * Functions for WebRTC communication
 * ============================================================= */

/**
 * Close PeerConnection and reset UI
 */
function endCall() {
  peerConn.close();
  peerConn = null;
  startCallButton.removeAttribute('disabled');
  endCallButton.setAttribute('disabled', true);
  codecCheckboxContainer.style.display = 'block';

  if (localVideoStream) {
    localVideoStream
      .getTracks()
      .forEach((track) => { track.stop(); });
  }

  videoElement.src = '';
}

/**
 * Generate function to clear out blacklisted codecs from m=video field
 *
 * @param {string[]} blacklistedCodecIds
 * @returns {function}
 */
function makeStripMVideoField(blacklistedCodecIds) {
  /**
   * @param {string} field
   * @returns {string}
   */
  return (field) => {
    const isMVideo = field.startsWith('m=video');
    if (!isMVideo) return field;

    return field
      .split(' ')
      .map((piece) => {
        if (blacklistedCodecIds.includes(piece)) return null;

        return piece;
      })
      .filter(piece => piece !== null)
      .join(' ');
  };
}

/**
 * Parses an SDP string to remove offer about h264 codec
 *
 * @param {string} sdpString
 * @returns {string}
 */
function stripCodecs(sdpString, codecs) {
  const fields = sdpString.split('\n');
  // Copy param to avoid reassign
  const blacklistedCodecs = codecs;
  const blacklistedCodecIds = [];

  let isCodecAttr = false;
  let currentCodec = null;
  let ignoreField = false;

  return fields
    // Add related retransimission codecs to blacklist
    // and remove related rtpmap-rtx + fmtp attributes
    .reduce((acc, field) => {
      const isRtpMapAttribute = field.startsWith('a=rtpmap:');
      const isFmtpAttribute = field.startsWith('a=fmtp:');

      if (isRtpMapAttribute) {
        const codecName = field.trim().match(/^.* (.*)\/.*$/)[1];
        // If it's not rtx, move on.
        if (codecName !== 'rtx') return acc.concat([field]);
        // If it is rtx, add the codecId to the list of codecIds to blacklist
        const codecId = field.trim().match(/(?::)([0-9]*)(?=\s)/)[1];
        blacklistedCodecIds.push(codecId);
        // Remove rtx declaration from SDP
        return acc;
      } else if (isFmtpAttribute) {
        const codecId = field.trim().match(/(?::)([0-9]*)(?=\s)/)[1];
        // If it's an media format description attribute and it's concerned
        // with a blacklisted codec, do not include it in the SDP.
        if (blacklistedCodecIds.includes(codecId)) return acc;
      }

      return acc.concat([field]);
    }, [])
    // Strip m=video field of blacklisted codecs
    .map(makeStripMVideoField(blacklistedCodecIds))

    // Use rtpmap and rtcp fields to filter out blacklisted codecs
    .reduce((acc, field) => {
      const isAttribute = field.startsWith('a=');
      // We're only concenred with attribute-fields
      if (!isAttribute) return acc.concat([field]);

      const isRtpMapAttribute = field.startsWith('a=rtpmap:');
      const isRtcpAttribute = field.startsWith('a=rtcp-fb:');

      // If it's a codec attribute, set flag to indicate that it is relevant
      if (isRtpMapAttribute || isRtcpAttribute) {
        isCodecAttr = true;
      } else {
        // reset flags
        isCodecAttr = false;
        ignoreField = false;
      }

      if (!isCodecAttr) return acc.concat([field]);

      let codecId;
      if (isRtpMapAttribute) {
        const codecName = field.trim().match(/^.* (.*)\/.*$/)[1];
        codecId = field.trim().match(/(?::)([0-9]*)(?=\s)/)[1];

        currentCodec = codecName;
      }
      // Ignore if it's a field for a blacklisted codec
      ignoreField = blacklistedCodecs.includes(currentCodec);

      if (!ignoreField) return acc.concat([field]);

      // If it's a blacklisted rtpmap codec, record the corresponding codecid
      if (isRtpMapAttribute && codecId) {
        blacklistedCodecIds.push(codecId);
      }
      // Proceed without including field in SDP
      return acc;
    }, [])
    .join('\n');
}

/**
 * Send offer SDP-message via WebSocket connection
 */
function createAndSendOffer() {
  peerConn.createOffer(
    (offer) => {
      const { sdp, type } = offer.toJSON();

      const modifiedSdp = {
        type,
        sdp: h264Checkbox.checked
          ? stripCodecs(sdp, ['VP8', 'VP9'])
          : stripCodecs(sdp, ['H264']),
      };

      peerConn.setLocalDescription(
        offer,
        () => { wsConn.send(JSON.stringify({ sdp: modifiedSdp })); },
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
      peerConn.setLocalDescription(
        answer,
        () => { wsConn.send(JSON.stringify({ sdp: answer })); },
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
  codecCheckboxContainer.style.display = 'none';
  setTimeout(() => createAndSendAnswer(), 1000); // "hack" to avoid race-condition
}

wsConn.onmessage = function onWsConnMessage(evt) {
  if (!peerConn) answerCall();
  const signal = JSON.parse(evt.data);
  if (signal.sdp) {
    console.log('Received SDP from remote peer.', signal.sdp);
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
