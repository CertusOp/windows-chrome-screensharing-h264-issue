# WebRTC Screenshare preformance reproduction

## Preparation for replicating the issue

Make sure to install the chrome-extension and start up the server before attempting to replicate the issue.

### Install the extension

1. Open Google Chrome
2. Navigate to `chrome://extensions`
3. Ensure that the `Developer mode checkbox` in the top right-hand corner is checked.
4. Click "Load unpacked extension…", and select the `./extension/` folder.

### Start the server

```bash
# Install dependencies.
npm install
# Start the server
npm start
```

## Replicating the issues

_Make sure you have installed the extension in the chrome-browser used to share the screen._

In two different chrome-tabs, open `https://localhost:3000` (you may need to confirm the use of self-signed certs). One of the tabs will be the reciever, and one the sender.

Depending on your network configuration, you could have these tabs on two different computers.

In one of the tabs, click the "Start sharing" button, and select your source (a `screen` or a `window`).

_A suggestion is to share the window of a playing video (e.g. in VLC) in order to clearly visualize any stutter._

To obtain statistics, visit `chrome://webrtc-internals`.
