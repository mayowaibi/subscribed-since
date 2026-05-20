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
  var _MatchPattern = class {
    constructor(matchPattern) {
      if (matchPattern === "<all_urls>") {
        this.isAllUrls = true;
        this.protocolMatches = [..._MatchPattern.PROTOCOLS];
        this.hostnameMatch = "*";
        this.pathnameMatch = "*";
      } else {
        const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
        if (groups == null)
          throw new InvalidMatchPattern(matchPattern, "Incorrect format");
        const [_, protocol, hostname, pathname] = groups;
        validateProtocol(matchPattern, protocol);
        validateHostname(matchPattern, hostname);
        this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
        this.hostnameMatch = hostname;
        this.pathnameMatch = pathname;
      }
    }
    includes(url) {
      if (this.isAllUrls)
        return true;
      const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
      return !!this.protocolMatches.find((protocol) => {
        if (protocol === "http")
          return this.isHttpMatch(u);
        if (protocol === "https")
          return this.isHttpsMatch(u);
        if (protocol === "file")
          return this.isFileMatch(u);
        if (protocol === "ftp")
          return this.isFtpMatch(u);
        if (protocol === "urn")
          return this.isUrnMatch(u);
      });
    }
    isHttpMatch(url) {
      return url.protocol === "http:" && this.isHostPathMatch(url);
    }
    isHttpsMatch(url) {
      return url.protocol === "https:" && this.isHostPathMatch(url);
    }
    isHostPathMatch(url) {
      if (!this.hostnameMatch || !this.pathnameMatch)
        return false;
      const hostnameMatchRegexs = [
        this.convertPatternToRegex(this.hostnameMatch),
        this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))
      ];
      const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
      return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
    }
    isFileMatch(url) {
      throw Error("Not implemented: file:// pattern matching. Open a PR to add support");
    }
    isFtpMatch(url) {
      throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
    }
    isUrnMatch(url) {
      throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
    }
    convertPatternToRegex(pattern) {
      const escaped = this.escapeForRegex(pattern);
      const starsReplaced = escaped.replace(/\\\*/g, ".*");
      return RegExp(`^${starsReplaced}$`);
    }
    escapeForRegex(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  };
  var MatchPattern = _MatchPattern;
  MatchPattern.PROTOCOLS = ["http", "https", "file", "ftp", "urn"];
  var InvalidMatchPattern = class extends Error {
    constructor(matchPattern, reason) {
      super(`Invalid match pattern "${matchPattern}": ${reason}`);
    }
  };
  function validateProtocol(matchPattern, protocol) {
    if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*")
      throw new InvalidMatchPattern(
        matchPattern,
        `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`
      );
  }
  function validateHostname(matchPattern, hostname) {
    if (hostname.includes(":"))
      throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
    if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*."))
      throw new InvalidMatchPattern(
        matchPattern,
        `If using a wildcard (*), it must go at the start of the hostname`
      );
  }
  function print(method, ...args) {
    if (typeof args[0] === "string") {
      const message = args.shift();
      method(`[wxt] ${message}`, ...args);
    } else {
      method("[wxt]", ...args);
    }
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args)
  };
  let ws;
  function getDevServerWebSocket() {
    if (ws == null) {
      const serverUrl = "ws://localhost:3000";
      logger.debug("Connecting to dev server @", serverUrl);
      ws = new WebSocket(serverUrl, "vite-hmr");
      ws.addWxtEventListener = ws.addEventListener.bind(ws);
      ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({ type: "custom", event, payload }));
      ws.addEventListener("open", () => {
        logger.debug("Connected to dev server");
      });
      ws.addEventListener("close", () => {
        logger.debug("Disconnected from dev server");
      });
      ws.addEventListener("error", (event) => {
        logger.error("Failed to connect to dev server", event);
      });
      ws.addEventListener("message", (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message.type === "custom") {
            ws?.dispatchEvent(
              new CustomEvent(message.event, { detail: message.data })
            );
          }
        } catch (err) {
          logger.error("Failed to handle message", err);
        }
      });
    }
    return ws;
  }
  function keepServiceWorkerAlive() {
    setInterval(async () => {
      await browser.runtime.getPlatformInfo();
    }, 5e3);
  }
  function reloadContentScript(payload) {
    const manifest = browser.runtime.getManifest();
    if (manifest.manifest_version == 2) {
      void reloadContentScriptMv2();
    } else {
      void reloadContentScriptMv3(payload);
    }
  }
  async function reloadContentScriptMv3({
    registration,
    contentScript
  }) {
    if (registration === "runtime") {
      await reloadRuntimeContentScriptMv3(contentScript);
    } else {
      await reloadManifestContentScriptMv3(contentScript);
    }
  }
  async function reloadManifestContentScriptMv3(contentScript) {
    const id = `wxt:${contentScript.js[0]}`;
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const existing = registered.find((cs) => cs.id === id);
    if (existing) {
      logger.debug("Updating content script", existing);
      await browser.scripting.updateContentScripts([
        {
          ...contentScript,
          id,
          css: contentScript.css ?? []
        }
      ]);
    } else {
      logger.debug("Registering new content script...");
      await browser.scripting.registerContentScripts([
        {
          ...contentScript,
          id,
          css: contentScript.css ?? []
        }
      ]);
    }
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadRuntimeContentScriptMv3(contentScript) {
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const matches = registered.filter((cs) => {
      const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
      const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
      return hasJs || hasCss;
    });
    if (matches.length === 0) {
      logger.log(
        "Content script is not registered yet, nothing to reload",
        contentScript
      );
      return;
    }
    await browser.scripting.updateContentScripts(matches);
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadTabsForContentScript(contentScript) {
    const allTabs = await browser.tabs.query({});
    const matchPatterns = contentScript.matches.map(
      (match) => new MatchPattern(match)
    );
    const matchingTabs = allTabs.filter((tab) => {
      const url = tab.url;
      if (!url) return false;
      return !!matchPatterns.find((pattern) => pattern.includes(url));
    });
    await Promise.all(
      matchingTabs.map(async (tab) => {
        try {
          await browser.tabs.reload(tab.id);
        } catch (err) {
          logger.warn("Failed to reload tab:", err);
        }
      })
    );
  }
  async function reloadContentScriptMv2(_payload) {
    throw Error("TODO: reloadContentScriptMv2");
  }
  {
    try {
      const ws2 = getDevServerWebSocket();
      ws2.addWxtEventListener("wxt:reload-extension", () => {
        browser.runtime.reload();
      });
      ws2.addWxtEventListener("wxt:reload-content-script", (event) => {
        reloadContentScript(event.detail);
      });
      if (true) {
        ws2.addEventListener(
          "open",
          () => ws2.sendCustom("wxt:background-initialized")
        );
        keepServiceWorkerAlive();
      }
    } catch (err) {
      logger.error("Failed to setup web socket connection with dev server", err);
    }
    browser.commands.onCommand.addListener((command) => {
      if (command === "wxt:reload-extension") {
        browser.runtime.reload();
      }
    });
  }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy8ucG5wbS9Ad3h0LWRlditicm93c2VyQDAuMS40L25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi9zcmMvbGliL21lc3NhZ2VzLnRzIiwiLi4vLi4vc3JjL2VudHJ5cG9pbnRzL2JhY2tncm91bmQudHMiLCIuLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vQHdlYmV4dC1jb3JlK21hdGNoLXBhdHRlcm5zQDEuMC4zL25vZGVfbW9kdWxlcy9Ad2ViZXh0LWNvcmUvbWF0Y2gtcGF0dGVybnMvbGliL2luZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBkZWZpbmVCYWNrZ3JvdW5kKGFyZykge1xuICBpZiAoYXJnID09IG51bGwgfHwgdHlwZW9mIGFyZyA9PT0gXCJmdW5jdGlvblwiKSByZXR1cm4geyBtYWluOiBhcmcgfTtcbiAgcmV0dXJuIGFyZztcbn1cbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgX2Jyb3dzZXIgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBfYnJvd3NlcjtcbmV4cG9ydCB7fTtcbiIsImV4cG9ydCBjb25zdCBDQUNIRV9TVE9SQUdFX0tFWSA9IFwic3MtY2FjaGUtc3RhdGVcIjtcblxuZXhwb3J0IHR5cGUgQXV0aFN0YXR1cyA9IFwic2lnbmVkX291dFwiIHwgXCJzaWduZWRfaW5cIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkID0ge1xuXHRzdWJzY3JpcHRpb25JZDogc3RyaW5nO1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0Y2hhbm5lbFRpdGxlOiBzdHJpbmc7XG5cdHN1YnNjcmliZWRBdDogc3RyaW5nO1xuXHRmZXRjaGVkQXQ6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIENhY2hlU3RhdGUgPSB7XG5cdGF1dGhTdGF0dXM6IEF1dGhTdGF0dXM7XG5cdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRsYXN0RXJyb3I/OiBzdHJpbmc7XG5cdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPjtcbn07XG5cbmV4cG9ydCB0eXBlIFB1YmxpY1N0YXRlID0ge1xuXHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRsYXN0RnVsbFN5bmNBdD86IHN0cmluZztcblx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHRzdWJzY3JpcHRpb25Db3VudDogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR2V0U3RhdHVzUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19HRVRfU1RBVFVTXCI7XG5cdGNoYW5uZWxJZDogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgUmVmcmVzaEFsbFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfUkVGUkVTSF9BTExcIjtcblx0aW50ZXJhY3RpdmU/OiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQXV0aFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfU0lHTl9JTlwiIHwgXCJTU19TSUdOX09VVFwiIHwgXCJTU19HRVRfU1RBVEVcIjtcbn07XG5cbmV4cG9ydCB0eXBlIFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI7XG59O1xuXG5leHBvcnQgdHlwZSBFeHRlbnNpb25SZXF1ZXN0ID1cblx0fCBHZXRTdGF0dXNSZXF1ZXN0XG5cdHwgUmVmcmVzaEFsbFJlcXVlc3Rcblx0fCBBdXRoUmVxdWVzdFxuXHR8IFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdDtcblxuZXhwb3J0IHR5cGUgU3RhdHVzUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0YXV0aFN0YXR1czogQXV0aFN0YXR1cztcblx0XHRcdHN1YnNjcmlwdGlvbj86IFN1YnNjcmlwdGlvblJlY29yZDtcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRcdFx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRcdFx0ZXJyb3I6IHN0cmluZztcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIFN0YXRlUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0c3RhdGU6IFB1YmxpY1N0YXRlO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRzdGF0ZTogUHVibGljU3RhdGU7XG5cdFx0XHRlcnJvcjogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIEV4dGVuc2lvblJlc3BvbnNlID0gU3RhdHVzUmVzcG9uc2UgfCBTdGF0ZVJlc3BvbnNlO1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlDYWNoZVN0YXRlKCk6IENhY2hlU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdGF1dGhTdGF0dXM6IFwic2lnbmVkX291dFwiLFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDoge30sXG5cdH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQge1xuXHRDQUNIRV9TVE9SQUdFX0tFWSxcblx0dHlwZSBDYWNoZVN0YXRlLFxuXHR0eXBlIEV4dGVuc2lvblJlcXVlc3QsXG5cdHR5cGUgRXh0ZW5zaW9uUmVzcG9uc2UsXG5cdHR5cGUgUHVibGljU3RhdGUsXG5cdHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkLFxuXHRlbXB0eUNhY2hlU3RhdGUsXG59IGZyb20gXCIuLi9saWIvbWVzc2FnZXNcIjtcblxudHlwZSBDaHJvbWVJZGVudGl0eSA9IHtcblx0aWRlbnRpdHk/OiB7XG5cdFx0Z2V0QXV0aFRva2VuOiAoXG5cdFx0XHRkZXRhaWxzOiB7IGludGVyYWN0aXZlPzogYm9vbGVhbiB9LFxuXHRcdFx0Y2FsbGJhY2s6IChyZXN1bHQ/OiBzdHJpbmcgfCB7IHRva2VuPzogc3RyaW5nIH0pID0+IHZvaWRcblx0XHQpID0+IHZvaWQ7XG5cdFx0cmVtb3ZlQ2FjaGVkQXV0aFRva2VuPzogKFxuXHRcdFx0ZGV0YWlsczogeyB0b2tlbjogc3RyaW5nIH0sXG5cdFx0XHRjYWxsYmFjaz86ICgpID0+IHZvaWRcblx0XHQpID0+IHZvaWQ7XG5cdFx0Y2xlYXJBbGxDYWNoZWRBdXRoVG9rZW5zPzogKGNhbGxiYWNrPzogKCkgPT4gdm9pZCkgPT4gdm9pZDtcblx0fTtcblx0cnVudGltZT86IHtcblx0XHRsYXN0RXJyb3I/OiB7IG1lc3NhZ2U/OiBzdHJpbmcgfTtcblx0fTtcbn07XG5cbnR5cGUgWW91VHViZVN1YnNjcmlwdGlvbkxpc3RSZXNwb25zZSA9IHtcblx0bmV4dFBhZ2VUb2tlbj86IHN0cmluZztcblx0aXRlbXM/OiBBcnJheTx7XG5cdFx0aWQ/OiBzdHJpbmc7XG5cdFx0c25pcHBldD86IHtcblx0XHRcdHB1Ymxpc2hlZEF0Pzogc3RyaW5nO1xuXHRcdFx0dGl0bGU/OiBzdHJpbmc7XG5cdFx0XHRyZXNvdXJjZUlkPzoge1xuXHRcdFx0XHRjaGFubmVsSWQ/OiBzdHJpbmc7XG5cdFx0XHR9O1xuXHRcdH07XG5cdH0+O1xufTtcblxuY29uc3QgUkVGUkVTSF9BTEFSTSA9IFwic3MtcmVmcmVzaC1zdWJzY3JpcHRpb25zXCI7XG5jb25zdCBSRUZSRVNIX1BFUklPRF9NSU5VVEVTID0gNiAqIDYwO1xuY29uc3QgWU9VVFVCRV9TVUJTQ1JJUFRJT05TX1VSTCA9XG5cdFwiaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20veW91dHViZS92My9zdWJzY3JpcHRpb25zXCI7XG5cbmxldCByZWZyZXNoUHJvbWlzZTogUHJvbWlzZTxDYWNoZVN0YXRlPiB8IHVuZGVmaW5lZDtcbmxldCB2aXNpYmxlQ2hhbmdlUmVmcmVzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG5cdGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG5cdFx0dm9pZCBlbnN1cmVSZWZyZXNoQWxhcm0oKTtcblx0fSk7XG5cblx0YnJvd3Nlci5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiB7XG5cdFx0dm9pZCBlbnN1cmVSZWZyZXNoQWxhcm0oKTtcblx0fSk7XG5cblx0YnJvd3Nlci5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcigoYWxhcm0pID0+IHtcblx0XHRpZiAoYWxhcm0ubmFtZSA9PT0gUkVGUkVTSF9BTEFSTSkge1xuXHRcdFx0dm9pZCByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhmYWxzZSk7XG5cdFx0fVxuXHR9KTtcblxuXHRicm93c2VyLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKFxuXHRcdChtZXNzYWdlOiBFeHRlbnNpb25SZXF1ZXN0KTogUHJvbWlzZTxFeHRlbnNpb25SZXNwb25zZT4gPT4ge1xuXHRcdFx0cmV0dXJuIGhhbmRsZU1lc3NhZ2UobWVzc2FnZSk7XG5cdFx0fVxuXHQpO1xufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU1lc3NhZ2UoXG5cdG1lc3NhZ2U6IEV4dGVuc2lvblJlcXVlc3Rcbik6IFByb21pc2U8RXh0ZW5zaW9uUmVzcG9uc2U+IHtcblx0dHJ5IHtcblx0XHRzd2l0Y2ggKG1lc3NhZ2UudHlwZSkge1xuXHRcdFx0Y2FzZSBcIlNTX1NJR05fSU5cIjoge1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IHJlZnJlc2hBbGxTdWJzY3JpcHRpb25zKHRydWUpO1xuXHRcdFx0XHRyZXR1cm4geyBvazogdHJ1ZSwgc3RhdGU6IHRvUHVibGljU3RhdGUoc3RhdGUpIH07XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwiU1NfU0lHTl9PVVRcIjoge1xuXHRcdFx0XHRhd2FpdCBzaWduT3V0KCk7XG5cdFx0XHRcdGNvbnN0IHN0YXRlID0gYXdhaXQgc2F2ZVN0YXRlKGVtcHR5Q2FjaGVTdGF0ZSgpKTtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSB9O1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcIlNTX0dFVF9TVEFURVwiOiB7XG5cdFx0XHRcdGNvbnN0IHN0YXRlID0gYXdhaXQgZ2V0U3RhdGUoKTtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSB9O1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcIlNTX1JFRlJFU0hfQUxMXCI6IHtcblx0XHRcdFx0Y29uc3Qgc3RhdGUgPSBhd2FpdCByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhCb29sZWFuKG1lc3NhZ2UuaW50ZXJhY3RpdmUpKTtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSB9O1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcIlNTX0dFVF9TVEFUVVNcIjoge1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGdldEZyZXNoRW5vdWdoU3RhdGUobWVzc2FnZS5jaGFubmVsSWQpO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdG9rOiB0cnVlLFxuXHRcdFx0XHRcdGF1dGhTdGF0dXM6IHN0YXRlLmF1dGhTdGF0dXMsXG5cdFx0XHRcdFx0c3Vic2NyaXB0aW9uOiBzdGF0ZS5zdWJzY3JpcHRpb25zQnlDaGFubmVsSWRbbWVzc2FnZS5jaGFubmVsSWRdLFxuXHRcdFx0XHRcdGxhc3RGdWxsU3luY0F0OiBzdGF0ZS5sYXN0RnVsbFN5bmNBdCxcblx0XHRcdFx0XHRsYXN0RXJyb3I6IHN0YXRlLmxhc3RFcnJvcixcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI6IHtcblx0XHRcdFx0c2NoZWR1bGVWaXNpYmxlQ2hhbmdlUmVmcmVzaCgpO1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGdldFN0YXRlKCk7XG5cdFx0XHRcdHJldHVybiB7IG9rOiB0cnVlLCBzdGF0ZTogdG9QdWJsaWNTdGF0ZShzdGF0ZSkgfTtcblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0Y29uc3Qgc3RhdGUgPSBhd2FpdCBzZXRFcnJvcihlcnJvcik7XG5cdFx0cmV0dXJuIHtcblx0XHRcdG9rOiBmYWxzZSxcblx0XHRcdHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSxcblx0XHRcdGVycm9yOiBnZXRFcnJvck1lc3NhZ2UoZXJyb3IpLFxuXHRcdH07XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlUmVmcmVzaEFsYXJtKCkge1xuXHRhd2FpdCBicm93c2VyLmFsYXJtcy5jcmVhdGUoUkVGUkVTSF9BTEFSTSwge1xuXHRcdHBlcmlvZEluTWludXRlczogUkVGUkVTSF9QRVJJT0RfTUlOVVRFUyxcblx0fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEZyZXNoRW5vdWdoU3RhdGUoY2hhbm5lbElkOiBzdHJpbmcpIHtcblx0Y29uc3Qgc3RhdGUgPSBhd2FpdCBnZXRTdGF0ZSgpO1xuXHRpZiAoc3RhdGUuYXV0aFN0YXR1cyAhPT0gXCJzaWduZWRfaW5cIikge1xuXHRcdHJldHVybiBzdGF0ZTtcblx0fVxuXG5cdGlmICghc3RhdGUubGFzdEZ1bGxTeW5jQXQpIHtcblx0XHRyZXR1cm4gcmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoZmFsc2UpO1xuXHR9XG5cblx0Y29uc3QgbGFzdFN5bmMgPSBuZXcgRGF0ZShzdGF0ZS5sYXN0RnVsbFN5bmNBdCkuZ2V0VGltZSgpO1xuXHRjb25zdCBpc1N0YWxlID0gTnVtYmVyLmlzTmFOKGxhc3RTeW5jKVxuXHRcdD8gdHJ1ZVxuXHRcdDogRGF0ZS5ub3coKSAtIGxhc3RTeW5jID4gUkVGUkVTSF9QRVJJT0RfTUlOVVRFUyAqIDYwICogMTAwMDtcblxuXHRpZiAoIWlzU3RhbGUgfHwgc3RhdGUuc3Vic2NyaXB0aW9uc0J5Q2hhbm5lbElkW2NoYW5uZWxJZF0pIHtcblx0XHRyZXR1cm4gc3RhdGU7XG5cdH1cblxuXHRyZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhmYWxzZSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcblx0cmV0dXJuIHN0YXRlO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhpbnRlcmFjdGl2ZTogYm9vbGVhbikge1xuXHRpZiAocmVmcmVzaFByb21pc2UpIHtcblx0XHRyZXR1cm4gcmVmcmVzaFByb21pc2U7XG5cdH1cblxuXHRyZWZyZXNoUHJvbWlzZSA9IGRvUmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoaW50ZXJhY3RpdmUpLmZpbmFsbHkoKCkgPT4ge1xuXHRcdHJlZnJlc2hQcm9taXNlID0gdW5kZWZpbmVkO1xuXHR9KTtcblxuXHRyZXR1cm4gcmVmcmVzaFByb21pc2U7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRvUmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoaW50ZXJhY3RpdmU6IGJvb2xlYW4pIHtcblx0Y29uc3QgdG9rZW4gPSBhd2FpdCBnZXRBdXRoVG9rZW4oaW50ZXJhY3RpdmUpO1xuXHRjb25zdCBmZXRjaGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdGNvbnN0IHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPiA9IHt9O1xuXG5cdGF3YWl0IGNvbGxlY3RTdWJzY3JpcHRpb25QYWdlcyh7XG5cdFx0dG9rZW4sXG5cdFx0ZmV0Y2hlZEF0LFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZCxcblx0fSk7XG5cblx0cmV0dXJuIHNhdmVTdGF0ZSh7XG5cdFx0YXV0aFN0YXR1czogXCJzaWduZWRfaW5cIixcblx0XHRsYXN0RnVsbFN5bmNBdDogZmV0Y2hlZEF0LFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZCxcblx0fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RTdWJzY3JpcHRpb25QYWdlcyh7XG5cdHRva2VuLFxuXHRmZXRjaGVkQXQsXG5cdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZCxcblx0cGFnZVRva2VuLFxufToge1xuXHR0b2tlbjogc3RyaW5nO1xuXHRmZXRjaGVkQXQ6IHN0cmluZztcblx0c3Vic2NyaXB0aW9uc0J5Q2hhbm5lbElkOiBSZWNvcmQ8c3RyaW5nLCBTdWJzY3JpcHRpb25SZWNvcmQ+O1xuXHRwYWdlVG9rZW4/OiBzdHJpbmc7XG59KTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IHVybCA9IG5ldyBVUkwoWU9VVFVCRV9TVUJTQ1JJUFRJT05TX1VSTCk7XG5cdGNvbnN0IHNldFNlYXJjaFBhcmFtID0gdXJsLnNlYXJjaFBhcmFtcy5zZXQuYmluZCh1cmwuc2VhcmNoUGFyYW1zKTtcblx0c2V0U2VhcmNoUGFyYW0oXCJwYXJ0XCIsIFwic25pcHBldFwiKTtcblx0c2V0U2VhcmNoUGFyYW0oXCJtaW5lXCIsIFwidHJ1ZVwiKTtcblx0c2V0U2VhcmNoUGFyYW0oXCJtYXhSZXN1bHRzXCIsIFwiNTBcIik7XG5cdGlmIChwYWdlVG9rZW4pIHtcblx0XHRzZXRTZWFyY2hQYXJhbShcInBhZ2VUb2tlblwiLCBwYWdlVG9rZW4pO1xuXHR9XG5cblx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwudG9TdHJpbmcoKSwge1xuXHRcdGhlYWRlcnM6IHtcblx0XHRcdEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0b2tlbn1gLFxuXHRcdH0sXG5cdH0pO1xuXG5cdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuXHRcdGF3YWl0IHJlbW92ZUNhY2hlZFRva2VuKHRva2VuKTtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJHb29nbGUgYXV0aG9yaXphdGlvbiBleHBpcmVkLiBQbGVhc2Ugc2lnbiBpbiBhZ2Fpbi5cIik7XG5cdH1cblxuXHRpZiAoIXJlc3BvbnNlLm9rKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBZb3VUdWJlIEFQSSByZXF1ZXN0IGZhaWxlZCAoJHtyZXNwb25zZS5zdGF0dXN9KS5gKTtcblx0fVxuXG5cdGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyBZb3VUdWJlU3Vic2NyaXB0aW9uTGlzdFJlc3BvbnNlO1xuXHRmb3IgKGNvbnN0IGl0ZW0gb2YgZGF0YS5pdGVtcyA/PyBbXSkge1xuXHRcdGNvbnN0IGNoYW5uZWxJZCA9IGl0ZW0uc25pcHBldD8ucmVzb3VyY2VJZD8uY2hhbm5lbElkO1xuXHRcdGNvbnN0IHN1YnNjcmliZWRBdCA9IGl0ZW0uc25pcHBldD8ucHVibGlzaGVkQXQ7XG5cdFx0aWYgKCFjaGFubmVsSWQgfHwgIXN1YnNjcmliZWRBdCkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0c3Vic2NyaXB0aW9uc0J5Q2hhbm5lbElkW2NoYW5uZWxJZF0gPSB7XG5cdFx0XHRzdWJzY3JpcHRpb25JZDogaXRlbS5pZCA/PyBjaGFubmVsSWQsXG5cdFx0XHRjaGFubmVsSWQsXG5cdFx0XHRjaGFubmVsVGl0bGU6IGl0ZW0uc25pcHBldD8udGl0bGUgPz8gXCJZb3VUdWJlIGNoYW5uZWxcIixcblx0XHRcdHN1YnNjcmliZWRBdCxcblx0XHRcdGZldGNoZWRBdCxcblx0XHR9O1xuXHR9XG5cblx0aWYgKGRhdGEubmV4dFBhZ2VUb2tlbikge1xuXHRcdGF3YWl0IGNvbGxlY3RTdWJzY3JpcHRpb25QYWdlcyh7XG5cdFx0XHR0b2tlbixcblx0XHRcdGZldGNoZWRBdCxcblx0XHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZCxcblx0XHRcdHBhZ2VUb2tlbjogZGF0YS5uZXh0UGFnZVRva2VuLFxuXHRcdH0pO1xuXHR9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFN0YXRlKCk6IFByb21pc2U8Q2FjaGVTdGF0ZT4ge1xuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuZ2V0KENBQ0hFX1NUT1JBR0VfS0VZKTtcblx0cmV0dXJuIHtcblx0XHQuLi5lbXB0eUNhY2hlU3RhdGUoKSxcblx0XHQuLi4ocmVzdWx0W0NBQ0hFX1NUT1JBR0VfS0VZXSBhcyBQYXJ0aWFsPENhY2hlU3RhdGU+IHwgdW5kZWZpbmVkKSxcblx0fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2F2ZVN0YXRlKHN0YXRlOiBDYWNoZVN0YXRlKTogUHJvbWlzZTxDYWNoZVN0YXRlPiB7XG5cdGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoeyBbQ0FDSEVfU1RPUkFHRV9LRVldOiBzdGF0ZSB9KTtcblx0cmV0dXJuIHN0YXRlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzZXRFcnJvcihlcnJvcjogdW5rbm93bik6IFByb21pc2U8Q2FjaGVTdGF0ZT4ge1xuXHRjb25zdCBzdGF0ZSA9IGF3YWl0IGdldFN0YXRlKCk7XG5cdHJldHVybiBzYXZlU3RhdGUoe1xuXHRcdC4uLnN0YXRlLFxuXHRcdGF1dGhTdGF0dXM6IHN0YXRlLmF1dGhTdGF0dXMgPT09IFwic2lnbmVkX2luXCIgPyBcImVycm9yXCIgOiBcInNpZ25lZF9vdXRcIixcblx0XHRsYXN0RXJyb3I6IGdldEVycm9yTWVzc2FnZShlcnJvciksXG5cdH0pO1xufVxuXG5mdW5jdGlvbiB0b1B1YmxpY1N0YXRlKHN0YXRlOiBDYWNoZVN0YXRlKTogUHVibGljU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdGF1dGhTdGF0dXM6IHN0YXRlLmF1dGhTdGF0dXMsXG5cdFx0bGFzdEZ1bGxTeW5jQXQ6IHN0YXRlLmxhc3RGdWxsU3luY0F0LFxuXHRcdGxhc3RFcnJvcjogc3RhdGUubGFzdEVycm9yLFxuXHRcdHN1YnNjcmlwdGlvbkNvdW50OiBPYmplY3Qua2V5cyhzdGF0ZS5zdWJzY3JpcHRpb25zQnlDaGFubmVsSWQpLmxlbmd0aCxcblx0fTtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVWaXNpYmxlQ2hhbmdlUmVmcmVzaCgpIHtcblx0aWYgKHZpc2libGVDaGFuZ2VSZWZyZXNoVGltZXIpIHtcblx0XHRjbGVhclRpbWVvdXQodmlzaWJsZUNoYW5nZVJlZnJlc2hUaW1lcik7XG5cdH1cblxuXHR2aXNpYmxlQ2hhbmdlUmVmcmVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0dm9pZCByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhmYWxzZSk7XG5cdH0sIDMwMDApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzaWduT3V0KCkge1xuXHRjb25zdCB0b2tlbiA9IGF3YWl0IGdldEF1dGhUb2tlbihmYWxzZSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcblx0aWYgKHRva2VuKSB7XG5cdFx0YXdhaXQgcmVtb3ZlQ2FjaGVkVG9rZW4odG9rZW4pO1xuXHR9XG5cblx0Y29uc3QgY2hyb21lQXBpID0gZ2V0Q2hyb21lQXBpKCk7XG5cdGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0Y2hyb21lQXBpLmlkZW50aXR5Py5jbGVhckFsbENhY2hlZEF1dGhUb2tlbnM/LigoKSA9PiByZXNvbHZlKCkpO1xuXHRcdGlmICghY2hyb21lQXBpLmlkZW50aXR5Py5jbGVhckFsbENhY2hlZEF1dGhUb2tlbnMpIHtcblx0XHRcdHJlc29sdmUoKTtcblx0XHR9XG5cdH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRBdXRoVG9rZW4oaW50ZXJhY3RpdmU6IGJvb2xlYW4pOiBQcm9taXNlPHN0cmluZz4ge1xuXHRjb25zdCBjaHJvbWVBcGkgPSBnZXRDaHJvbWVBcGkoKTtcblx0aWYgKCFjaHJvbWVBcGkuaWRlbnRpdHk/LmdldEF1dGhUb2tlbikge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIkNocm9tZSBpZGVudGl0eSBBUEkgaXMgdW5hdmFpbGFibGUuXCIpO1xuXHR9XG5cblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRjaHJvbWVBcGkuaWRlbnRpdHk/LmdldEF1dGhUb2tlbih7IGludGVyYWN0aXZlIH0sIChyZXN1bHQpID0+IHtcblx0XHRcdGNvbnN0IHJ1bnRpbWVFcnJvciA9IGNocm9tZUFwaS5ydW50aW1lPy5sYXN0RXJyb3I/Lm1lc3NhZ2U7XG5cdFx0XHRpZiAocnVudGltZUVycm9yKSB7XG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IocnVudGltZUVycm9yKSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgdG9rZW4gPSB0eXBlb2YgcmVzdWx0ID09PSBcInN0cmluZ1wiID8gcmVzdWx0IDogcmVzdWx0Py50b2tlbjtcblx0XHRcdGlmICghdG9rZW4pIHtcblx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk5vIEdvb2dsZSBhdXRoIHRva2VuIHdhcyByZXR1cm5lZC5cIikpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdHJlc29sdmUodG9rZW4pO1xuXHRcdH0pO1xuXHR9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlQ2FjaGVkVG9rZW4odG9rZW46IHN0cmluZykge1xuXHRjb25zdCBjaHJvbWVBcGkgPSBnZXRDaHJvbWVBcGkoKTtcblx0YXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRjaHJvbWVBcGkuaWRlbnRpdHk/LnJlbW92ZUNhY2hlZEF1dGhUb2tlbj8uKHsgdG9rZW4gfSwgKCkgPT4gcmVzb2x2ZSgpKTtcblx0XHRpZiAoIWNocm9tZUFwaS5pZGVudGl0eT8ucmVtb3ZlQ2FjaGVkQXV0aFRva2VuKSB7XG5cdFx0XHRyZXNvbHZlKCk7XG5cdFx0fVxuXHR9KTtcbn1cblxuZnVuY3Rpb24gZ2V0Q2hyb21lQXBpKCk6IENocm9tZUlkZW50aXR5IHtcblx0cmV0dXJuIChnbG9iYWxUaGlzIGFzIHVua25vd24gYXMgeyBjaHJvbWU/OiBDaHJvbWVJZGVudGl0eSB9KS5jaHJvbWUgPz8ge307XG59XG5cbmZ1bmN0aW9uIGdldEVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93bikge1xuXHRpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdHJldHVybiBlcnJvci5tZXNzYWdlO1xuXHR9XG5cblx0cmV0dXJuIFN0cmluZyhlcnJvcik7XG59XG4iLCIvLyBzcmMvaW5kZXgudHNcbnZhciBfTWF0Y2hQYXR0ZXJuID0gY2xhc3Mge1xuICBjb25zdHJ1Y3RvcihtYXRjaFBhdHRlcm4pIHtcbiAgICBpZiAobWF0Y2hQYXR0ZXJuID09PSBcIjxhbGxfdXJscz5cIikge1xuICAgICAgdGhpcy5pc0FsbFVybHMgPSB0cnVlO1xuICAgICAgdGhpcy5wcm90b2NvbE1hdGNoZXMgPSBbLi4uX01hdGNoUGF0dGVybi5QUk9UT0NPTFNdO1xuICAgICAgdGhpcy5ob3N0bmFtZU1hdGNoID0gXCIqXCI7XG4gICAgICB0aGlzLnBhdGhuYW1lTWF0Y2ggPSBcIipcIjtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgZ3JvdXBzID0gLyguKik6XFwvXFwvKC4qPykoXFwvLiopLy5leGVjKG1hdGNoUGF0dGVybik7XG4gICAgICBpZiAoZ3JvdXBzID09IG51bGwpXG4gICAgICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgXCJJbmNvcnJlY3QgZm9ybWF0XCIpO1xuICAgICAgY29uc3QgW18sIHByb3RvY29sLCBob3N0bmFtZSwgcGF0aG5hbWVdID0gZ3JvdXBzO1xuICAgICAgdmFsaWRhdGVQcm90b2NvbChtYXRjaFBhdHRlcm4sIHByb3RvY29sKTtcbiAgICAgIHZhbGlkYXRlSG9zdG5hbWUobWF0Y2hQYXR0ZXJuLCBob3N0bmFtZSk7XG4gICAgICB2YWxpZGF0ZVBhdGhuYW1lKG1hdGNoUGF0dGVybiwgcGF0aG5hbWUpO1xuICAgICAgdGhpcy5wcm90b2NvbE1hdGNoZXMgPSBwcm90b2NvbCA9PT0gXCIqXCIgPyBbXCJodHRwXCIsIFwiaHR0cHNcIl0gOiBbcHJvdG9jb2xdO1xuICAgICAgdGhpcy5ob3N0bmFtZU1hdGNoID0gaG9zdG5hbWU7XG4gICAgICB0aGlzLnBhdGhuYW1lTWF0Y2ggPSBwYXRobmFtZTtcbiAgICB9XG4gIH1cbiAgaW5jbHVkZXModXJsKSB7XG4gICAgaWYgKHRoaXMuaXNBbGxVcmxzKVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgdSA9IHR5cGVvZiB1cmwgPT09IFwic3RyaW5nXCIgPyBuZXcgVVJMKHVybCkgOiB1cmwgaW5zdGFuY2VvZiBMb2NhdGlvbiA/IG5ldyBVUkwodXJsLmhyZWYpIDogdXJsO1xuICAgIHJldHVybiAhIXRoaXMucHJvdG9jb2xNYXRjaGVzLmZpbmQoKHByb3RvY29sKSA9PiB7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiaHR0cFwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0h0dHBNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJodHRwc1wiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0h0dHBzTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiZmlsZVwiKVxuICAgICAgICByZXR1cm4gdGhpcy5pc0ZpbGVNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJmdHBcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNGdHBNYXRjaCh1KTtcbiAgICAgIGlmIChwcm90b2NvbCA9PT0gXCJ1cm5cIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNVcm5NYXRjaCh1KTtcbiAgICB9KTtcbiAgfVxuICBpc0h0dHBNYXRjaCh1cmwpIHtcbiAgICByZXR1cm4gdXJsLnByb3RvY29sID09PSBcImh0dHA6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcbiAgfVxuICBpc0h0dHBzTWF0Y2godXJsKSB7XG4gICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwczpcIiAmJiB0aGlzLmlzSG9zdFBhdGhNYXRjaCh1cmwpO1xuICB9XG4gIGlzSG9zdFBhdGhNYXRjaCh1cmwpIHtcbiAgICBpZiAoIXRoaXMuaG9zdG5hbWVNYXRjaCB8fCAhdGhpcy5wYXRobmFtZU1hdGNoKVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGhvc3RuYW1lTWF0Y2hSZWdleHMgPSBbXG4gICAgICB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLmhvc3RuYW1lTWF0Y2gpLFxuICAgICAgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoLnJlcGxhY2UoL15cXCpcXC4vLCBcIlwiKSlcbiAgICBdO1xuICAgIGNvbnN0IHBhdGhuYW1lTWF0Y2hSZWdleCA9IHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMucGF0aG5hbWVNYXRjaCk7XG4gICAgcmV0dXJuICEhaG9zdG5hbWVNYXRjaFJlZ2V4cy5maW5kKChyZWdleCkgPT4gcmVnZXgudGVzdCh1cmwuaG9zdG5hbWUpKSAmJiBwYXRobmFtZU1hdGNoUmVnZXgudGVzdCh1cmwucGF0aG5hbWUpO1xuICB9XG4gIGlzRmlsZU1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiBmaWxlOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBpc0Z0cE1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiBmdHA6Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGlzVXJuTWF0Y2godXJsKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IHVybjovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgY29udmVydFBhdHRlcm5Ub1JlZ2V4KHBhdHRlcm4pIHtcbiAgICBjb25zdCBlc2NhcGVkID0gdGhpcy5lc2NhcGVGb3JSZWdleChwYXR0ZXJuKTtcbiAgICBjb25zdCBzdGFyc1JlcGxhY2VkID0gZXNjYXBlZC5yZXBsYWNlKC9cXFxcXFwqL2csIFwiLipcIik7XG4gICAgcmV0dXJuIFJlZ0V4cChgXiR7c3RhcnNSZXBsYWNlZH0kYCk7XG4gIH1cbiAgZXNjYXBlRm9yUmVnZXgoc3RyaW5nKSB7XG4gICAgcmV0dXJuIHN0cmluZy5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG4gIH1cbn07XG52YXIgTWF0Y2hQYXR0ZXJuID0gX01hdGNoUGF0dGVybjtcbk1hdGNoUGF0dGVybi5QUk9UT0NPTFMgPSBbXCJodHRwXCIsIFwiaHR0cHNcIiwgXCJmaWxlXCIsIFwiZnRwXCIsIFwidXJuXCJdO1xudmFyIEludmFsaWRNYXRjaFBhdHRlcm4gPSBjbGFzcyBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuLCByZWFzb24pIHtcbiAgICBzdXBlcihgSW52YWxpZCBtYXRjaCBwYXR0ZXJuIFwiJHttYXRjaFBhdHRlcm59XCI6ICR7cmVhc29ufWApO1xuICB9XG59O1xuZnVuY3Rpb24gdmFsaWRhdGVQcm90b2NvbChtYXRjaFBhdHRlcm4sIHByb3RvY29sKSB7XG4gIGlmICghTWF0Y2hQYXR0ZXJuLlBST1RPQ09MUy5pbmNsdWRlcyhwcm90b2NvbCkgJiYgcHJvdG9jb2wgIT09IFwiKlwiKVxuICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKFxuICAgICAgbWF0Y2hQYXR0ZXJuLFxuICAgICAgYCR7cHJvdG9jb2x9IG5vdCBhIHZhbGlkIHByb3RvY29sICgke01hdGNoUGF0dGVybi5QUk9UT0NPTFMuam9pbihcIiwgXCIpfSlgXG4gICAgKTtcbn1cbmZ1bmN0aW9uIHZhbGlkYXRlSG9zdG5hbWUobWF0Y2hQYXR0ZXJuLCBob3N0bmFtZSkge1xuICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoXCI6XCIpKVxuICAgIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgYEhvc3RuYW1lIGNhbm5vdCBpbmNsdWRlIGEgcG9ydGApO1xuICBpZiAoaG9zdG5hbWUuaW5jbHVkZXMoXCIqXCIpICYmIGhvc3RuYW1lLmxlbmd0aCA+IDEgJiYgIWhvc3RuYW1lLnN0YXJ0c1dpdGgoXCIqLlwiKSlcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihcbiAgICAgIG1hdGNoUGF0dGVybixcbiAgICAgIGBJZiB1c2luZyBhIHdpbGRjYXJkICgqKSwgaXQgbXVzdCBnbyBhdCB0aGUgc3RhcnQgb2YgdGhlIGhvc3RuYW1lYFxuICAgICk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZVBhdGhuYW1lKG1hdGNoUGF0dGVybiwgcGF0aG5hbWUpIHtcbiAgcmV0dXJuO1xufVxuZXhwb3J0IHtcbiAgSW52YWxpZE1hdGNoUGF0dGVybixcbiAgTWF0Y2hQYXR0ZXJuXG59O1xuIl0sIm5hbWVzIjpbImJyb3dzZXIiLCJfYnJvd3NlciIsInJlc3VsdCJdLCJtYXBwaW5ncyI6Ijs7QUFBTyxXQUFTLGlCQUFpQixLQUFLO0FBQ3BDLFFB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QUFJLENBQUMsYUFBYSxVQUFVLFNBQVMsUUFBUSxLQUFLLGFBQWE7QUFDN0QsWUFBTSxJQUFJO0FBQUEsUUFDUjtBQUFBLFFBQ0EsR0FBRyxRQUFRLDBCQUEwQixhQUFhLFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxNQUM1RTtBQUFBLEVBQ0E7QUFDQSxXQUFTLGlCQUFpQixjQUFjLFVBQVU7QUFDaEQsUUFBSSxTQUFTLFNBQVMsR0FBRztBQUN2QixZQUFNLElBQUksb0JBQW9CLGNBQWMsZ0NBQWdDO0FBQzlFLFFBQUksU0FBUyxTQUFTLEdBQUcsS0FBSyxTQUFTLFNBQVMsS0FBSyxDQUFDLFNBQVMsV0FBVyxJQUFJO0FBQzVFLFlBQU0sSUFBSTtBQUFBLFFBQ1I7QUFBQSxRQUNBO0FBQUEsTUFDTjtBQUFBLEVBQ0E7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OzsiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMCwxLDIsNV19
