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
    let pageToken;
    do {
      const url = new URL(YOUTUBE_SUBSCRIPTIONS_URL);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("mine", "true");
      url.searchParams.set("maxResults", "50");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
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
      pageToken = data.nextPageToken;
    } while (pageToken);
    return saveState({
      authStatus: "signed_in",
      lastFullSyncAt: fetchedAt,
      subscriptionsByChannelId
    });
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy8ucG5wbS9Ad3h0LWRlditicm93c2VyQDAuMS40L25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi9zcmMvbGliL21lc3NhZ2VzLnRzIiwiLi4vLi4vc3JjL2VudHJ5cG9pbnRzL2JhY2tncm91bmQudHMiLCIuLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vQHdlYmV4dC1jb3JlK21hdGNoLXBhdHRlcm5zQDEuMC4zL25vZGVfbW9kdWxlcy9Ad2ViZXh0LWNvcmUvbWF0Y2gtcGF0dGVybnMvbGliL2luZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBkZWZpbmVCYWNrZ3JvdW5kKGFyZykge1xuICBpZiAoYXJnID09IG51bGwgfHwgdHlwZW9mIGFyZyA9PT0gXCJmdW5jdGlvblwiKSByZXR1cm4geyBtYWluOiBhcmcgfTtcbiAgcmV0dXJuIGFyZztcbn1cbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgX2Jyb3dzZXIgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBfYnJvd3NlcjtcbmV4cG9ydCB7fTtcbiIsImV4cG9ydCBjb25zdCBDQUNIRV9TVE9SQUdFX0tFWSA9IFwic3MtY2FjaGUtc3RhdGVcIjtcblxuZXhwb3J0IHR5cGUgQXV0aFN0YXR1cyA9IFwic2lnbmVkX291dFwiIHwgXCJzaWduZWRfaW5cIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkID0ge1xuXHRzdWJzY3JpcHRpb25JZDogc3RyaW5nO1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0Y2hhbm5lbFRpdGxlOiBzdHJpbmc7XG5cdHN1YnNjcmliZWRBdDogc3RyaW5nO1xuXHRmZXRjaGVkQXQ6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIENhY2hlU3RhdGUgPSB7XG5cdGF1dGhTdGF0dXM6IEF1dGhTdGF0dXM7XG5cdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRsYXN0RXJyb3I/OiBzdHJpbmc7XG5cdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPjtcbn07XG5cbmV4cG9ydCB0eXBlIFB1YmxpY1N0YXRlID0ge1xuXHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRsYXN0RnVsbFN5bmNBdD86IHN0cmluZztcblx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHRzdWJzY3JpcHRpb25Db3VudDogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR2V0U3RhdHVzUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19HRVRfU1RBVFVTXCI7XG5cdGNoYW5uZWxJZDogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgUmVmcmVzaEFsbFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfUkVGUkVTSF9BTExcIjtcblx0aW50ZXJhY3RpdmU/OiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQXV0aFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfU0lHTl9JTlwiIHwgXCJTU19TSUdOX09VVFwiIHwgXCJTU19HRVRfU1RBVEVcIjtcbn07XG5cbmV4cG9ydCB0eXBlIFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI7XG59O1xuXG5leHBvcnQgdHlwZSBFeHRlbnNpb25SZXF1ZXN0ID1cblx0fCBHZXRTdGF0dXNSZXF1ZXN0XG5cdHwgUmVmcmVzaEFsbFJlcXVlc3Rcblx0fCBBdXRoUmVxdWVzdFxuXHR8IFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdDtcblxuZXhwb3J0IHR5cGUgU3RhdHVzUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0YXV0aFN0YXR1czogQXV0aFN0YXR1cztcblx0XHRcdHN1YnNjcmlwdGlvbj86IFN1YnNjcmlwdGlvblJlY29yZDtcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRcdFx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRcdFx0ZXJyb3I6IHN0cmluZztcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIFN0YXRlUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0c3RhdGU6IFB1YmxpY1N0YXRlO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRzdGF0ZTogUHVibGljU3RhdGU7XG5cdFx0XHRlcnJvcjogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIEV4dGVuc2lvblJlc3BvbnNlID0gU3RhdHVzUmVzcG9uc2UgfCBTdGF0ZVJlc3BvbnNlO1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlDYWNoZVN0YXRlKCk6IENhY2hlU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdGF1dGhTdGF0dXM6IFwic2lnbmVkX291dFwiLFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDoge30sXG5cdH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQge1xuXHRDQUNIRV9TVE9SQUdFX0tFWSxcblx0dHlwZSBDYWNoZVN0YXRlLFxuXHR0eXBlIEV4dGVuc2lvblJlcXVlc3QsXG5cdHR5cGUgRXh0ZW5zaW9uUmVzcG9uc2UsXG5cdHR5cGUgUHVibGljU3RhdGUsXG5cdHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkLFxuXHRlbXB0eUNhY2hlU3RhdGUsXG59IGZyb20gXCIuLi9saWIvbWVzc2FnZXNcIjtcblxudHlwZSBDaHJvbWVJZGVudGl0eSA9IHtcblx0aWRlbnRpdHk/OiB7XG5cdFx0Z2V0QXV0aFRva2VuOiAoXG5cdFx0XHRkZXRhaWxzOiB7IGludGVyYWN0aXZlPzogYm9vbGVhbiB9LFxuXHRcdFx0Y2FsbGJhY2s6IChyZXN1bHQ/OiBzdHJpbmcgfCB7IHRva2VuPzogc3RyaW5nIH0pID0+IHZvaWRcblx0XHQpID0+IHZvaWQ7XG5cdFx0cmVtb3ZlQ2FjaGVkQXV0aFRva2VuPzogKFxuXHRcdFx0ZGV0YWlsczogeyB0b2tlbjogc3RyaW5nIH0sXG5cdFx0XHRjYWxsYmFjaz86ICgpID0+IHZvaWRcblx0XHQpID0+IHZvaWQ7XG5cdFx0Y2xlYXJBbGxDYWNoZWRBdXRoVG9rZW5zPzogKGNhbGxiYWNrPzogKCkgPT4gdm9pZCkgPT4gdm9pZDtcblx0fTtcblx0cnVudGltZT86IHtcblx0XHRsYXN0RXJyb3I/OiB7IG1lc3NhZ2U/OiBzdHJpbmcgfTtcblx0fTtcbn07XG5cbnR5cGUgWW91VHViZVN1YnNjcmlwdGlvbkxpc3RSZXNwb25zZSA9IHtcblx0bmV4dFBhZ2VUb2tlbj86IHN0cmluZztcblx0aXRlbXM/OiBBcnJheTx7XG5cdFx0aWQ/OiBzdHJpbmc7XG5cdFx0c25pcHBldD86IHtcblx0XHRcdHB1Ymxpc2hlZEF0Pzogc3RyaW5nO1xuXHRcdFx0dGl0bGU/OiBzdHJpbmc7XG5cdFx0XHRyZXNvdXJjZUlkPzoge1xuXHRcdFx0XHRjaGFubmVsSWQ/OiBzdHJpbmc7XG5cdFx0XHR9O1xuXHRcdH07XG5cdH0+O1xufTtcblxuY29uc3QgUkVGUkVTSF9BTEFSTSA9IFwic3MtcmVmcmVzaC1zdWJzY3JpcHRpb25zXCI7XG5jb25zdCBSRUZSRVNIX1BFUklPRF9NSU5VVEVTID0gNiAqIDYwO1xuY29uc3QgWU9VVFVCRV9TVUJTQ1JJUFRJT05TX1VSTCA9XG5cdFwiaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20veW91dHViZS92My9zdWJzY3JpcHRpb25zXCI7XG5cbmxldCByZWZyZXNoUHJvbWlzZTogUHJvbWlzZTxDYWNoZVN0YXRlPiB8IHVuZGVmaW5lZDtcbmxldCB2aXNpYmxlQ2hhbmdlUmVmcmVzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG5cdGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG5cdFx0dm9pZCBlbnN1cmVSZWZyZXNoQWxhcm0oKTtcblx0fSk7XG5cblx0YnJvd3Nlci5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiB7XG5cdFx0dm9pZCBlbnN1cmVSZWZyZXNoQWxhcm0oKTtcblx0fSk7XG5cblx0YnJvd3Nlci5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcigoYWxhcm0pID0+IHtcblx0XHRpZiAoYWxhcm0ubmFtZSA9PT0gUkVGUkVTSF9BTEFSTSkge1xuXHRcdFx0dm9pZCByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhmYWxzZSk7XG5cdFx0fVxuXHR9KTtcblxuXHRicm93c2VyLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKFxuXHRcdChtZXNzYWdlOiBFeHRlbnNpb25SZXF1ZXN0KTogUHJvbWlzZTxFeHRlbnNpb25SZXNwb25zZT4gPT4ge1xuXHRcdFx0cmV0dXJuIGhhbmRsZU1lc3NhZ2UobWVzc2FnZSk7XG5cdFx0fVxuXHQpO1xufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU1lc3NhZ2UoXG5cdG1lc3NhZ2U6IEV4dGVuc2lvblJlcXVlc3Rcbik6IFByb21pc2U8RXh0ZW5zaW9uUmVzcG9uc2U+IHtcblx0dHJ5IHtcblx0XHRzd2l0Y2ggKG1lc3NhZ2UudHlwZSkge1xuXHRcdFx0Y2FzZSBcIlNTX1NJR05fSU5cIjoge1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IHJlZnJlc2hBbGxTdWJzY3JpcHRpb25zKHRydWUpO1xuXHRcdFx0XHRyZXR1cm4geyBvazogdHJ1ZSwgc3RhdGU6IHRvUHVibGljU3RhdGUoc3RhdGUpIH07XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwiU1NfU0lHTl9PVVRcIjoge1xuXHRcdFx0XHRhd2FpdCBzaWduT3V0KCk7XG5cdFx0XHRcdGNvbnN0IHN0YXRlID0gYXdhaXQgc2F2ZVN0YXRlKGVtcHR5Q2FjaGVTdGF0ZSgpKTtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSB9O1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcIlNTX0dFVF9TVEFURVwiOiB7XG5cdFx0XHRcdGNvbnN0IHN0YXRlID0gYXdhaXQgZ2V0U3RhdGUoKTtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSB9O1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcIlNTX1JFRlJFU0hfQUxMXCI6IHtcblx0XHRcdFx0Y29uc3Qgc3RhdGUgPSBhd2FpdCByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhCb29sZWFuKG1lc3NhZ2UuaW50ZXJhY3RpdmUpKTtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSB9O1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcIlNTX0dFVF9TVEFUVVNcIjoge1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGdldEZyZXNoRW5vdWdoU3RhdGUobWVzc2FnZS5jaGFubmVsSWQpO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdG9rOiB0cnVlLFxuXHRcdFx0XHRcdGF1dGhTdGF0dXM6IHN0YXRlLmF1dGhTdGF0dXMsXG5cdFx0XHRcdFx0c3Vic2NyaXB0aW9uOiBzdGF0ZS5zdWJzY3JpcHRpb25zQnlDaGFubmVsSWRbbWVzc2FnZS5jaGFubmVsSWRdLFxuXHRcdFx0XHRcdGxhc3RGdWxsU3luY0F0OiBzdGF0ZS5sYXN0RnVsbFN5bmNBdCxcblx0XHRcdFx0XHRsYXN0RXJyb3I6IHN0YXRlLmxhc3RFcnJvcixcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI6IHtcblx0XHRcdFx0c2NoZWR1bGVWaXNpYmxlQ2hhbmdlUmVmcmVzaCgpO1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGdldFN0YXRlKCk7XG5cdFx0XHRcdHJldHVybiB7IG9rOiB0cnVlLCBzdGF0ZTogdG9QdWJsaWNTdGF0ZShzdGF0ZSkgfTtcblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0Y29uc3Qgc3RhdGUgPSBhd2FpdCBzZXRFcnJvcihlcnJvcik7XG5cdFx0cmV0dXJuIHtcblx0XHRcdG9rOiBmYWxzZSxcblx0XHRcdHN0YXRlOiB0b1B1YmxpY1N0YXRlKHN0YXRlKSxcblx0XHRcdGVycm9yOiBnZXRFcnJvck1lc3NhZ2UoZXJyb3IpLFxuXHRcdH07XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlUmVmcmVzaEFsYXJtKCkge1xuXHRhd2FpdCBicm93c2VyLmFsYXJtcy5jcmVhdGUoUkVGUkVTSF9BTEFSTSwge1xuXHRcdHBlcmlvZEluTWludXRlczogUkVGUkVTSF9QRVJJT0RfTUlOVVRFUyxcblx0fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEZyZXNoRW5vdWdoU3RhdGUoY2hhbm5lbElkOiBzdHJpbmcpIHtcblx0Y29uc3Qgc3RhdGUgPSBhd2FpdCBnZXRTdGF0ZSgpO1xuXHRpZiAoc3RhdGUuYXV0aFN0YXR1cyAhPT0gXCJzaWduZWRfaW5cIikge1xuXHRcdHJldHVybiBzdGF0ZTtcblx0fVxuXG5cdGlmICghc3RhdGUubGFzdEZ1bGxTeW5jQXQpIHtcblx0XHRyZXR1cm4gcmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoZmFsc2UpO1xuXHR9XG5cblx0Y29uc3QgbGFzdFN5bmMgPSBuZXcgRGF0ZShzdGF0ZS5sYXN0RnVsbFN5bmNBdCkuZ2V0VGltZSgpO1xuXHRjb25zdCBpc1N0YWxlID0gTnVtYmVyLmlzTmFOKGxhc3RTeW5jKVxuXHRcdD8gdHJ1ZVxuXHRcdDogRGF0ZS5ub3coKSAtIGxhc3RTeW5jID4gUkVGUkVTSF9QRVJJT0RfTUlOVVRFUyAqIDYwICogMTAwMDtcblxuXHRpZiAoIWlzU3RhbGUgfHwgc3RhdGUuc3Vic2NyaXB0aW9uc0J5Q2hhbm5lbElkW2NoYW5uZWxJZF0pIHtcblx0XHRyZXR1cm4gc3RhdGU7XG5cdH1cblxuXHRyZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhmYWxzZSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcblx0cmV0dXJuIHN0YXRlO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoQWxsU3Vic2NyaXB0aW9ucyhpbnRlcmFjdGl2ZTogYm9vbGVhbikge1xuXHRpZiAocmVmcmVzaFByb21pc2UpIHtcblx0XHRyZXR1cm4gcmVmcmVzaFByb21pc2U7XG5cdH1cblxuXHRyZWZyZXNoUHJvbWlzZSA9IGRvUmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoaW50ZXJhY3RpdmUpLmZpbmFsbHkoKCkgPT4ge1xuXHRcdHJlZnJlc2hQcm9taXNlID0gdW5kZWZpbmVkO1xuXHR9KTtcblxuXHRyZXR1cm4gcmVmcmVzaFByb21pc2U7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRvUmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoaW50ZXJhY3RpdmU6IGJvb2xlYW4pIHtcblx0Y29uc3QgdG9rZW4gPSBhd2FpdCBnZXRBdXRoVG9rZW4oaW50ZXJhY3RpdmUpO1xuXHRjb25zdCBmZXRjaGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdGNvbnN0IHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPiA9IHt9O1xuXHRsZXQgcGFnZVRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0ZG8ge1xuXHRcdGNvbnN0IHVybCA9IG5ldyBVUkwoWU9VVFVCRV9TVUJTQ1JJUFRJT05TX1VSTCk7XG5cdFx0dXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJwYXJ0XCIsIFwic25pcHBldFwiKTtcblx0XHR1cmwuc2VhcmNoUGFyYW1zLnNldChcIm1pbmVcIiwgXCJ0cnVlXCIpO1xuXHRcdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwibWF4UmVzdWx0c1wiLCBcIjUwXCIpO1xuXHRcdGlmIChwYWdlVG9rZW4pIHtcblx0XHRcdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwicGFnZVRva2VuXCIsIHBhZ2VUb2tlbik7XG5cdFx0fVxuXG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwudG9TdHJpbmcoKSwge1xuXHRcdFx0aGVhZGVyczoge1xuXHRcdFx0XHRBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDEpIHtcblx0XHRcdGF3YWl0IHJlbW92ZUNhY2hlZFRva2VuKHRva2VuKTtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkdvb2dsZSBhdXRob3JpemF0aW9uIGV4cGlyZWQuIFBsZWFzZSBzaWduIGluIGFnYWluLlwiKTtcblx0XHR9XG5cblx0XHRpZiAoIXJlc3BvbnNlLm9rKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFlvdVR1YmUgQVBJIHJlcXVlc3QgZmFpbGVkICgke3Jlc3BvbnNlLnN0YXR1c30pLmApO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyBZb3VUdWJlU3Vic2NyaXB0aW9uTGlzdFJlc3BvbnNlO1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBkYXRhLml0ZW1zID8/IFtdKSB7XG5cdFx0XHRjb25zdCBjaGFubmVsSWQgPSBpdGVtLnNuaXBwZXQ/LnJlc291cmNlSWQ/LmNoYW5uZWxJZDtcblx0XHRcdGNvbnN0IHN1YnNjcmliZWRBdCA9IGl0ZW0uc25pcHBldD8ucHVibGlzaGVkQXQ7XG5cdFx0XHRpZiAoIWNoYW5uZWxJZCB8fCAhc3Vic2NyaWJlZEF0KSB7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRzdWJzY3JpcHRpb25zQnlDaGFubmVsSWRbY2hhbm5lbElkXSA9IHtcblx0XHRcdFx0c3Vic2NyaXB0aW9uSWQ6IGl0ZW0uaWQgPz8gY2hhbm5lbElkLFxuXHRcdFx0XHRjaGFubmVsSWQsXG5cdFx0XHRcdGNoYW5uZWxUaXRsZTogaXRlbS5zbmlwcGV0Py50aXRsZSA/PyBcIllvdVR1YmUgY2hhbm5lbFwiLFxuXHRcdFx0XHRzdWJzY3JpYmVkQXQsXG5cdFx0XHRcdGZldGNoZWRBdCxcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cGFnZVRva2VuID0gZGF0YS5uZXh0UGFnZVRva2VuO1xuXHR9IHdoaWxlIChwYWdlVG9rZW4pO1xuXG5cdHJldHVybiBzYXZlU3RhdGUoe1xuXHRcdGF1dGhTdGF0dXM6IFwic2lnbmVkX2luXCIsXG5cdFx0bGFzdEZ1bGxTeW5jQXQ6IGZldGNoZWRBdCxcblx0XHRzdWJzY3JpcHRpb25zQnlDaGFubmVsSWQsXG5cdH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRTdGF0ZSgpOiBQcm9taXNlPENhY2hlU3RhdGU+IHtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChDQUNIRV9TVE9SQUdFX0tFWSk7XG5cdHJldHVybiB7XG5cdFx0Li4uZW1wdHlDYWNoZVN0YXRlKCksXG5cdFx0Li4uKHJlc3VsdFtDQUNIRV9TVE9SQUdFX0tFWV0gYXMgUGFydGlhbDxDYWNoZVN0YXRlPiB8IHVuZGVmaW5lZCksXG5cdH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNhdmVTdGF0ZShzdGF0ZTogQ2FjaGVTdGF0ZSk6IFByb21pc2U8Q2FjaGVTdGF0ZT4ge1xuXHRhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgW0NBQ0hFX1NUT1JBR0VfS0VZXTogc3RhdGUgfSk7XG5cdHJldHVybiBzdGF0ZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2V0RXJyb3IoZXJyb3I6IHVua25vd24pOiBQcm9taXNlPENhY2hlU3RhdGU+IHtcblx0Y29uc3Qgc3RhdGUgPSBhd2FpdCBnZXRTdGF0ZSgpO1xuXHRyZXR1cm4gc2F2ZVN0YXRlKHtcblx0XHQuLi5zdGF0ZSxcblx0XHRhdXRoU3RhdHVzOiBzdGF0ZS5hdXRoU3RhdHVzID09PSBcInNpZ25lZF9pblwiID8gXCJlcnJvclwiIDogXCJzaWduZWRfb3V0XCIsXG5cdFx0bGFzdEVycm9yOiBnZXRFcnJvck1lc3NhZ2UoZXJyb3IpLFxuXHR9KTtcbn1cblxuZnVuY3Rpb24gdG9QdWJsaWNTdGF0ZShzdGF0ZTogQ2FjaGVTdGF0ZSk6IFB1YmxpY1N0YXRlIHtcblx0cmV0dXJuIHtcblx0XHRhdXRoU3RhdHVzOiBzdGF0ZS5hdXRoU3RhdHVzLFxuXHRcdGxhc3RGdWxsU3luY0F0OiBzdGF0ZS5sYXN0RnVsbFN5bmNBdCxcblx0XHRsYXN0RXJyb3I6IHN0YXRlLmxhc3RFcnJvcixcblx0XHRzdWJzY3JpcHRpb25Db3VudDogT2JqZWN0LmtleXMoc3RhdGUuc3Vic2NyaXB0aW9uc0J5Q2hhbm5lbElkKS5sZW5ndGgsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlVmlzaWJsZUNoYW5nZVJlZnJlc2goKSB7XG5cdGlmICh2aXNpYmxlQ2hhbmdlUmVmcmVzaFRpbWVyKSB7XG5cdFx0Y2xlYXJUaW1lb3V0KHZpc2libGVDaGFuZ2VSZWZyZXNoVGltZXIpO1xuXHR9XG5cblx0dmlzaWJsZUNoYW5nZVJlZnJlc2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdHZvaWQgcmVmcmVzaEFsbFN1YnNjcmlwdGlvbnMoZmFsc2UpO1xuXHR9LCAzMDAwKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2lnbk91dCgpIHtcblx0Y29uc3QgdG9rZW4gPSBhd2FpdCBnZXRBdXRoVG9rZW4oZmFsc2UpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG5cdGlmICh0b2tlbikge1xuXHRcdGF3YWl0IHJlbW92ZUNhY2hlZFRva2VuKHRva2VuKTtcblx0fVxuXG5cdGNvbnN0IGNocm9tZUFwaSA9IGdldENocm9tZUFwaSgpO1xuXHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdGNocm9tZUFwaS5pZGVudGl0eT8uY2xlYXJBbGxDYWNoZWRBdXRoVG9rZW5zPy4oKCkgPT4gcmVzb2x2ZSgpKTtcblx0XHRpZiAoIWNocm9tZUFwaS5pZGVudGl0eT8uY2xlYXJBbGxDYWNoZWRBdXRoVG9rZW5zKSB7XG5cdFx0XHRyZXNvbHZlKCk7XG5cdFx0fVxuXHR9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0QXV0aFRva2VuKGludGVyYWN0aXZlOiBib29sZWFuKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0Y29uc3QgY2hyb21lQXBpID0gZ2V0Q2hyb21lQXBpKCk7XG5cdGlmICghY2hyb21lQXBpLmlkZW50aXR5Py5nZXRBdXRoVG9rZW4pIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDaHJvbWUgaWRlbnRpdHkgQVBJIGlzIHVuYXZhaWxhYmxlLlwiKTtcblx0fVxuXG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0Y2hyb21lQXBpLmlkZW50aXR5Py5nZXRBdXRoVG9rZW4oeyBpbnRlcmFjdGl2ZSB9LCAocmVzdWx0KSA9PiB7XG5cdFx0XHRjb25zdCBydW50aW1lRXJyb3IgPSBjaHJvbWVBcGkucnVudGltZT8ubGFzdEVycm9yPy5tZXNzYWdlO1xuXHRcdFx0aWYgKHJ1bnRpbWVFcnJvcikge1xuXHRcdFx0XHRyZWplY3QobmV3IEVycm9yKHJ1bnRpbWVFcnJvcikpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHRva2VuID0gdHlwZW9mIHJlc3VsdCA9PT0gXCJzdHJpbmdcIiA/IHJlc3VsdCA6IHJlc3VsdD8udG9rZW47XG5cdFx0XHRpZiAoIXRva2VuKSB7XG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJObyBHb29nbGUgYXV0aCB0b2tlbiB3YXMgcmV0dXJuZWQuXCIpKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRyZXNvbHZlKHRva2VuKTtcblx0XHR9KTtcblx0fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZUNhY2hlZFRva2VuKHRva2VuOiBzdHJpbmcpIHtcblx0Y29uc3QgY2hyb21lQXBpID0gZ2V0Q2hyb21lQXBpKCk7XG5cdGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0Y2hyb21lQXBpLmlkZW50aXR5Py5yZW1vdmVDYWNoZWRBdXRoVG9rZW4/Lih7IHRva2VuIH0sICgpID0+IHJlc29sdmUoKSk7XG5cdFx0aWYgKCFjaHJvbWVBcGkuaWRlbnRpdHk/LnJlbW92ZUNhY2hlZEF1dGhUb2tlbikge1xuXHRcdFx0cmVzb2x2ZSgpO1xuXHRcdH1cblx0fSk7XG59XG5cbmZ1bmN0aW9uIGdldENocm9tZUFwaSgpOiBDaHJvbWVJZGVudGl0eSB7XG5cdHJldHVybiAoZ2xvYmFsVGhpcyBhcyB1bmtub3duIGFzIHsgY2hyb21lPzogQ2hyb21lSWRlbnRpdHkgfSkuY2hyb21lID8/IHt9O1xufVxuXG5mdW5jdGlvbiBnZXRFcnJvck1lc3NhZ2UoZXJyb3I6IHVua25vd24pIHtcblx0aWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRyZXR1cm4gZXJyb3IubWVzc2FnZTtcblx0fVxuXG5cdHJldHVybiBTdHJpbmcoZXJyb3IpO1xufVxuIiwiLy8gc3JjL2luZGV4LnRzXG52YXIgX01hdGNoUGF0dGVybiA9IGNsYXNzIHtcbiAgY29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuKSB7XG4gICAgaWYgKG1hdGNoUGF0dGVybiA9PT0gXCI8YWxsX3VybHM+XCIpIHtcbiAgICAgIHRoaXMuaXNBbGxVcmxzID0gdHJ1ZTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gWy4uLl9NYXRjaFBhdHRlcm4uUFJPVE9DT0xTXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IFwiKlwiO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gXCIqXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGdyb3VwcyA9IC8oLiopOlxcL1xcLyguKj8pKFxcLy4qKS8uZXhlYyhtYXRjaFBhdHRlcm4pO1xuICAgICAgaWYgKGdyb3VwcyA9PSBudWxsKVxuICAgICAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIFwiSW5jb3JyZWN0IGZvcm1hdFwiKTtcbiAgICAgIGNvbnN0IFtfLCBwcm90b2NvbCwgaG9zdG5hbWUsIHBhdGhuYW1lXSA9IGdyb3VwcztcbiAgICAgIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCk7XG4gICAgICB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpO1xuICAgICAgdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKTtcbiAgICAgIHRoaXMucHJvdG9jb2xNYXRjaGVzID0gcHJvdG9jb2wgPT09IFwiKlwiID8gW1wiaHR0cFwiLCBcImh0dHBzXCJdIDogW3Byb3RvY29sXTtcbiAgICAgIHRoaXMuaG9zdG5hbWVNYXRjaCA9IGhvc3RuYW1lO1xuICAgICAgdGhpcy5wYXRobmFtZU1hdGNoID0gcGF0aG5hbWU7XG4gICAgfVxuICB9XG4gIGluY2x1ZGVzKHVybCkge1xuICAgIGlmICh0aGlzLmlzQWxsVXJscylcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IHUgPSB0eXBlb2YgdXJsID09PSBcInN0cmluZ1wiID8gbmV3IFVSTCh1cmwpIDogdXJsIGluc3RhbmNlb2YgTG9jYXRpb24gPyBuZXcgVVJMKHVybC5ocmVmKSA6IHVybDtcbiAgICByZXR1cm4gISF0aGlzLnByb3RvY29sTWF0Y2hlcy5maW5kKChwcm90b2NvbCkgPT4ge1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImh0dHBcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiaHR0cHNcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNIdHRwc01hdGNoKHUpO1xuICAgICAgaWYgKHByb3RvY29sID09PSBcImZpbGVcIilcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNGaWxlTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwiZnRwXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzRnRwTWF0Y2godSk7XG4gICAgICBpZiAocHJvdG9jb2wgPT09IFwidXJuXCIpXG4gICAgICAgIHJldHVybiB0aGlzLmlzVXJuTWF0Y2godSk7XG4gICAgfSk7XG4gIH1cbiAgaXNIdHRwTWF0Y2godXJsKSB7XG4gICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG4gIH1cbiAgaXNIdHRwc01hdGNoKHVybCkge1xuICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcbiAgfVxuICBpc0hvc3RQYXRoTWF0Y2godXJsKSB7XG4gICAgaWYgKCF0aGlzLmhvc3RuYW1lTWF0Y2ggfHwgIXRoaXMucGF0aG5hbWVNYXRjaClcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBob3N0bmFtZU1hdGNoUmVnZXhzID0gW1xuICAgICAgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoKSxcbiAgICAgIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaC5yZXBsYWNlKC9eXFwqXFwuLywgXCJcIikpXG4gICAgXTtcbiAgICBjb25zdCBwYXRobmFtZU1hdGNoUmVnZXggPSB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLnBhdGhuYW1lTWF0Y2gpO1xuICAgIHJldHVybiAhIWhvc3RuYW1lTWF0Y2hSZWdleHMuZmluZCgocmVnZXgpID0+IHJlZ2V4LnRlc3QodXJsLmhvc3RuYW1lKSkgJiYgcGF0aG5hbWVNYXRjaFJlZ2V4LnRlc3QodXJsLnBhdGhuYW1lKTtcbiAgfVxuICBpc0ZpbGVNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZmlsZTovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG4gIH1cbiAgaXNGdHBNYXRjaCh1cmwpIHtcbiAgICB0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZnRwOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcbiAgfVxuICBpc1Vybk1hdGNoKHVybCkge1xuICAgIHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiB1cm46Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuICB9XG4gIGNvbnZlcnRQYXR0ZXJuVG9SZWdleChwYXR0ZXJuKSB7XG4gICAgY29uc3QgZXNjYXBlZCA9IHRoaXMuZXNjYXBlRm9yUmVnZXgocGF0dGVybik7XG4gICAgY29uc3Qgc3RhcnNSZXBsYWNlZCA9IGVzY2FwZWQucmVwbGFjZSgvXFxcXFxcKi9nLCBcIi4qXCIpO1xuICAgIHJldHVybiBSZWdFeHAoYF4ke3N0YXJzUmVwbGFjZWR9JGApO1xuICB9XG4gIGVzY2FwZUZvclJlZ2V4KHN0cmluZykge1xuICAgIHJldHVybiBzdHJpbmcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICB9XG59O1xudmFyIE1hdGNoUGF0dGVybiA9IF9NYXRjaFBhdHRlcm47XG5NYXRjaFBhdHRlcm4uUFJPVE9DT0xTID0gW1wiaHR0cFwiLCBcImh0dHBzXCIsIFwiZmlsZVwiLCBcImZ0cFwiLCBcInVyblwiXTtcbnZhciBJbnZhbGlkTWF0Y2hQYXR0ZXJuID0gY2xhc3MgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybiwgcmVhc29uKSB7XG4gICAgc3VwZXIoYEludmFsaWQgbWF0Y2ggcGF0dGVybiBcIiR7bWF0Y2hQYXR0ZXJufVwiOiAke3JlYXNvbn1gKTtcbiAgfVxufTtcbmZ1bmN0aW9uIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCkge1xuICBpZiAoIU1hdGNoUGF0dGVybi5QUk9UT0NPTFMuaW5jbHVkZXMocHJvdG9jb2wpICYmIHByb3RvY29sICE9PSBcIipcIilcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihcbiAgICAgIG1hdGNoUGF0dGVybixcbiAgICAgIGAke3Byb3RvY29sfSBub3QgYSB2YWxpZCBwcm90b2NvbCAoJHtNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmpvaW4oXCIsIFwiKX0pYFxuICAgICk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpIHtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiOlwiKSlcbiAgICB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGBIb3N0bmFtZSBjYW5ub3QgaW5jbHVkZSBhIHBvcnRgKTtcbiAgaWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiKlwiKSAmJiBob3N0bmFtZS5sZW5ndGggPiAxICYmICFob3N0bmFtZS5zdGFydHNXaXRoKFwiKi5cIikpXG4gICAgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4oXG4gICAgICBtYXRjaFBhdHRlcm4sXG4gICAgICBgSWYgdXNpbmcgYSB3aWxkY2FyZCAoKiksIGl0IG11c3QgZ28gYXQgdGhlIHN0YXJ0IG9mIHRoZSBob3N0bmFtZWBcbiAgICApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVQYXRobmFtZShtYXRjaFBhdHRlcm4sIHBhdGhuYW1lKSB7XG4gIHJldHVybjtcbn1cbmV4cG9ydCB7XG4gIEludmFsaWRNYXRjaFBhdHRlcm4sXG4gIE1hdGNoUGF0dGVyblxufTtcbiJdLCJuYW1lcyI6WyJicm93c2VyIiwiX2Jyb3dzZXIiLCJyZXN1bHQiXSwibWFwcGluZ3MiOiI7O0FBQU8sV0FBUyxpQkFBaUIsS0FBSztBQUNwQyxRQUFJLE9BQU8sUUFBUSxPQUFPLFFBQVEsV0FBWSxRQUFPLEVBQUUsTUFBTSxJQUFHO0FBQ2hFLFdBQU87QUFBQSxFQUNUO0FDRk8sUUFBTUEsWUFBVSxXQUFXLFNBQVMsU0FBUyxLQUNoRCxXQUFXLFVBQ1gsV0FBVztBQ0ZSLFFBQU0sVUFBVUM7QUNEaEIsUUFBTSxvQkFBb0I7QUE4RTFCLFdBQVMsa0JBQThCO0FBQzdDLFdBQU87QUFBQSxNQUNOLFlBQVk7QUFBQSxNQUNaLDBCQUEwQixDQUFBO0FBQUEsSUFBQztBQUFBLEVBRTdCO0FDekNBLFFBQUEsZ0JBQUE7QUFDQSxRQUFBLHlCQUFBLElBQUE7QUFDQSxRQUFBLDRCQUFBO0FBR0EsTUFBQTtBQUNBLE1BQUE7QUFFQSxRQUFBLGFBQUEsaUJBQUEsTUFBQTtBQUNDLFlBQUEsUUFBQSxZQUFBLFlBQUEsTUFBQTtBQUNDLFdBQUEsbUJBQUE7QUFBQSxJQUF3QixDQUFBO0FBR3pCLFlBQUEsUUFBQSxVQUFBLFlB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
