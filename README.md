# Client Traffic Inspector

A local tool for one attached browser tab. It records the calls, storage, and cookie flags that backend APM does not see, then writes a security and performance score on the laptop. Nothing is uploaded.

<img width="1440" height="1000" alt="image" src="https://github.com/user-attachments/assets/67d2ec4a-36db-43cc-91d0-e42d9af14435" />

## Five-minute start

```bash
cd client-inspector
npm install
npm start
```

Open `http://127.0.0.1:17321`.

1. In Chrome, open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**.
2. Select the `client-inspector/extension` folder.
3. Open the fixture at `http://127.0.0.1:17321/fixture/`, or the staging app you own.
4. Click the extension, then **Inspect this tab**. Leave Chrome's debugging banner visible.
5. The dashboard fills in. **Copy report** and **Export HAR** are the artifacts to hand to security or QA.

If the app you attach is clean, use **Load demo session**. That rehearsal is BadBank staging: a JWT in `localStorage`, an API key in a query string, a session cookie without `HttpOnly`, a duplicate GET, and a response over 1 MB.

The pairing token defaults to `local-dev`. Set `INSPECTOR_TOKEN` before `npm start` and paste the same value into the extension popup if you want a different one.

## What it captures

The extension attaches with `chrome.debugger` and listens to the network. It does not pause or rewrite requests. Response bodies are kept only for text and JSON under 64 KB. `Authorization`, cookies, and secret-like query parameters are redacted before they are written to SQLite or shown in the dashboard.

Close DevTools on the tab you want to inspect. Chrome allows one debugger client per tab.

## Develop

```bash
npm test
npm run dev
```

`npm run dev` serves the API on port 17321 and the dashboard with reload on port 5173.
