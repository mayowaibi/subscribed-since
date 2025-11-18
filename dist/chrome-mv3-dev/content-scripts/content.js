var content = (function() {
  "use strict";
  function defineContentScript(definition2) {
    return definition2;
  }
  const definition = defineContentScript({
    matches: ["*://*.youtube.com/*"],
    main() {
      let lastLoggedVideoId = "";
      const SUBSCRIBE_UI_ID = "ss-subscribed-since";
      function getVideoIdFromUrl(url) {
        try {
          const u = new URL(url);
          const host = u.hostname.toLowerCase();
          if (host.endsWith("youtube.com") && u.pathname === "/watch") {
            return u.searchParams.get("v");
          }
          if (host === "youtu.be") {
            return u.pathname.slice(1) || null;
          }
          return null;
        } catch (e) {
          return null;
        }
      }
      function maybeLog() {
        const videoId = getVideoIdFromUrl(window.location.href);
        console.log(`[SS] maybeLog: href=${location.href}, videoId=${videoId}`);
        if (videoId && videoId !== lastLoggedVideoId) {
          console.log(`[SS] New video detected: ${videoId}`);
          lastLoggedVideoId = videoId;
          const dateText = "October 15, 2025";
          let attempts = 0;
          const maxAttempts = 10;
          const tryInsert = () => {
            attempts += 1;
            console.log(`[SS] insert attempt ${attempts} for ${videoId}`);
            if (insertSubscribedSince(dateText)) {
              console.log(`[SS] insert succeeded for ${videoId}`);
              if (retryInterval) clearInterval(retryInterval);
            } else if (attempts >= maxAttempts) {
              console.log(
                `[SS] insert failed after ${attempts} attempts for ${videoId}`
              );
              if (retryInterval) clearInterval(retryInterval);
            }
          };
          tryInsert();
          let retryInterval = 0;
          retryInterval = setInterval(tryInsert, 500);
        } else if (!videoId) {
          if (lastLoggedVideoId)
            console.log(`[SS] navigating away from video ${lastLoggedVideoId}`);
          lastLoggedVideoId = "";
          removeSubscribedSince();
        }
      }
      maybeLog();
      let lastHref = location.href;
      new MutationObserver(() => {
        if (location.href !== lastHref) {
          console.log(`[SS] URL changed: ${lastHref} -> ${location.href}`);
          lastHref = location.href;
          maybeLog();
        }
      }).observe(document, { subtree: true, childList: true });
      function createSubscribedSinceElement(dateText) {
        const container = document.createElement("div");
        container.id = SUBSCRIBE_UI_ID;
        container.style.display = "flex";
        container.style.flexDirection = "row";
        container.style.alignItems = "center";
        container.style.marginTop = "12px";
        container.style.marginLeft = "-15px";
        container.style.color = "var(--yt-spec-text-primary, #000)";
        container.style.fontFamily = "Roboto, Arial, sans-serif";
        const emojiCol = document.createElement("div");
        emojiCol.style.display = "flex";
        emojiCol.style.flexDirection = "column";
        emojiCol.style.marginRight = "5px";
        emojiCol.style.fontSize = "28px";
        emojiCol.textContent = "📅";
        const textCol = document.createElement("div");
        textCol.style.display = "flex";
        textCol.style.flexDirection = "column";
        textCol.style.justifyContent = "center";
        textCol.style.alignItems = "flex-start";
        const title = document.createElement("div");
        title.textContent = "Subscribed Since";
        title.style.fontWeight = "600";
        title.style.fontSize = "14px";
        const date = document.createElement("div");
        date.textContent = dateText;
        date.style.opacity = "0.9";
        date.style.fontSize = "14px";
        textCol.appendChild(title);
        textCol.appendChild(date);
        container.appendChild(emojiCol);
        container.appendChild(textCol);
        return container;
      }
      function insertSubscribedSince(dateText) {
        removeSubscribedSince();
        const ownerEl = document.getElementById("owner");
        if (!ownerEl) {
          console.log("[SS] owner element not found");
          return false;
        }
        try {
          const el = createSubscribedSinceElement(dateText);
          ownerEl.insertAdjacentElement("afterend", el);
          console.log(
            `[SS] inserted subscribed-since element after #owner (tag=${ownerEl.tagName}, id=${ownerEl.id || "<none>"})`
          );
          return true;
        } catch (e) {
          console.log("[SS] error inserting subscribed-since element", e);
          return false;
        }
      }
      function removeSubscribedSince() {
        const existing = document.getElementById(SUBSCRIBE_UI_ID);
        if (existing && existing.parentNode) {
          existing.remove();
          console.log("[SS] removed subscribed-since element");
        } else {
          console.log("[SS] subscribed-since element not present");
        }
      }
    }
  });
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  function print$1(method, ...args) {
    if (typeof args[0] === "string") {
      const message = args.shift();
      method(`[wxt] ${message}`, ...args);
    } else {
      method("[wxt]", ...args);
    }
  }
  const logger$1 = {
    debug: (...args) => print$1(console.debug, ...args),
    log: (...args) => print$1(console.log, ...args),
    warn: (...args) => print$1(console.warn, ...args),
    error: (...args) => print$1(console.error, ...args)
  };
  class WxtLocationChangeEvent extends Event {
    constructor(newUrl, oldUrl) {
      super(WxtLocationChangeEvent.EVENT_NAME, {});
      this.newUrl = newUrl;
      this.oldUrl = oldUrl;
    }
    static EVENT_NAME = getUniqueEventName("wxt:locationchange");
  }
  function getUniqueEventName(eventName) {
    return `${browser?.runtime?.id}:${"content"}:${eventName}`;
  }
  function createLocationWatcher(ctx) {
    let interval;
    let oldUrl;
    return {
      /**
       * Ensure the location watcher is actively looking for URL changes. If it's already watching,
       * this is a noop.
       */
      run() {
        if (interval != null) return;
        oldUrl = new URL(location.href);
        interval = ctx.setInterval(() => {
          let newUrl = new URL(location.href);
          if (newUrl.href !== oldUrl.href) {
            window.dispatchEvent(new WxtLocationChangeEvent(newUrl, oldUrl));
            oldUrl = newUrl;
          }
        }, 1e3);
      }
    };
  }
  class ContentScriptContext {
    constructor(contentScriptName, options) {
      this.contentScriptName = contentScriptName;
      this.options = options;
      this.abortController = new AbortController();
      if (this.isTopFrame) {
        this.listenForNewerScripts({ ignoreFirstEvent: true });
        this.stopOldScripts();
      } else {
        this.listenForNewerScripts();
      }
    }
    static SCRIPT_STARTED_MESSAGE_TYPE = getUniqueEventName(
      "wxt:content-script-started"
    );
    isTopFrame = window.self === window.top;
    abortController;
    locationWatcher = createLocationWatcher(this);
    receivedMessageIds = /* @__PURE__ */ new Set();
    get signal() {
      return this.abortController.signal;
    }
    abort(reason) {
      return this.abortController.abort(reason);
    }
    get isInvalid() {
      if (browser.runtime.id == null) {
        this.notifyInvalidated();
      }
      return this.signal.aborted;
    }
    get isValid() {
      return !this.isInvalid;
    }
    /**
     * Add a listener that is called when the content script's context is invalidated.
     *
     * @returns A function to remove the listener.
     *
     * @example
     * browser.runtime.onMessage.addListener(cb);
     * const removeInvalidatedListener = ctx.onInvalidated(() => {
     *   browser.runtime.onMessage.removeListener(cb);
     * })
     * // ...
     * removeInvalidatedListener();
     */
    onInvalidated(cb) {
      this.signal.addEventListener("abort", cb);
      return () => this.signal.removeEventListener("abort", cb);
    }
    /**
     * Return a promise that never resolves. Useful if you have an async function that shouldn't run
     * after the context is expired.
     *
     * @example
     * const getValueFromStorage = async () => {
     *   if (ctx.isInvalid) return ctx.block();
     *
     *   // ...
     * }
     */
    block() {
      return new Promise(() => {
      });
    }
    /**
     * Wrapper around `window.setInterval` that automatically clears the interval when invalidated.
     *
     * Intervals can be cleared by calling the normal `clearInterval` function.
     */
    setInterval(handler, timeout) {
      const id = setInterval(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearInterval(id));
      return id;
    }
    /**
     * Wrapper around `window.setTimeout` that automatically clears the interval when invalidated.
     *
     * Timeouts can be cleared by calling the normal `setTimeout` function.
     */
    setTimeout(handler, timeout) {
      const id = setTimeout(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearTimeout(id));
      return id;
    }
    /**
     * Wrapper around `window.requestAnimationFrame` that automatically cancels the request when
     * invalidated.
     *
     * Callbacks can be canceled by calling the normal `cancelAnimationFrame` function.
     */
    requestAnimationFrame(callback) {
      const id = requestAnimationFrame((...args) => {
        if (this.isValid) callback(...args);
      });
      this.onInvalidated(() => cancelAnimationFrame(id));
      return id;
    }
    /**
     * Wrapper around `window.requestIdleCallback` that automatically cancels the request when
     * invalidated.
     *
     * Callbacks can be canceled by calling the normal `cancelIdleCallback` function.
     */
    requestIdleCallback(callback, options) {
      const id = requestIdleCallback((...args) => {
        if (!this.signal.aborted) callback(...args);
      }, options);
      this.onInvalidated(() => cancelIdleCallback(id));
      return id;
    }
    addEventListener(target, type, handler, options) {
      if (type === "wxt:locationchange") {
        if (this.isValid) this.locationWatcher.run();
      }
      target.addEventListener?.(
        type.startsWith("wxt:") ? getUniqueEventName(type) : type,
        handler,
        {
          ...options,
          signal: this.signal
        }
      );
    }
    /**
     * @internal
     * Abort the abort controller and execute all `onInvalidated` listeners.
     */
    notifyInvalidated() {
      this.abort("Content script context invalidated");
      logger$1.debug(
        `Content script "${this.contentScriptName}" context invalidated`
      );
    }
    stopOldScripts() {
      window.postMessage(
        {
          type: ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE,
          contentScriptName: this.contentScriptName,
          messageId: Math.random().toString(36).slice(2)
        },
        "*"
      );
    }
    verifyScriptStartedEvent(event) {
      const isScriptStartedEvent = event.data?.type === ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE;
      const isSameContentScript = event.data?.contentScriptName === this.contentScriptName;
      const isNotDuplicate = !this.receivedMessageIds.has(event.data?.messageId);
      return isScriptStartedEvent && isSameContentScript && isNotDuplicate;
    }
    listenForNewerScripts(options) {
      let isFirst = true;
      const cb = (event) => {
        if (this.verifyScriptStartedEvent(event)) {
          this.receivedMessageIds.add(event.data.messageId);
          const wasFirst = isFirst;
          isFirst = false;
          if (wasFirst && options?.ignoreFirstEvent) return;
          this.notifyInvalidated();
        }
      };
      addEventListener("message", cb);
      this.onInvalidated(() => removeEventListener("message", cb));
    }
  }
  function initPlugins() {
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
  const result = (async () => {
    try {
      initPlugins();
      const { main, ...options } = definition;
      const ctx = new ContentScriptContext("content", options);
      return await main(ctx);
    } catch (err) {
      logger.error(
        `The content script "${"content"}" crashed on startup!`,
        err
      );
      throw err;
    }
  })();
  return result;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9zcmMvZW50cnlwb2ludHMvY29udGVudC9pbmRleC50cyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy8ucG5wbS9Ad3h0LWRlditicm93c2VyQDAuMS40L25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvbG9nZ2VyLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy8ucG5wbS93eHRAMC4yMC4xMV9AdHlwZXMrbm9kZUAyNC4xMC4xX2ppdGlAMi42LjFfbGlnaHRuaW5nY3NzQDEuMzAuMl9yb2xsdXBANC41My4yL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy8ucG5wbS93eHRAMC4yMC4xMV9AdHlwZXMrbm9kZUAyNC4xMC4xX2ppdGlAMi42LjFfbGlnaHRuaW5nY3NzQDEuMzAuMl9yb2xsdXBANC41My4yL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy8ucG5wbS93eHRAMC4yMC4xMV9AdHlwZXMrbm9kZUAyNC4xMC4xX2ppdGlAMi42LjFfbGlnaHRuaW5nY3NzQDEuMzAuMl9yb2xsdXBANC41My4yL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9jb250ZW50LXNjcmlwdC1jb250ZXh0Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJleHBvcnQgZnVuY3Rpb24gZGVmaW5lQ29udGVudFNjcmlwdChkZWZpbml0aW9uKSB7XG4gIHJldHVybiBkZWZpbml0aW9uO1xufVxuIiwiZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29udGVudFNjcmlwdCh7XG5cdG1hdGNoZXM6IFtcIio6Ly8qLnlvdXR1YmUuY29tLypcIl0sXG5cdG1haW4oKSB7XG5cdFx0ZnVuY3Rpb24gaXNZb3VUdWJlVmlkZW9VcmwodXJsOiBzdHJpbmcpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHUgPSBuZXcgVVJMKHVybCk7XG5cdFx0XHRcdGNvbnN0IGhvc3QgPSB1Lmhvc3RuYW1lLnRvTG93ZXJDYXNlKCk7XG5cblx0XHRcdFx0Ly8gQ2Fub25pY2FsIFlvdVR1YmUgdmlkZW8gcGFnZTogL3dhdGNoP3Y9VklERU9fSURcblx0XHRcdFx0aWYgKGhvc3QuZW5kc1dpdGgoXCJ5b3V0dWJlLmNvbVwiKSkge1xuXHRcdFx0XHRcdHJldHVybiB1LnBhdGhuYW1lID09PSBcIi93YXRjaFwiICYmIHUuc2VhcmNoUGFyYW1zLmhhcyhcInZcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBTaG9ydCB5b3V0dS5iZSBsaW5rczogaHR0cHM6Ly95b3V0dS5iZS9WSURFT19JRFxuXHRcdFx0XHRpZiAoaG9zdCA9PT0gXCJ5b3V0dS5iZVwiKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHUucGF0aG5hbWUgJiYgdS5wYXRobmFtZS5sZW5ndGggPiAxOyAvLyAnL1ZJREVPX0lEJ1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fSBjYXRjaCAoZSkge1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0bGV0IGxhc3RMb2dnZWRWaWRlb0lkOiBzdHJpbmcgPSBcIlwiO1xuXG5cdFx0Ly8gSUQgdXNlZCBmb3IgdGhlIGluamVjdGVkIFVJIGVsZW1lbnQuIEhvaXN0ZWQgc28gZnVuY3Rpb25zIGNhbiByZWZlcmVuY2UgaXRcblx0XHQvLyBldmVuIHdoZW4gdGhleSdyZSBjYWxsZWQgYmVmb3JlIHRoZSBoZWxwZXIgc2VjdGlvbiBpcyBwYXJzZWQvZXhlY3V0ZWQuXG5cdFx0Y29uc3QgU1VCU0NSSUJFX1VJX0lEID0gXCJzcy1zdWJzY3JpYmVkLXNpbmNlXCI7XG5cblx0XHRmdW5jdGlvbiBnZXRWaWRlb0lkRnJvbVVybCh1cmw6IHN0cmluZykge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgdSA9IG5ldyBVUkwodXJsKTtcblx0XHRcdFx0Y29uc3QgaG9zdCA9IHUuaG9zdG5hbWUudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0aWYgKGhvc3QuZW5kc1dpdGgoXCJ5b3V0dWJlLmNvbVwiKSAmJiB1LnBhdGhuYW1lID09PSBcIi93YXRjaFwiKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHUuc2VhcmNoUGFyYW1zLmdldChcInZcIik7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGhvc3QgPT09IFwieW91dHUuYmVcIikge1xuXHRcdFx0XHRcdHJldHVybiB1LnBhdGhuYW1lLnNsaWNlKDEpIHx8IG51bGw7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0XHR9IGNhdGNoIChlKSB7XG5cdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIG1heWJlTG9nKCkge1xuXHRcdFx0Y29uc3QgdmlkZW9JZCA9IGdldFZpZGVvSWRGcm9tVXJsKHdpbmRvdy5sb2NhdGlvbi5ocmVmKTtcblx0XHRcdGNvbnNvbGUubG9nKGBbU1NdIG1heWJlTG9nOiBocmVmPSR7bG9jYXRpb24uaHJlZn0sIHZpZGVvSWQ9JHt2aWRlb0lkfWApO1xuXHRcdFx0Ly8gSWYgd2UncmUgb24gYSB2aWRlbyBhbmQgaXQncyBhIGRpZmZlcmVudCB2aWRlbyB0aGFuIGJlZm9yZSwgaW5qZWN0IHRoZSBVSS5cblx0XHRcdGlmICh2aWRlb0lkICYmIHZpZGVvSWQgIT09IGxhc3RMb2dnZWRWaWRlb0lkKSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbU1NdIE5ldyB2aWRlbyBkZXRlY3RlZDogJHt2aWRlb0lkfWApO1xuXHRcdFx0XHRsYXN0TG9nZ2VkVmlkZW9JZCA9IHZpZGVvSWQ7XG5cdFx0XHRcdC8vIEluc2VydCB0aGUgXCJTdWJzY3JpYmVkIFNpbmNlXCIgVUkgbmV4dCB0byB0aGUgc3Vic2NyaWJlIGJ1dHRvbi4gUmV0cnkgYSBmZXdcblx0XHRcdFx0Ly8gSW5zZXJ0IHRoZSBcIlN1YnNjcmliZWQgU2luY2VcIiBVSSB1bmRlciB0aGUgb3duZXIgZWxlbWVudC4gUmV0cnkgYSBmZXdcblx0XHRcdFx0Ly8gdGltZXMgaW4gY2FzZSB0aGUgb3duZXIgZWxlbWVudCBoYXNuJ3QgYmVlbiByZW5kZXJlZCB5ZXQuXG5cdFx0XHRcdGNvbnN0IGRhdGVUZXh0ID0gXCJPY3RvYmVyIDE1LCAyMDI1XCI7XG5cdFx0XHRcdGxldCBhdHRlbXB0cyA9IDA7XG5cdFx0XHRcdGNvbnN0IG1heEF0dGVtcHRzID0gMTA7XG5cblx0XHRcdFx0Y29uc3QgdHJ5SW5zZXJ0ID0gKCkgPT4ge1xuXHRcdFx0XHRcdGF0dGVtcHRzICs9IDE7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtTU10gaW5zZXJ0IGF0dGVtcHQgJHthdHRlbXB0c30gZm9yICR7dmlkZW9JZH1gKTtcblx0XHRcdFx0XHRpZiAoaW5zZXJ0U3Vic2NyaWJlZFNpbmNlKGRhdGVUZXh0KSkge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtTU10gaW5zZXJ0IHN1Y2NlZWRlZCBmb3IgJHt2aWRlb0lkfWApO1xuXHRcdFx0XHRcdFx0aWYgKHJldHJ5SW50ZXJ2YWwpIGNsZWFySW50ZXJ2YWwocmV0cnlJbnRlcnZhbCk7XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChhdHRlbXB0cyA+PSBtYXhBdHRlbXB0cykge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coXG5cdFx0XHRcdFx0XHRcdGBbU1NdIGluc2VydCBmYWlsZWQgYWZ0ZXIgJHthdHRlbXB0c30gYXR0ZW1wdHMgZm9yICR7dmlkZW9JZH1gXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0aWYgKHJldHJ5SW50ZXJ2YWwpIGNsZWFySW50ZXJ2YWwocmV0cnlJbnRlcnZhbCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdC8vIFRyeSBpbW1lZGlhdGVseSwgdGhlbiBhIGZldyB0aW1lcyBhZnRlcndhcmQuXG5cdFx0XHRcdHRyeUluc2VydCgpO1xuXHRcdFx0XHRsZXQgcmV0cnlJbnRlcnZhbDogYW55ID0gMDtcblx0XHRcdFx0cmV0cnlJbnRlcnZhbCA9IHNldEludGVydmFsKHRyeUluc2VydCwgNTAwKTtcblx0XHRcdH0gZWxzZSBpZiAoIXZpZGVvSWQpIHtcblx0XHRcdFx0Ly8gTm90IGEgdmlkZW8gcGFnZSBhbnkgbW9yZTsgcmVtb3ZlIHRoZSBVSSBhbmQgcmVzZXQgc3RhdGUuXG5cdFx0XHRcdGlmIChsYXN0TG9nZ2VkVmlkZW9JZClcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW1NTXSBuYXZpZ2F0aW5nIGF3YXkgZnJvbSB2aWRlbyAke2xhc3RMb2dnZWRWaWRlb0lkfWApO1xuXHRcdFx0XHRsYXN0TG9nZ2VkVmlkZW9JZCA9IFwiXCI7XG5cdFx0XHRcdHJlbW92ZVN1YnNjcmliZWRTaW5jZSgpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEluaXRpYWwgY2hlY2tcblx0XHRtYXliZUxvZygpO1xuXG5cdFx0Ly8gWW91VHViZSBpcyBhIHNpbmdsZS1wYWdlIGFwcDsgd2F0Y2ggZm9yIFVSTCBjaGFuZ2VzIGFuZCByZS1jaGVjay5cblx0XHRsZXQgbGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdGlmIChsb2NhdGlvbi5ocmVmICE9PSBsYXN0SHJlZikge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW1NTXSBVUkwgY2hhbmdlZDogJHtsYXN0SHJlZn0gLT4gJHtsb2NhdGlvbi5ocmVmfWApO1xuXHRcdFx0XHRsYXN0SHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdG1heWJlTG9nKCk7XG5cdFx0XHR9XG5cdFx0fSkub2JzZXJ2ZShkb2N1bWVudCwgeyBzdWJ0cmVlOiB0cnVlLCBjaGlsZExpc3Q6IHRydWUgfSk7XG5cblx0XHQvLyAtLS0gVUkgaW5zZXJ0aW9uIGhlbHBlcnMgLS0tXG5cblx0XHRmdW5jdGlvbiBjcmVhdGVTdWJzY3JpYmVkU2luY2VFbGVtZW50KGRhdGVUZXh0OiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG5cdFx0XHRjb250YWluZXIuaWQgPSBTVUJTQ1JJQkVfVUlfSUQ7XG5cdFx0XHRjb250YWluZXIuc3R5bGUuZGlzcGxheSA9IFwiZmxleFwiO1xuXHRcdFx0Y29udGFpbmVyLnN0eWxlLmZsZXhEaXJlY3Rpb24gPSBcInJvd1wiO1xuXHRcdFx0Y29udGFpbmVyLnN0eWxlLmFsaWduSXRlbXMgPSBcImNlbnRlclwiO1xuXHRcdFx0Y29udGFpbmVyLnN0eWxlLm1hcmdpblRvcCA9IFwiMTJweFwiO1xuXHRcdFx0Y29udGFpbmVyLnN0eWxlLm1hcmdpbkxlZnQgPSBcIi0xNXB4XCI7XG5cdFx0XHRjb250YWluZXIuc3R5bGUuY29sb3IgPSBcInZhcigtLXl0LXNwZWMtdGV4dC1wcmltYXJ5LCAjMDAwKVwiO1xuXHRcdFx0Y29udGFpbmVyLnN0eWxlLmZvbnRGYW1pbHkgPSBcIlJvYm90bywgQXJpYWwsIHNhbnMtc2VyaWZcIjtcblxuXHRcdFx0Ly8gRW1vamkgY29sdW1uXG5cdFx0XHRjb25zdCBlbW9qaUNvbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG5cdFx0XHRlbW9qaUNvbC5zdHlsZS5kaXNwbGF5ID0gXCJmbGV4XCI7XG5cdFx0XHRlbW9qaUNvbC5zdHlsZS5mbGV4RGlyZWN0aW9uID0gXCJjb2x1bW5cIjtcblx0XHRcdGVtb2ppQ29sLnN0eWxlLm1hcmdpblJpZ2h0ID0gXCI1cHhcIjtcblx0XHRcdGVtb2ppQ29sLnN0eWxlLmZvbnRTaXplID0gXCIyOHB4XCI7XG5cdFx0XHRlbW9qaUNvbC50ZXh0Q29udGVudCA9IFwi8J+ThVwiO1xuXG5cdFx0XHQvLyBUZXh0IGNvbHVtblxuXHRcdFx0Y29uc3QgdGV4dENvbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG5cdFx0XHR0ZXh0Q29sLnN0eWxlLmRpc3BsYXkgPSBcImZsZXhcIjtcblx0XHRcdHRleHRDb2wuc3R5bGUuZmxleERpcmVjdGlvbiA9IFwiY29sdW1uXCI7XG5cdFx0XHR0ZXh0Q29sLnN0eWxlLmp1c3RpZnlDb250ZW50ID0gXCJjZW50ZXJcIjtcblx0XHRcdHRleHRDb2wuc3R5bGUuYWxpZ25JdGVtcyA9IFwiZmxleC1zdGFydFwiO1xuXG5cdFx0XHRjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG5cdFx0XHR0aXRsZS50ZXh0Q29udGVudCA9IFwiU3Vic2NyaWJlZCBTaW5jZVwiO1xuXHRcdFx0dGl0bGUuc3R5bGUuZm9udFdlaWdodCA9IFwiNjAwXCI7XG5cdFx0XHR0aXRsZS5zdHlsZS5mb250U2l6ZSA9IFwiMTRweFwiO1xuXG5cdFx0XHRjb25zdCBkYXRlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcblx0XHRcdGRhdGUudGV4dENvbnRlbnQgPSBkYXRlVGV4dDtcblx0XHRcdGRhdGUuc3R5bGUub3BhY2l0eSA9IFwiMC45XCI7XG5cdFx0XHRkYXRlLnN0eWxlLmZvbnRTaXplID0gXCIxNHB4XCI7XG5cblx0XHRcdHRleHRDb2wuYXBwZW5kQ2hpbGQodGl0bGUpO1xuXHRcdFx0dGV4dENvbC5hcHBlbmRDaGlsZChkYXRlKTtcblxuXHRcdFx0Y29udGFpbmVyLmFwcGVuZENoaWxkKGVtb2ppQ29sKTtcblx0XHRcdGNvbnRhaW5lci5hcHBlbmRDaGlsZCh0ZXh0Q29sKTtcblx0XHRcdHJldHVybiBjb250YWluZXI7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaW5zZXJ0U3Vic2NyaWJlZFNpbmNlKGRhdGVUZXh0OiBzdHJpbmcpIHtcblx0XHRcdC8vIEF2b2lkIGR1cGxpY2F0aW5nXG5cdFx0XHRyZW1vdmVTdWJzY3JpYmVkU2luY2UoKTtcblxuXHRcdFx0Ly8gRmluZCB0aGUgb3duZXIgZWxlbWVudCBhbmQgaW5zZXJ0IHJpZ2h0IGFmdGVyIGl0IHNvIHRoZSB0ZXh0IGFwcGVhcnNcblx0XHRcdC8vIGJlbG93IHRoZSBvd25lciBibG9jayAod2hpY2ggdHlwaWNhbGx5IGNvbnRhaW5zIGNoYW5uZWwgbmFtZS9hdmF0YXIpLlxuXHRcdFx0Y29uc3Qgb3duZXJFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwib3duZXJcIik7XG5cdFx0XHRpZiAoIW93bmVyRWwpIHtcblx0XHRcdFx0Y29uc29sZS5sb2coXCJbU1NdIG93bmVyIGVsZW1lbnQgbm90IGZvdW5kXCIpO1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGVsID0gY3JlYXRlU3Vic2NyaWJlZFNpbmNlRWxlbWVudChkYXRlVGV4dCk7XG5cdFx0XHRcdG93bmVyRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KFwiYWZ0ZXJlbmRcIiwgZWwpO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhcblx0XHRcdFx0XHRgW1NTXSBpbnNlcnRlZCBzdWJzY3JpYmVkLXNpbmNlIGVsZW1lbnQgYWZ0ZXIgI293bmVyICh0YWc9JHtcblx0XHRcdFx0XHRcdG93bmVyRWwudGFnTmFtZVxuXHRcdFx0XHRcdH0sIGlkPSR7b3duZXJFbC5pZCB8fCBcIjxub25lPlwifSlgXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fSBjYXRjaCAoZSkge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhcIltTU10gZXJyb3IgaW5zZXJ0aW5nIHN1YnNjcmliZWQtc2luY2UgZWxlbWVudFwiLCBlKTtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHJlbW92ZVN1YnNjcmliZWRTaW5jZSgpIHtcblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoU1VCU0NSSUJFX1VJX0lEKTtcblx0XHRcdGlmIChleGlzdGluZyAmJiBleGlzdGluZy5wYXJlbnROb2RlKSB7XG5cdFx0XHRcdGV4aXN0aW5nLnJlbW92ZSgpO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhcIltTU10gcmVtb3ZlZCBzdWJzY3JpYmVkLXNpbmNlIGVsZW1lbnRcIik7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhcIltTU10gc3Vic2NyaWJlZC1zaW5jZSBlbGVtZW50IG5vdCBwcmVzZW50XCIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSxcbn0pO1xuIiwiLy8gI3JlZ2lvbiBzbmlwcGV0XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IGdsb2JhbFRoaXMuYnJvd3Nlcj8ucnVudGltZT8uaWRcbiAgPyBnbG9iYWxUaGlzLmJyb3dzZXJcbiAgOiBnbG9iYWxUaGlzLmNocm9tZTtcbi8vICNlbmRyZWdpb24gc25pcHBldFxuIiwiaW1wb3J0IHsgYnJvd3NlciBhcyBfYnJvd3NlciB9IGZyb20gXCJAd3h0LWRldi9icm93c2VyXCI7XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IF9icm93c2VyO1xuZXhwb3J0IHt9O1xuIiwiZnVuY3Rpb24gcHJpbnQobWV0aG9kLCAuLi5hcmdzKSB7XG4gIGlmIChpbXBvcnQubWV0YS5lbnYuTU9ERSA9PT0gXCJwcm9kdWN0aW9uXCIpIHJldHVybjtcbiAgaWYgKHR5cGVvZiBhcmdzWzBdID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGFyZ3Muc2hpZnQoKTtcbiAgICBtZXRob2QoYFt3eHRdICR7bWVzc2FnZX1gLCAuLi5hcmdzKTtcbiAgfSBlbHNlIHtcbiAgICBtZXRob2QoXCJbd3h0XVwiLCAuLi5hcmdzKTtcbiAgfVxufVxuZXhwb3J0IGNvbnN0IGxvZ2dlciA9IHtcbiAgZGVidWc6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmRlYnVnLCAuLi5hcmdzKSxcbiAgbG9nOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5sb2csIC4uLmFyZ3MpLFxuICB3YXJuOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS53YXJuLCAuLi5hcmdzKSxcbiAgZXJyb3I6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmVycm9yLCAuLi5hcmdzKVxufTtcbiIsImltcG9ydCB7IGJyb3dzZXIgfSBmcm9tIFwid3h0L2Jyb3dzZXJcIjtcbmV4cG9ydCBjbGFzcyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IGV4dGVuZHMgRXZlbnQge1xuICBjb25zdHJ1Y3RvcihuZXdVcmwsIG9sZFVybCkge1xuICAgIHN1cGVyKFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQuRVZFTlRfTkFNRSwge30pO1xuICAgIHRoaXMubmV3VXJsID0gbmV3VXJsO1xuICAgIHRoaXMub2xkVXJsID0gb2xkVXJsO1xuICB9XG4gIHN0YXRpYyBFVkVOVF9OQU1FID0gZ2V0VW5pcXVlRXZlbnROYW1lKFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGdldFVuaXF1ZUV2ZW50TmFtZShldmVudE5hbWUpIHtcbiAgcmV0dXJuIGAke2Jyb3dzZXI/LnJ1bnRpbWU/LmlkfToke2ltcG9ydC5tZXRhLmVudi5FTlRSWVBPSU5UfToke2V2ZW50TmFtZX1gO1xufVxuIiwiaW1wb3J0IHsgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCB9IGZyb20gXCIuL2N1c3RvbS1ldmVudHMubWpzXCI7XG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTG9jYXRpb25XYXRjaGVyKGN0eCkge1xuICBsZXQgaW50ZXJ2YWw7XG4gIGxldCBvbGRVcmw7XG4gIHJldHVybiB7XG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBsb2NhdGlvbiB3YXRjaGVyIGlzIGFjdGl2ZWx5IGxvb2tpbmcgZm9yIFVSTCBjaGFuZ2VzLiBJZiBpdCdzIGFscmVhZHkgd2F0Y2hpbmcsXG4gICAgICogdGhpcyBpcyBhIG5vb3AuXG4gICAgICovXG4gICAgcnVuKCkge1xuICAgICAgaWYgKGludGVydmFsICE9IG51bGwpIHJldHVybjtcbiAgICAgIG9sZFVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgICBpbnRlcnZhbCA9IGN0eC5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGxldCBuZXdVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgICAgICBpZiAobmV3VXJsLmhyZWYgIT09IG9sZFVybC5ocmVmKSB7XG4gICAgICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQobmV3VXJsLCBvbGRVcmwpKTtcbiAgICAgICAgICBvbGRVcmwgPSBuZXdVcmw7XG4gICAgICAgIH1cbiAgICAgIH0sIDFlMyk7XG4gICAgfVxuICB9O1xufVxuIiwiaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSBcIi4uL3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanNcIjtcbmltcG9ydCB7XG4gIGdldFVuaXF1ZUV2ZW50TmFtZVxufSBmcm9tIFwiLi9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlTG9jYXRpb25XYXRjaGVyIH0gZnJvbSBcIi4vaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanNcIjtcbmV4cG9ydCBjbGFzcyBDb250ZW50U2NyaXB0Q29udGV4dCB7XG4gIGNvbnN0cnVjdG9yKGNvbnRlbnRTY3JpcHROYW1lLCBvcHRpb25zKSB7XG4gICAgdGhpcy5jb250ZW50U2NyaXB0TmFtZSA9IGNvbnRlbnRTY3JpcHROYW1lO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gICAgdGhpcy5hYm9ydENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgaWYgKHRoaXMuaXNUb3BGcmFtZSkge1xuICAgICAgdGhpcy5saXN0ZW5Gb3JOZXdlclNjcmlwdHMoeyBpZ25vcmVGaXJzdEV2ZW50OiB0cnVlIH0pO1xuICAgICAgdGhpcy5zdG9wT2xkU2NyaXB0cygpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cygpO1xuICAgIH1cbiAgfVxuICBzdGF0aWMgU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFID0gZ2V0VW5pcXVlRXZlbnROYW1lKFxuICAgIFwid3h0OmNvbnRlbnQtc2NyaXB0LXN0YXJ0ZWRcIlxuICApO1xuICBpc1RvcEZyYW1lID0gd2luZG93LnNlbGYgPT09IHdpbmRvdy50b3A7XG4gIGFib3J0Q29udHJvbGxlcjtcbiAgbG9jYXRpb25XYXRjaGVyID0gY3JlYXRlTG9jYXRpb25XYXRjaGVyKHRoaXMpO1xuICByZWNlaXZlZE1lc3NhZ2VJZHMgPSAvKiBAX19QVVJFX18gKi8gbmV3IFNldCgpO1xuICBnZXQgc2lnbmFsKCkge1xuICAgIHJldHVybiB0aGlzLmFib3J0Q29udHJvbGxlci5zaWduYWw7XG4gIH1cbiAgYWJvcnQocmVhc29uKSB7XG4gICAgcmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLmFib3J0KHJlYXNvbik7XG4gIH1cbiAgZ2V0IGlzSW52YWxpZCgpIHtcbiAgICBpZiAoYnJvd3Nlci5ydW50aW1lLmlkID09IG51bGwpIHtcbiAgICAgIHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuc2lnbmFsLmFib3J0ZWQ7XG4gIH1cbiAgZ2V0IGlzVmFsaWQoKSB7XG4gICAgcmV0dXJuICF0aGlzLmlzSW52YWxpZDtcbiAgfVxuICAvKipcbiAgICogQWRkIGEgbGlzdGVuZXIgdGhhdCBpcyBjYWxsZWQgd2hlbiB0aGUgY29udGVudCBzY3JpcHQncyBjb250ZXh0IGlzIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBAcmV0dXJucyBBIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoY2IpO1xuICAgKiBjb25zdCByZW1vdmVJbnZhbGlkYXRlZExpc3RlbmVyID0gY3R4Lm9uSW52YWxpZGF0ZWQoKCkgPT4ge1xuICAgKiAgIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIoY2IpO1xuICAgKiB9KVxuICAgKiAvLyAuLi5cbiAgICogcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lcigpO1xuICAgKi9cbiAgb25JbnZhbGlkYXRlZChjYikge1xuICAgIHRoaXMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG4gICAgcmV0dXJuICgpID0+IHRoaXMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG4gIH1cbiAgLyoqXG4gICAqIFJldHVybiBhIHByb21pc2UgdGhhdCBuZXZlciByZXNvbHZlcy4gVXNlZnVsIGlmIHlvdSBoYXZlIGFuIGFzeW5jIGZ1bmN0aW9uIHRoYXQgc2hvdWxkbid0IHJ1blxuICAgKiBhZnRlciB0aGUgY29udGV4dCBpcyBleHBpcmVkLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBjb25zdCBnZXRWYWx1ZUZyb21TdG9yYWdlID0gYXN5bmMgKCkgPT4ge1xuICAgKiAgIGlmIChjdHguaXNJbnZhbGlkKSByZXR1cm4gY3R4LmJsb2NrKCk7XG4gICAqXG4gICAqICAgLy8gLi4uXG4gICAqIH1cbiAgICovXG4gIGJsb2NrKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgoKSA9PiB7XG4gICAgfSk7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0SW50ZXJ2YWxgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIEludGVydmFscyBjYW4gYmUgY2xlYXJlZCBieSBjYWxsaW5nIHRoZSBub3JtYWwgYGNsZWFySW50ZXJ2YWxgIGZ1bmN0aW9uLlxuICAgKi9cbiAgc2V0SW50ZXJ2YWwoaGFuZGxlciwgdGltZW91dCkge1xuICAgIGNvbnN0IGlkID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuICAgIH0sIHRpbWVvdXQpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhckludGVydmFsKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIC8qKlxuICAgKiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnNldFRpbWVvdXRgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIFRpbWVvdXRzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgc2V0VGltZW91dGAgZnVuY3Rpb24uXG4gICAqL1xuICBzZXRUaW1lb3V0KGhhbmRsZXIsIHRpbWVvdXQpIHtcbiAgICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuICAgIH0sIHRpbWVvdXQpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhclRpbWVvdXQoaWQpKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG4gICAqIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsQW5pbWF0aW9uRnJhbWVgIGZ1bmN0aW9uLlxuICAgKi9cbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgaWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKC4uLmFyZ3MpID0+IHtcbiAgICAgIGlmICh0aGlzLmlzVmFsaWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuICAgIH0pO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxBbmltYXRpb25GcmFtZShpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0SWRsZUNhbGxiYWNrYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG4gICAqIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsSWRsZUNhbGxiYWNrYCBmdW5jdGlvbi5cbiAgICovXG4gIHJlcXVlc3RJZGxlQ2FsbGJhY2soY2FsbGJhY2ssIG9wdGlvbnMpIHtcbiAgICBjb25zdCBpZCA9IHJlcXVlc3RJZGxlQ2FsbGJhY2soKC4uLmFyZ3MpID0+IHtcbiAgICAgIGlmICghdGhpcy5zaWduYWwuYWJvcnRlZCkgY2FsbGJhY2soLi4uYXJncyk7XG4gICAgfSwgb3B0aW9ucyk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNhbmNlbElkbGVDYWxsYmFjayhpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICBhZGRFdmVudExpc3RlbmVyKHRhcmdldCwgdHlwZSwgaGFuZGxlciwgb3B0aW9ucykge1xuICAgIGlmICh0eXBlID09PSBcInd4dDpsb2NhdGlvbmNoYW5nZVwiKSB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSB0aGlzLmxvY2F0aW9uV2F0Y2hlci5ydW4oKTtcbiAgICB9XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXI/LihcbiAgICAgIHR5cGUuc3RhcnRzV2l0aChcInd4dDpcIikgPyBnZXRVbmlxdWVFdmVudE5hbWUodHlwZSkgOiB0eXBlLFxuICAgICAgaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgc2lnbmFsOiB0aGlzLnNpZ25hbFxuICAgICAgfVxuICAgICk7XG4gIH1cbiAgLyoqXG4gICAqIEBpbnRlcm5hbFxuICAgKiBBYm9ydCB0aGUgYWJvcnQgY29udHJvbGxlciBhbmQgZXhlY3V0ZSBhbGwgYG9uSW52YWxpZGF0ZWRgIGxpc3RlbmVycy5cbiAgICovXG4gIG5vdGlmeUludmFsaWRhdGVkKCkge1xuICAgIHRoaXMuYWJvcnQoXCJDb250ZW50IHNjcmlwdCBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xuICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgIGBDb250ZW50IHNjcmlwdCBcIiR7dGhpcy5jb250ZW50U2NyaXB0TmFtZX1cIiBjb250ZXh0IGludmFsaWRhdGVkYFxuICAgICk7XG4gIH1cbiAgc3RvcE9sZFNjcmlwdHMoKSB7XG4gICAgd2luZG93LnBvc3RNZXNzYWdlKFxuICAgICAge1xuICAgICAgICB0eXBlOiBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUsXG4gICAgICAgIGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuICAgICAgICBtZXNzYWdlSWQ6IE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpXG4gICAgICB9LFxuICAgICAgXCIqXCJcbiAgICApO1xuICB9XG4gIHZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkge1xuICAgIGNvbnN0IGlzU2NyaXB0U3RhcnRlZEV2ZW50ID0gZXZlbnQuZGF0YT8udHlwZSA9PT0gQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFO1xuICAgIGNvbnN0IGlzU2FtZUNvbnRlbnRTY3JpcHQgPSBldmVudC5kYXRhPy5jb250ZW50U2NyaXB0TmFtZSA9PT0gdGhpcy5jb250ZW50U2NyaXB0TmFtZTtcbiAgICBjb25zdCBpc05vdER1cGxpY2F0ZSA9ICF0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5oYXMoZXZlbnQuZGF0YT8ubWVzc2FnZUlkKTtcbiAgICByZXR1cm4gaXNTY3JpcHRTdGFydGVkRXZlbnQgJiYgaXNTYW1lQ29udGVudFNjcmlwdCAmJiBpc05vdER1cGxpY2F0ZTtcbiAgfVxuICBsaXN0ZW5Gb3JOZXdlclNjcmlwdHMob3B0aW9ucykge1xuICAgIGxldCBpc0ZpcnN0ID0gdHJ1ZTtcbiAgICBjb25zdCBjYiA9IChldmVudCkgPT4ge1xuICAgICAgaWYgKHRoaXMudmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSkge1xuICAgICAgICB0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5hZGQoZXZlbnQuZGF0YS5tZXNzYWdlSWQpO1xuICAgICAgICBjb25zdCB3YXNGaXJzdCA9IGlzRmlyc3Q7XG4gICAgICAgIGlzRmlyc3QgPSBmYWxzZTtcbiAgICAgICAgaWYgKHdhc0ZpcnN0ICYmIG9wdGlvbnM/Lmlnbm9yZUZpcnN0RXZlbnQpIHJldHVybjtcbiAgICAgICAgdGhpcy5ub3RpZnlJbnZhbGlkYXRlZCgpO1xuICAgICAgfVxuICAgIH07XG4gICAgYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgY2IpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiByZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYikpO1xuICB9XG59XG4iXSwibmFtZXMiOlsiZGVmaW5pdGlvbiIsImJyb3dzZXIiLCJfYnJvd3NlciIsInByaW50IiwibG9nZ2VyIl0sIm1hcHBpbmdzIjoiOztBQUFPLFdBQVMsb0JBQW9CQSxhQUFZO0FBQzlDLFdBQU9BO0FBQUEsRUFDVDtBQ0ZBLFFBQUEsYUFBQSxvQkFBQTtBQUFBLElBQW1DLFNBQUEsQ0FBQSxxQkFBQTtBQUFBLElBQ0gsT0FBQTtBQXVCOUIsVUFBQSxvQkFBQTtBQUlBLFlBQUEsa0JBQUE7QUFFQSxlQUFBLGtCQUFBLEtBQUE7QUFDQyxZQUFBO0FBQ0MsZ0JBQUEsSUFBQSxJQUFBLElBQUEsR0FBQTtBQUNBLGdCQUFBLE9BQUEsRUFBQSxTQUFBLFlBQUE7QUFDQSxjQUFBLEtBQUEsU0FBQSxhQUFBLEtBQUEsRUFBQSxhQUFBLFVBQUE7QUFDQyxtQkFBQSxFQUFBLGFBQUEsSUFBQSxHQUFBO0FBQUEsVUFBNkI7QUFFOUIsY0FBQSxTQUFBLFlBQUE7QUFDQyxtQkFBQSxFQUFBLFNBQUEsTUFBQSxDQUFBLEtBQUE7QUFBQSxVQUE4QjtBQUUvQixpQkFBQTtBQUFBLFFBQU8sU0FBQSxHQUFBO0FBRVAsaUJBQUE7QUFBQSxRQUFPO0FBQUEsTUFDUjtBQUdELGVBQUEsV0FBQTtBQUNDLGNBQUEsVUFBQSxrQkFBQSxPQUFBLFNBQUEsSUFBQTtBQUNBLGdCQUFBLElBQUEsdUJBQUEsU0FBQSxJQUFBLGFBQUEsT0FBQSxFQUFBO0FBRUEsWUFBQSxXQUFBLFlBQUEsbUJBQUE7QUFDQyxrQkFBQSxJQUFBLDRCQUFBLE9BQUEsRUFBQTtBQUNBLDhCQUFBO0FBSUEsZ0JBQUEsV0FBQTtBQUNBLGNBQUEsV0FBQTtBQUNBLGdCQUFBLGNBQUE7QUFFQSxnQkFBQSxZQUFBLE1BQUE7QUFDQyx3QkFBQTtBQUNBLG9CQUFBLElBQUEsdUJBQUEsUUFBQSxRQUFBLE9BQUEsRUFBQTtBQUNBLGdCQUFBLHNCQUFBLFFBQUEsR0FBQTtBQUNDLHNCQUFBLElBQUEsNkJBQUEsT0FBQSxFQUFB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SUFBSSxTQUFTO0FBQzFDLFlBQUksQ0FBQyxLQUFLLE9BQU8sUUFBUyxVQUFTLEdBQUcsSUFBSTtBQUFBLE1BQzVDLEdBQUcsT0FBTztBQUNWLFdBQUssY0FBYyxNQUFNLG1CQUFtQixFQUFFLENBQUM7QUFDL0MsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLGlCQUFpQixRQUFRLE1BQU0sU0FBUyxTQUFTO0FBQy9DLFVBQUksU0FBUyxzQkFBc0I7QUFDakMsWUFBSSxLQUFLLFFBQVMsTUFBSyxnQkFBZ0IsSUFBRztBQUFBLE1BQzVDO0FBQ0EsYUFBTztBQUFBLFFBQ0wsS0FBSyxXQUFXLE1BQU0sSUFBSSxtQkFBbUIsSUFBSSxJQUFJO0FBQUEsUUFDckQ7QUFBQSxRQUNBO0FBQUEsVUFDRSxHQUFHO0FBQUEsVUFDSCxRQUFRLEtBQUs7QUFBQSxRQUNyQjtBQUFBLE1BQ0E7QUFBQSxJQUNFO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtBLG9CQUFvQjtBQUNsQixXQUFLLE1BQU0sb0NBQW9DO0FBQy9DQyxlQUFPO0FBQUEsUUFDTCxtQkFBbUIsS0FBSyxpQkFBaUI7QUFBQSxNQUMvQztBQUFBLElBQ0U7QUFBQSxJQUNBLGlCQUFpQjtBQUNmLGFBQU87QUFBQSxRQUNMO0FBQUEsVUFDRSxNQUFNLHFCQUFxQjtBQUFBLFVBQzNCLG1CQUFtQixLQUFLO0FBQUEsVUFDeEIsV0FBVyxLQUFLLE9BQU0sRUFBRyxTQUFTLEVBQUUsRUFBRSxNQUFNLENBQUM7QUFBQSxRQUNyRDtBQUFBLFFBQ007QUFBQSxNQUNOO0FBQUEsSUFDRTtBQUFBLElBQ0EseUJBQXlCLE9BQU87QUFDOUIsWUFBTSx1QkFBdUIsTUFBTSxNQUFNLFNBQVMscUJBQXFCO0FBQ3ZFLFlBQU0sc0JBQXNCLE1BQU0sTUFBTSxzQkFBc0IsS0FBSztBQUNuRSxZQUFNLGlCQUFpQixDQUFDLEtBQUssbUJBQW1CLElBQUksTUFBTSxNQUFNLFNBQVM7QUFDekUsYUFBTyx3QkFBd0IsdUJBQXVCO0FBQUEsSUFDeEQ7QUFBQSxJQUNBLHNCQUFzQixTQUFTO0FBQzdCLFVBQUksVUFBVTtBQUNkLFlBQU0sS0FBSyxDQUFDLFVBQVU7QUFDcEIsWUFBSSxLQUFLLHlCQUF5QixLQUFLLEdBQUc7QUFDeEMsZUFBSyxtQkFBbUIsSUFBSSxNQUFNLEtBQUssU0FBUztBQUNoRCxnQkFBTSxXQUFXO0FBQ2pCLG9CQUFVO0FBQ1YsY0FBSSxZQUFZLFNBQVMsaUJBQWtCO0FBQzNDLGVBQUssa0JBQWlCO0FBQUEsUUFDeEI7QUFBQSxNQUNGO0FBQ0EsdUJBQWlCLFdBQVcsRUFBRTtBQUM5QixXQUFLLGNBQWMsTUFBTSxvQkFBb0IsV0FBVyxFQUFFLENBQUM7QUFBQSxJQUM3RDtBQUFBLEVBQ0Y7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OzsiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMCwyLDMsNCw1LDYsN119
content;