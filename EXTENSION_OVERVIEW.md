# Subscribed Since Extension Overview

## What it does

Subscribed Since is a Chrome extension that shows when the signed-in user subscribed to a YouTube channel.

When the user visits a YouTube channel page, the extension tries to identify the current channel and then checks a locally cached copy of the user's YouTube subscriptions. If the current channel is in that cache, the extension inserts a compact badge beside YouTube's channel subscribe controls.

The badge shows:

- A short subscription tenure mark, such as `3Y`, `8M`, or `12D`.
- A label reading `SUBSCRIBED SINCE`.
- The exact subscription date, formatted as a local date such as `January 15, 2021`.

The extension only has read-only YouTube access. It does not subscribe, unsubscribe, edit subscriptions, upload data to an external service, or store subscription data outside the browser's local extension storage.

## Main user flow

1. The user opens the extension popup.
2. If they are signed out, the popup offers `Sign in with Google`.
3. Signing in uses Chrome's Identity API with the YouTube Data API read-only scope.
4. After authorization, the background script fetches the user's YouTube subscriptions from the YouTube Data API.
5. The fetched subscriptions are cached in `browser.storage.local`.
6. When the user visits a YouTube channel page, the content script reads the current channel ID and asks the background script whether that channel is in the cache.
7. If a matching subscription exists, the content script renders the badge in the channel header near the subscribe controls.
8. The popup can refresh the cache or sign the user out.

## Extension architecture

The extension is built with WXT, React, TypeScript, and Tailwind CSS.

The main pieces are:

- `wxt.config.ts`: Defines the extension manifest, permissions, OAuth client, YouTube host permissions, and web-accessible page-context helper script.
- `src/entrypoints/background.ts`: Owns Google auth, YouTube API syncing, cache storage, alarms, and runtime message handling.
- `src/entrypoints/content/index.ts`: Runs on YouTube pages, detects channel pages, finds channel IDs, watches YouTube navigation, and injects or removes the badge.
- `src/entrypoints/popup/App.tsx`: Provides the popup UI for sign-in, refresh, sign-out, sync status, error state, and cached channel count.
- `src/lib/messages.ts`: Defines the shared request, response, public state, cache state, and subscription record types.
- `public/page-context-channel.js`: Runs in the YouTube page context so the content script can read YouTube's page data when DOM metadata alone is not enough.

## Permissions and OAuth

The manifest requests:

- `identity`: Used to get a Google OAuth token through Chrome's Identity API.
- `storage`: Used to persist the local subscription cache.
- `alarms`: Used to periodically refresh the subscription cache.
- `*://*.youtube.com/*`: Allows the content script to run on YouTube pages.
- `https://www.googleapis.com/*`: Allows the background script to call the YouTube Data API.

The OAuth scope is:

```text
https://www.googleapis.com/auth/youtube.readonly
```

That scope lets the extension read the user's YouTube subscription list. It does not grant write access.

## Background script behavior

The background script is the central data and auth layer.

It handles these runtime messages:

- `SS_SIGN_IN`: Requests an interactive Google auth token, fetches all subscriptions, saves them, and returns public state.
- `SS_SIGN_OUT`: Removes cached Google auth tokens, clears the extension cache, and returns signed-out state.
- `SS_GET_STATE`: Returns public cache state for the popup.
- `SS_REFRESH_ALL`: Refreshes the full subscription cache, optionally with interactive auth.
- `SS_GET_STATUS`: Returns the subscription record for a specific channel ID if one exists.
- `SS_VISIBLE_SUBSCRIPTION_CHANGED`: Schedules a short delayed refresh after the content script notices a visible subscribe button state change.

To sync subscriptions, the background script calls:

```text
https://www.googleapis.com/youtube/v3/subscriptions
```

with:

- `part=snippet`
- `mine=true`
- `maxResults=50`
- `pageToken` when additional pages exist

It follows `nextPageToken` until all subscriptions have been fetched. Each subscription is stored by channel ID.

The background script also creates an alarm named `ss-refresh-subscriptions` that refreshes the cache every six hours. If multiple refresh requests happen at once, it reuses a single in-flight refresh promise instead of starting duplicate API fetches.

## Stored data

The extension stores one cache object under the local storage key:

```text
ss-cache-state
```

The cache contains:

- `authStatus`: `signed_out`, `signed_in`, or `error`.
- `lastFullSyncAt`: The timestamp of the last successful full subscription sync.
- `lastError`: The most recent error message, when one exists.
- `subscriptionsByChannelId`: A map of YouTube channel IDs to subscription records.

Each subscription record contains:

- `subscriptionId`
- `channelId`
- `channelTitle`
- `subscribedAt`
- `fetchedAt`

The popup only receives public state: auth status, last sync time, last error, and subscription count. Full subscription details are used internally by the background script and content script status checks.

## Content script behavior

The content script runs on YouTube pages and only renders badges on channel pages. It treats these path patterns as supported channel pages:

- `/@...`
- `/channel/...`
- `/c/...`
- `/user/...`

To identify the current channel, it tries several strategies:

1. Read a channel ID directly from the URL if the URL contains a `UC...` channel ID.
2. Query known YouTube DOM locations, metadata tags, canonical links, and channel header links.
3. Inject `page-context-channel.js` and ask it to read YouTube's page-context data, including `window.ytInitialData` and `ytd-browse.data`.

Once it has a channel ID, it sends `SS_GET_STATUS` to the background script. If the background returns a matching subscription record, the content script calculates the tenure and inserts the badge.

The badge is appended near YouTube's subscribe controls. The script searches multiple YouTube header layouts so it can work across current and older channel header variants.

## YouTube navigation handling

YouTube behaves like a single-page app, so normal page-load detection is not enough. The content script watches several signals:

- `yt-navigate-start`
- `yt-navigate-finish`
- `yt-page-data-updated`
- `popstate`
- `focus`
- `visibilitychange`
- DOM mutations

On navigation, it clears stale badge state, waits briefly for YouTube's header to settle, and repeatedly attempts rendering for a short window. It also runs a watchdog interval that checks whether the page URL changed or whether the badge disappeared from a supported channel page.

This makes the badge resilient when YouTube updates the page without doing a full browser navigation.

## Subscribe button change handling

The content script watches the visible subscribe surface on channel pages. If the button text, label, title, or nearby DOM changes, the script assumes the user's subscription state may have changed.

It then:

1. Clears the current page-level badge cache.
2. Sends `SS_VISIBLE_SUBSCRIPTION_CHANGED` to the background script.
3. The background script schedules a full subscription refresh after a short delay.
4. The content script retries rendering a few seconds later.

This lets the extension update after the user subscribes or unsubscribes from a visible channel page.

## Badge formatting

The badge tenure is calculated from the subscription date to the current date.

- If the user has been subscribed for at least one full year, it shows years, such as `4Y`.
- If less than a year but at least one full month, it shows months, such as `6M`.
- Otherwise, it shows days, such as `9D`.

The accessible label includes both the exact date and the expanded tenure, for example:

```text
Subscribed since January 15, 2021, 5 years
```

The badge uses YouTube theme variables where possible and has explicit dark-mode styling.

## Popup behavior

The popup displays:

- Extension title and description.
- Current auth status.
- Number of cached channels.
- Last sync time, if available.
- Last error, if available.
- Action buttons for sign-in, refresh, and sign-out.

When signed out, the popup shows `Sign in with Google`.

When signed in or in an error state, it shows `Refresh` and `Sign out`.

## Error handling

If the YouTube API returns `401`, the background script removes the cached auth token and asks the user to sign in again.

If any background operation fails, the error is saved into local state and returned to the popup. If the user was signed in, the auth status becomes `error`; otherwise it remains `signed_out`.

If the content script detects that the extension context has been invalidated, it disconnects observers, clears timers, and removes its badge.

## What it does not do

The extension does not:

- Modify the user's YouTube subscriptions.
- Send subscription data to a custom backend.
- Persist data anywhere except local extension storage.
- Render badges on non-channel YouTube pages.
- Show dates for channels the user is not subscribed to.
- Fetch per-channel status from YouTube on every page visit. It relies on the local subscription cache and periodic refreshes.
