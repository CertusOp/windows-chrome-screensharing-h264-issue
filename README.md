# WebRTC Screenshare preformance reproduction

## Preparation for replicating the issue

### Install the extension

1. Open Google Chrome
2. Navigate to `chrome://extensions`
3. Ensure that the `Developer mode checkbox` in the top right-hand corner is checked.
4. Click "Load unpacked extension…", and select the `./extension/` folder.

### Open the webpage

Serve the `./frontend/` directory from `localhost:3000` (e.g. via `SimpleHTTPServer`), or with the included npm script.

```bash
# Install dependencies
npm install
# serve the website
npm run serve-frontend
```

and open the URL on from the chrome brower.
Press the "Start Screen Sharing" button.
The `MediaStream` object is logged to the console.
