# Subscribed Since

A WXT + React Chrome extension that shows how many years you have been
subscribed to a YouTube channel beside that channel's subscribe controls.

## OAuth setup

The extension uses Chrome's Identity API and the YouTube Data API read-only
scope. Before sign-in will work, create a Google Cloud OAuth client for a Chrome
Extension and provide its client ID when running or building:

```sh
YOUTUBE_OAUTH_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com" npm run dev
```

For a stable development/release extension ID, also provide the public extension
key:

```sh
CHROME_EXTENSION_KEY="YOUR_PUBLIC_EXTENSION_KEY" npm run build
```

Without those env vars the project still compiles, but the generated manifest
contains a placeholder OAuth client ID.
