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
  const YOUTUBE_SUBSCRIPTIONS_URL = "https://www.googleapis.com/youtube/v3/subscriptions";
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
    const token = await getAuthToken(false).catch(() => void 0);
    if (token) {
      await removeCachedToken(token);
    }
    const chromeApi = getChromeApi();
    await new Promise((resolve) => {
      chromeApi.identity?.clearAllCachedAuthTokens?.(() => resolve());
      if (!chromeApi.identity?.clearAllCachedAuthTokens) {
        resolve();
      }
    });
  }
  async function getAuthToken(interactive) {
    const chromeApi = getChromeApi();
    if (!chromeApi.identity?.getAuthToken) {
      throw new Error("Chrome identity API is unavailable.");
    }
    return new Promise((resolve, reject) => {
      chromeApi.identity?.getAuthToken({ interactive }, (result2) => {
        const runtimeError = chromeApi.runtime?.lastError?.message;
        if (runtimeError) {
          reject(new Error(runtimeError));
          return;
        }
        const token = typeof result2 === "string" ? result2 : result2?.token;
        if (!token) {
          reject(new Error("No Google auth token was returned."));
          return;
        }
        resolve(token);
      });
    });
  }
  async function removeCachedToken(token) {
    const chromeApi = getChromeApi();
    await new Promise((resolve) => {
      chromeApi.identity?.removeCachedAuthToken?.({ token }, () => resolve());
      if (!chromeApi.identity?.removeCachedAuthToken) {
        resolve();
      }
    });
  }
  function getChromeApi() {
    return globalThis.chrome ?? {};
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
