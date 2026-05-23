var background = (function() {
  "use strict";
  function defineBackground(arg) {
    if (arg == null || typeof arg === "function") return { main: arg };
    return arg;
  }
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  const CACHE_STORAGE_KEY = "ss-cache-state";
  function emptyCacheState() {
    return {
      authStatus: "signed_out",
      subscriptionsByChannelId: {}
    };
  }
  const REFRESH_ALARM = "ss-refresh-subscriptions";
  const REFRESH_PERIOD_MINUTES = 6 * 60;
  const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
  const YOUTUBE_SUBSCRIPTIONS_URL = "https://www.googleapis.com/youtube/v3/subscriptions";
  const FIREFOX_AUTH_TOKEN_STORAGE_KEY = "ss-firefox-google-auth-token";
  const FIREFOX_AUTH_EXPIRY_BUFFER_MS = 60 * 1e3;
  const FIREFOX_GOOGLE_OAUTH_CLIENT_ID = "1082059658861-gjtntrgqnpaes4huds46rgrq4a7hm8df.apps.googleusercontent.com";
  let refreshPromise;
  let visibleChangeRefreshTimer;
  const definition = defineBackground(() => {
    browser.runtime.onInstalled.addListener(() => {
      void ensureRefreshAlarm();
    });
    browser.runtime.onStartup.addListener(() => {
      void ensureRefreshAlarm();
    });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === REFRESH_ALARM) {
        void refreshAllSubscriptions(false);
      }
    });
    browser.runtime.onMessage.addListener(
      (message) => {
        return handleMessage(message);
      }
    );
  });
  async function handleMessage(message) {
    try {
      switch (message.type) {
        case "SS_SIGN_IN": {
          const state = await refreshAllSubscriptions(true);
          return { ok: true, state: toPublicState(state) };
        }
        case "SS_SIGN_OUT": {
          await signOut();
          const state = await saveState(emptyCacheState());
          return { ok: true, state: toPublicState(state) };
        }
        case "SS_GET_STATE": {
          const state = await getState();
          return { ok: true, state: toPublicState(state) };
        }
        case "SS_REFRESH_ALL": {
          const state = await refreshAllSubscriptions(Boolean(message.interactive));
          return { ok: true, state: toPublicState(state) };
        }
        case "SS_GET_STATUS": {
          const state = await getFreshEnoughState(message.channelId);
          return {
            ok: true,
            authStatus: state.authStatus,
            subscription: state.subscriptionsByChannelId[message.channelId],
            lastFullSyncAt: state.lastFullSyncAt,
            lastError: state.lastError
          };
        }
        case "SS_VISIBLE_SUBSCRIPTION_CHANGED": {
          scheduleVisibleChangeRefresh();
          const state = await getState();
          return { ok: true, state: toPublicState(state) };
        }
      }
    } catch (error) {
      const state = await setError(error);
      return {
        ok: false,
        state: toPublicState(state),
        error: getErrorMessage(error)
      };
    }
  }
  async function ensureRefreshAlarm() {
    await browser.alarms.create(REFRESH_ALARM, {
      periodInMinutes: REFRESH_PERIOD_MINUTES
    });
  }
  async function getFreshEnoughState(channelId) {
    const state = await getState();
    if (state.authStatus !== "signed_in") {
      return state;
    }
    if (!state.lastFullSyncAt) {
      return refreshAllSubscriptions(false);
    }
    const lastSync = new Date(state.lastFullSyncAt).getTime();
    const isStale = Number.isNaN(lastSync) ? true : Date.now() - lastSync > REFRESH_PERIOD_MINUTES * 60 * 1e3;
    if (!isStale || state.subscriptionsByChannelId[channelId]) {
      return state;
    }
    refreshAllSubscriptions(false).catch(() => void 0);
    return state;
  }
  async function refreshAllSubscriptions(interactive) {
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = doRefreshAllSubscriptions(interactive).finally(() => {
      refreshPromise = void 0;
    });
    return refreshPromise;
  }
  async function doRefreshAllSubscriptions(interactive) {
    const token = await getAuthToken(interactive);
    const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
    const subscriptionsByChannelId = {};
    await collectSubscriptionPages({
      token,
      fetchedAt,
      subscriptionsByChannelId
    });
    return saveState({
      authStatus: "signed_in",
      lastFullSyncAt: fetchedAt,
      subscriptionsByChannelId
    });
  }
  async function collectSubscriptionPages({
    token,
    fetchedAt,
    subscriptionsByChannelId,
    pageToken
  }) {
    const url = new URL(YOUTUBE_SUBSCRIPTIONS_URL);
    const setSearchParam = url.searchParams.set.bind(url.searchParams);
    setSearchParam("part", "snippet");
    setSearchParam("mine", "true");
    setSearchParam("maxResults", "50");
    if (pageToken) {
      setSearchParam("pageToken", pageToken);
    }
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (response.status === 401) {
      await removeCachedToken(token);
      throw new Error("Google authorization expired. Please sign in again.");
    }
    if (!response.ok) {
      throw new Error(`YouTube API request failed (${response.status}).`);
    }
    const data = await response.json();
    for (const item of data.items ?? []) {
      const channelId = item.snippet?.resourceId?.channelId;
      const subscribedAt = item.snippet?.publishedAt;
      if (!channelId || !subscribedAt) {
        continue;
      }
      subscriptionsByChannelId[channelId] = {
        subscriptionId: item.id ?? channelId,
        channelId,
        channelTitle: item.snippet?.title ?? "YouTube channel",
        subscribedAt,
        fetchedAt
      };
    }
    if (data.nextPageToken) {
      await collectSubscriptionPages({
        token,
        fetchedAt,
        subscriptionsByChannelId,
        pageToken: data.nextPageToken
      });
    }
  }
  async function getState() {
    const result2 = await browser.storage.local.get(CACHE_STORAGE_KEY);
    return {
      ...emptyCacheState(),
      ...result2[CACHE_STORAGE_KEY]
    };
  }
  async function saveState(state) {
    await browser.storage.local.set({ [CACHE_STORAGE_KEY]: state });
    return state;
  }
  async function setError(error) {
    const state = await getState();
    return saveState({
      ...state,
      authStatus: state.authStatus === "signed_in" ? "error" : "signed_out",
      lastError: getErrorMessage(error)
    });
  }
  function toPublicState(state) {
    return {
      authStatus: state.authStatus,
      lastFullSyncAt: state.lastFullSyncAt,
      lastError: state.lastError,
      subscriptionCount: Object.keys(state.subscriptionsByChannelId).length
    };
  }
  function scheduleVisibleChangeRefresh() {
    if (visibleChangeRefreshTimer) {
      clearTimeout(visibleChangeRefreshTimer);
    }
    visibleChangeRefreshTimer = setTimeout(() => {
      void refreshAllSubscriptions(false);
    }, 3e3);
  }
  async function signOut() {
    {
      await browser.storage.local.remove(FIREFOX_AUTH_TOKEN_STORAGE_KEY);
      return;
    }
  }
  async function getAuthToken(interactive) {
    {
      return getFirefoxAuthToken(interactive);
    }
  }
  async function getFirefoxAuthToken(interactive) {
    const storedToken = await getStoredFirefoxAuthToken();
    if (storedToken && storedToken.expiresAt > Date.now() + FIREFOX_AUTH_EXPIRY_BUFFER_MS) {
      return storedToken.accessToken;
    }
    const redirectUri = getFirefoxOAuthRedirectUri();
    const state = crypto.randomUUID();
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.searchParams.set("client_id", FIREFOX_GOOGLE_OAUTH_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "token");
    authorizationUrl.searchParams.set("scope", YOUTUBE_READONLY_SCOPE);
    authorizationUrl.searchParams.set("include_granted_scopes", "true");
    authorizationUrl.searchParams.set("state", state);
    if (!interactive) {
      authorizationUrl.searchParams.set("prompt", "none");
    }
    let redirectResponse;
    try {
      redirectResponse = await getFirefoxIdentity().launchWebAuthFlow({
        url: authorizationUrl.toString(),
        interactive
      });
    } catch (error) {
      throw new Error(
        `Firefox Google authorization failed for redirect URI ${redirectUri}: ${getErrorMessage(error)}`
      );
    }
    if (!redirectResponse) {
      throw new Error("Google authorization did not return a response.");
    }
    const responseParams = new URLSearchParams(
      new URL(redirectResponse).hash.slice(1)
    );
    if (responseParams.get("state") !== state) {
      throw new Error("Google authorization response could not be verified.");
    }
    const oauthError = responseParams.get("error");
    if (oauthError) {
      throw new Error(`Google authorization failed (${oauthError}).`);
    }
    const accessToken = responseParams.get("access_token");
    if (!accessToken) {
      throw new Error("No Google auth token was returned.");
    }
    const grantedScopes = responseParams.get("scope")?.split(" ") ?? [];
    if (!grantedScopes.includes(YOUTUBE_READONLY_SCOPE)) {
      throw new Error("Read-only YouTube access was not granted.");
    }
    const expiresInSeconds = Number(responseParams.get("expires_in"));
    const expiresAt = Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1e3;
    await browser.storage.local.set({
      [FIREFOX_AUTH_TOKEN_STORAGE_KEY]: { accessToken, expiresAt }
    });
    return accessToken;
  }
  async function getStoredFirefoxAuthToken() {
    const result2 = await browser.storage.local.get(FIREFOX_AUTH_TOKEN_STORAGE_KEY);
    const token = result2[FIREFOX_AUTH_TOKEN_STORAGE_KEY];
    if (typeof token?.accessToken !== "string" || typeof token.expiresAt !== "number") {
      return;
    }
    return {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt
    };
  }
  function getFirefoxOAuthRedirectUri() {
    const redirectUrl = new URL(getFirefoxIdentity().getRedirectURL());
    const redirectSubdomain = redirectUrl.hostname.split(".")[0];
    return `http://127.0.0.1/mozoauth2/${redirectSubdomain}`;
  }
  function getFirefoxIdentity() {
    return browser.identity;
  }
  async function removeCachedToken(token) {
    {
      const storedToken = await getStoredFirefoxAuthToken();
      if (storedToken?.accessToken === token) {
        await browser.storage.local.remove(FIREFOX_AUTH_TOKEN_STORAGE_KEY);
      }
      return;
    }
  }
  function getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  function initPlugins() {
  }
  function print(method, ...args) {
    return;
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args)
  };
  let result;
  try {
    initPlugins();
    result = definition.main();
    if (result instanceof Promise) {
      console.warn(
        "The background's main() function return a promise, but it must be synchronous"
      );
    }
  } catch (err) {
    logger.error("The background crashed on startup!");
    throw err;
  }
  const result$1 = result;
  return result$1;
})();
