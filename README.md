<p align="center">
  <img src="./public/icon/128.png" alt="Subscribed Since logo" width="150" height="150">
</p>
<h1 align="center" style="color:red;">
  Subscribed Since
</h1>

<!--[Chrome Web Store](TODO) · [Firefox Add-ons](TODO) · [Microsoft Edge Add-ons](TODO)-->

Subscribed Since is an open-source browser extension that shows when you
subscribed to a YouTube channel directly on YouTube channel pages.

The extension uses read-only YouTube access to fetch your subscription list and
subscription timestamps, then displays the relevant subscription date beside the
channel controls.

![Subscribed Since showing a subscription date on a YouTube channel page](./docs/assets/showcase.png)

## Usage

1. Open the Subscribed Since menu from the extensions toolbar.
2. Sign in with Google to your YouTube account.
3. Visit a YouTube channel homepage (refresh if needed).
4. If you are subscribed to that channel, the extension shows your subscription
   date on the page.

## Privacy

Subscribed Since requests this Google OAuth scope:

```text
https://www.googleapis.com/auth/youtube.readonly
```

The extension uses this read-only scope only to retrieve your YouTube
subscriptions and their `publishedAt` subscription timestamps from the YouTube
Data API.

Subscription data is stored locally in your browser using extension local storage:

```text
browser.storage.local["ss-cache-state"]
```

Subscribed Since sends an OAuth access token to Google's YouTube Data API to
retrieve your subscriptions. Other than those authorized Google API requests,
it does not upload subscription data to a developer-operated server, sell it,
or use it for advertising.

To inspect the local cache while developing or debugging, open the extension's
service worker DevTools console from `chrome://extensions` and run:

```js
chrome.storage.local.get("ss-cache-state").then(console.log);
```

To clear the local cache:

```js
chrome.storage.local.remove("ss-cache-state");
```

## Permissions

Subscribed Since uses these extension permissions:

- `identity`: sign in with Google through Chrome's token API or Firefox's
  authorization flow.
- `storage`: store subscription metadata locally in the browser.
- `alarms`: refresh subscription metadata periodically.
- `*://*.youtube.com/*`: display subscription dates on YouTube pages.
- `https://www.googleapis.com/*`: call the YouTube Data API.

## Firefox OAuth Setup

Chrome uses its Chrome Extension OAuth client through `chrome.identity`.
Firefox uses a separate Google OAuth client through
`browser.identity.launchWebAuthFlow()`, so configuring Chrome does not configure
Firefox sign-in.

1. In the Google Cloud project, enable the YouTube Data API and create an OAuth
   client of type **Web application** for Firefox.
2. Add the Firefox loopback redirect URI to that client's **Authorized redirect
   URIs** exactly as displayed during testing. It starts with
   `http://127.0.0.1/mozoauth2/`; do not substitute `localhost`.
   If it does not match, the popup error reports the URI the extension used.
3. Build the Firefox package:

   ```sh
   npm run zip:firefox
   ```

   To override the configured Firefox client ID for another Google Cloud
   project, use:

   ```sh
   WXT_FIREFOX_GOOGLE_OAUTH_CLIENT_ID="another-firefox-web-client-id.apps.googleusercontent.com" npm run zip:firefox
   ```

4. Load the rebuilt Firefox extension and test sign in, refresh, page display,
   token expiry/re-authentication, and sign out before submitting
   `dist/subscribed-since-1.0.0-firefox.zip`.

The Firefox flow stores its short-lived access token in local extension storage
until it expires or the user signs out. Chrome continues using its existing
`chrome.identity.getAuthToken()` path. Firefox uses a public client ID and does
not embed a Google OAuth client secret in the extension.

## Contributing

Contributions are welcome. If you find a bug, have an idea for improving the
YouTube page integration, or want to make the popup clearer, feel free to open an
issue or pull request.

For code changes:

1. Fork the repository.
2. Create a feature branch.
3. Install dependencies with `npm install`.
4. Run the extension locally with `npm run dev`.
5. Check your changes with `npm run compile` and `npm run build`.
6. Open a pull request with a short description of what changed and how you
   tested it.

Please keep privacy and permissions in mind when contributing. The extension
should continue to request the minimum access needed, store subscription data
locally, and avoid sending YouTube account data to external services.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
