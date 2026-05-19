var content = (function() {
  "use strict";
  function defineContentScript(definition2) {
    return definition2;
  }
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  const CACHE_STORAGE_KEY = "ss-cache-state";
  const BADGE_ID = "ss-subscribed-since";
  const STYLE_ID = "ss-subscribed-since-style";
  const CHANNEL_ID_RE = /UC[\w-]{20,}/;
  const DOM_RENDER_DEBOUNCE_MS = 350;
  const PAGE_CONTEXT_MESSAGE_SOURCE = "ss-subscribed-since";
  const PAGE_CONTEXT_REQUEST_TYPE = "SS_GET_PAGE_CONTEXT_CHANNEL_ID";
  const PAGE_CONTEXT_RESPONSE_TYPE = "SS_PAGE_CONTEXT_CHANNEL_ID";
  const PAGE_CONTEXT_SCRIPT_ID = "ss-page-context-channel-reader";
  const NAVIGATION_RENDER_WINDOW_MS = 1e4;
  const NAVIGATION_RENDER_INTERVAL_MS = 500;
  const NAVIGATION_SETTLE_DELAY_MS = 650;
  const PAGE_WATCHDOG_INTERVAL_MS = 5e3;
  const MS_PER_DAY = 24 * 60 * 60 * 1e3;
  const definition = defineContentScript({
    matches: ["*://*.youtube.com/*"],
    main() {
      let lastPageKey = "";
      let lastNoSubscriptionPageKey = "";
      let resolvedBadge;
      let renderRequestId = 0;
      let notificationObserver;
      let renderTimer;
      let readinessTimer;
      let navigationRenderTimer;
      let subscribeRetryTimer;
      let subscribeChangeTimer;
      let badgeRetryTimer;
      let pageWatchdogTimer;
      let navigationObserver;
      let readinessObserver;
      let navigationSettlingUntil = 0;
      let isActive = true;
      installStyles();
      startNavigationRenderLoop(false);
      startPageWatchdog();
      observeYouTubeNavigation();
      observePageReadiness();
      observeCacheChanges();
      observeSubscribeButtonChanges();
      function observeYouTubeNavigation() {
        let lastHref = location.href;
        const handleNavigation = (clearBadge) => {
          if (!isActive) {
            return;
          }
          if (location.href !== lastHref) {
            lastHref = location.href;
            startNavigationRenderLoop(clearBadge);
            observeSubscribeButtonChanges();
          }
        };
        document.addEventListener("yt-navigate-start", () => {
          startNavigationRenderLoop(true);
        });
        document.addEventListener("yt-navigate-finish", () => {
          lastHref = location.href;
          startNavigationRenderLoop(true);
          observeSubscribeButtonChanges();
        });
        document.addEventListener("yt-page-data-updated", () => {
          startNavigationRenderLoop(false);
        });
        window.addEventListener("popstate", () => {
          startNavigationRenderLoop(true);
        });
        window.addEventListener("focus", () => {
          startNavigationRenderLoop(false);
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            startNavigationRenderLoop(false);
          }
        });
        navigationObserver = new MutationObserver(() => {
          handleNavigation(true);
        });
        navigationObserver.observe(document, { subtree: true, childList: true });
      }
      function observePageReadiness() {
        readinessObserver = new MutationObserver(() => {
          if (!isActive) {
            return;
          }
          if (!isSupportedYouTubePage()) {
            return;
          }
          if (readinessTimer) {
            clearTimeout(readinessTimer);
          }
          readinessTimer = setTimeout(() => {
            const badge = document.getElementById(BADGE_ID);
            const channelId = findCurrentChannelIdFromDom();
            if (!badge || !channelId || badge.dataset.ssChannelId !== channelId || badge.dataset.ssHref !== location.href || !findBadgeTarget(false)) {
              scheduleRender();
            }
          }, DOM_RENDER_DEBOUNCE_MS);
        });
        readinessObserver.observe(document, { subtree: true, childList: true });
      }
      function startPageWatchdog() {
        let lastObservedHref = location.href;
        pageWatchdogTimer = setInterval(() => {
          if (!isActive) {
            return;
          }
          if (location.href !== lastObservedHref) {
            lastObservedHref = location.href;
            startNavigationRenderLoop(true);
            observeSubscribeButtonChanges();
            return;
          }
          if (document.visibilityState === "hidden" || !isSupportedYouTubePage()) {
            return;
          }
          const badge = document.getElementById(BADGE_ID);
          if (!hasConfirmedNoSubscriptionForCurrentHref() && (!badge || badge.dataset.ssHref !== location.href || !findBadgeTarget(false))) {
            scheduleRender();
          }
        }, PAGE_WATCHDOG_INTERVAL_MS);
      }
      function hasConfirmedNoSubscriptionForCurrentHref() {
        return lastNoSubscriptionPageKey.startsWith(`${location.href}|`);
      }
      function observeCacheChanges() {
        browser.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === "local" && CACHE_STORAGE_KEY in changes) {
            lastPageKey = "";
            lastNoSubscriptionPageKey = "";
            resolvedBadge = void 0;
            scheduleRender();
          }
        });
      }
      function observeSubscribeButtonChanges() {
        if (!isActive) {
          return;
        }
        notificationObserver?.disconnect();
        const target = findSubscribeSurface();
        if (!target) {
          if (subscribeRetryTimer) {
            clearTimeout(subscribeRetryTimer);
          }
          subscribeRetryTimer = setTimeout(observeSubscribeButtonChanges, 1e3);
          return;
        }
        let lastText = getSubscribeSurfaceText();
        notificationObserver = new MutationObserver(() => {
          if (!isActive) {
            return;
          }
          const nextText = getSubscribeSurfaceText();
          if (nextText === lastText) {
            return;
          }
          lastText = nextText;
          lastPageKey = "";
          lastNoSubscriptionPageKey = "";
          resolvedBadge = void 0;
          void sendRuntimeMessage({
            type: "SS_VISIBLE_SUBSCRIPTION_CHANGED"
          });
          subscribeChangeTimer = setTimeout(scheduleRender, 3500);
        });
        notificationObserver.observe(target, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-label", "title"]
        });
      }
      function scheduleRender(delay = 250) {
        if (!isActive) {
          return;
        }
        if (renderTimer) {
          clearTimeout(renderTimer);
        }
        const navigationSettleDelay = Math.max(0, navigationSettlingUntil - Date.now());
        renderTimer = setTimeout(() => {
          void renderForCurrentPage();
        }, Math.max(delay, navigationSettleDelay));
      }
      function startNavigationRenderLoop(clearBadge) {
        if (!isActive) {
          return;
        }
        lastPageKey = "";
        lastNoSubscriptionPageKey = "";
        resolvedBadge = void 0;
        if (clearBadge) {
          navigationSettlingUntil = Date.now() + NAVIGATION_SETTLE_DELAY_MS;
          removeStaleBadge();
        }
        if (navigationRenderTimer) {
          clearInterval(navigationRenderTimer);
        }
        const stopAt = Date.now() + NAVIGATION_RENDER_WINDOW_MS;
        scheduleRender();
        navigationRenderTimer = setInterval(() => {
          if (Date.now() > stopAt) {
            if (navigationRenderTimer) {
              clearInterval(navigationRenderTimer);
              navigationRenderTimer = void 0;
            }
            return;
          }
          scheduleRender();
        }, NAVIGATION_RENDER_INTERVAL_MS);
      }
      async function renderForCurrentPage() {
        if (!isActive) {
          return;
        }
        try {
          const requestId = ++renderRequestId;
          const channelId = await findCurrentChannelId();
          const pageKey = `${location.href}|${channelId ?? "none"}`;
          if (!isActive) {
            return;
          }
          if (!isSupportedYouTubePage()) {
            lastPageKey = pageKey;
            removeBadge();
            return;
          }
          const existingBadge = document.getElementById(BADGE_ID);
          if (!channelId) {
            lastPageKey = pageKey;
            if (existingBadge?.dataset.ssHref !== location.href) {
              removeBadge();
            }
            return;
          }
          if (lastPageKey === pageKey && existingBadge?.dataset.ssPageKey === pageKey && existingBadge.dataset.ssHref === location.href) {
            return;
          }
          lastPageKey = pageKey;
          if (resolvedBadge?.pageKey === pageKey) {
            insertBadge({
              channelId,
              tenure: resolvedBadge.tenure,
              dateText: resolvedBadge.dateText,
              pageKey
            });
            return;
          }
          if (lastNoSubscriptionPageKey === pageKey) {
            return;
          }
          const response = await sendRuntimeMessage({
            type: "SS_GET_STATUS",
            channelId
          });
          if (!response || requestId !== renderRequestId || !isActive) {
            return;
          }
          if (!isStatusResponse(response) || !response.ok || !response.subscription) {
            lastNoSubscriptionPageKey = pageKey;
            resolvedBadge = void 0;
            removeBadge();
            return;
          }
          lastNoSubscriptionPageKey = "";
          resolvedBadge = {
            pageKey,
            tenure: getSubscriptionTenure(response.subscription.subscribedAt),
            dateText: formatDate(response.subscription.subscribedAt)
          };
          insertBadge({
            channelId,
            tenure: resolvedBadge.tenure,
            dateText: resolvedBadge.dateText,
            pageKey
          });
        } catch (error) {
          handleExtensionError(error);
        }
      }
      function insertBadge({
        channelId,
        tenure,
        dateText,
        pageKey
      }) {
        if (!isActive) {
          return;
        }
        const target = findBadgeTarget();
        if (!target) {
          if (badgeRetryTimer) {
            clearTimeout(badgeRetryTimer);
          }
          badgeRetryTimer = setTimeout(scheduleRender, 500);
          return;
        }
        const existing = document.getElementById(BADGE_ID);
        if (existing?.parentElement === target) {
          existing.dataset.ssChannelId = channelId;
          existing.dataset.ssHref = location.href;
          existing.dataset.ssPageKey = pageKey;
          existing.setAttribute(
            "aria-label",
            `Subscribed since ${dateText}, ${formatTenure(tenure)}`
          );
          existing.querySelector("[data-ss-tenure]").textContent = formatTenureMark(tenure);
          existing.querySelector("[data-ss-date]").textContent = dateText;
          return;
        }
        removeBadge();
        target.appendChild(createBadge({ channelId, tenure, dateText, pageKey }));
      }
      async function sendRuntimeMessage(message) {
        if (!isActive) {
          return;
        }
        try {
          return await browser.runtime.sendMessage(message);
        } catch (error) {
          handleExtensionError(error);
        }
      }
      function handleExtensionError(error) {
        if (isExtensionContextInvalidatedError(error)) {
          stopContentScript();
        }
      }
      function stopContentScript() {
        if (!isActive) {
          return;
        }
        isActive = false;
        renderRequestId += 1;
        notificationObserver?.disconnect();
        navigationObserver?.disconnect();
        readinessObserver?.disconnect();
        clearManagedTimers();
        removeBadge();
      }
      function clearManagedTimers() {
        if (renderTimer) {
          clearTimeout(renderTimer);
        }
        if (readinessTimer) {
          clearTimeout(readinessTimer);
        }
        if (subscribeRetryTimer) {
          clearTimeout(subscribeRetryTimer);
        }
        if (subscribeChangeTimer) {
          clearTimeout(subscribeChangeTimer);
        }
        if (badgeRetryTimer) {
          clearTimeout(badgeRetryTimer);
        }
        if (navigationRenderTimer) {
          clearInterval(navigationRenderTimer);
        }
        if (pageWatchdogTimer) {
          clearInterval(pageWatchdogTimer);
        }
      }
    }
  });
  function isSupportedYouTubePage() {
    return isChannelPage();
  }
  function isChannelPage(path = location.pathname) {
    return path.startsWith("/@") || path.startsWith("/channel/") || path.startsWith("/c/") || path.startsWith("/user/");
  }
  async function findCurrentChannelId() {
    const path = location.pathname;
    const pathChannelId = matchChannelId(path);
    if (pathChannelId) {
      return pathChannelId;
    }
    if (!isChannelPage(path)) {
      return void 0;
    }
    return await findCurrentChannelIdFromPageContext() ?? findCurrentChannelIdFromDom();
  }
  function findCurrentChannelIdFromDom() {
    const channelSelectors = [
      "ytd-browse[page-subtype='channels'] meta[itemprop='channelId']",
      "ytd-browse[page-subtype='channels'] ytd-page-header-renderer a[href*='/channel/']",
      "ytd-browse[page-subtype='channels'] yt-page-header-view-model a[href*='/channel/']",
      "ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer a[href*='/channel/']",
      "ytd-browse[page-subtype='channels'] #channel-header a[href*='/channel/']",
      "ytd-browse[page-subtype='channels'] #page-header a[href*='/channel/']",
      "meta[itemprop='channelId']",
      "link[rel='canonical']",
      "link[itemprop='url']"
    ];
    for (const selector of channelSelectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute("content") ?? element?.getAttribute("href") ?? element?.textContent;
      const channelId = matchChannelId(value);
      if (channelId) {
        return channelId;
      }
    }
    const browse = document.querySelector("ytd-browse[page-subtype='channels']");
    const headerChannelId = matchChannelId(
      browse?.querySelector(
        "ytd-page-header-renderer, yt-page-header-view-model, ytd-c4-tabbed-header-renderer, #channel-header, #page-header"
      )?.innerHTML
    );
    if (headerChannelId) {
      return headerChannelId;
    }
  }
  function matchChannelId(value) {
    return value?.match(CHANNEL_ID_RE)?.[0];
  }
  function findCurrentChannelIdFromPageContext() {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      injectPageContextChannelIdReader();
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(void 0);
      }, 300);
      function onMessage(event) {
        if (event.source !== window) {
          return;
        }
        const data = event.data;
        if (data?.source !== PAGE_CONTEXT_MESSAGE_SOURCE || data.type !== PAGE_CONTEXT_RESPONSE_TYPE || data.requestId !== requestId) {
          return;
        }
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(matchChannelId(data.channelId));
      }
      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          source: PAGE_CONTEXT_MESSAGE_SOURCE,
          type: PAGE_CONTEXT_REQUEST_TYPE,
          requestId
        },
        window.location.origin
      );
    });
  }
  function injectPageContextChannelIdReader() {
    if (document.getElementById(PAGE_CONTEXT_SCRIPT_ID)) {
      return;
    }
    const script = document.createElement("script");
    script.id = PAGE_CONTEXT_SCRIPT_ID;
    script.src = browser.runtime.getURL("/page-context-channel.js");
    document.documentElement.appendChild(script);
  }
  function isExtensionContextInvalidatedError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("extension context invalidated");
  }
  function findBadgeTarget(markHost = true) {
    const channelCandidates = [
      "ytd-browse[page-subtype='channels'] ytd-page-header-renderer #buttons",
      "ytd-browse[page-subtype='channels'] ytd-page-header-renderer yt-flexible-actions-view-model",
      "ytd-browse[page-subtype='channels'] yt-page-header-view-model yt-flexible-actions-view-model",
      "ytd-browse[page-subtype='channels'] yt-page-header-view-model #buttons",
      "ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer #buttons",
      "ytd-browse[page-subtype='channels'] #channel-header #buttons",
      "ytd-browse[page-subtype='channels'] #page-header #buttons"
    ];
    for (const selector of channelCandidates) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        if (markHost) {
          element.classList.add("ss-badge-host");
        }
        return element;
      }
    }
    const subscribeSurface = findSubscribeSurface();
    const target = subscribeSurface?.closest(
      "yt-flexible-actions-view-model, #buttons, #subscribe-button"
    ) ?? subscribeSurface?.parentElement ?? void 0;
    if (target && markHost) {
      target.classList.add("ss-badge-host");
    }
    return target;
  }
  function createBadge({
    channelId,
    tenure,
    dateText,
    pageKey
  }) {
    const container = document.createElement("div");
    container.id = BADGE_ID;
    container.dataset.ssChannelId = channelId;
    container.dataset.ssHref = location.href;
    container.dataset.ssPageKey = pageKey;
    container.setAttribute(
      "aria-label",
      `Subscribed since ${dateText}, ${formatTenure(tenure)}`
    );
    container.innerHTML = `
		<span class="ss-badge-mark" aria-hidden="true">
			<span class="ss-badge-tenure" data-ss-tenure>${formatTenureMark(tenure)}</span>
		</span>
		<span class="ss-badge-copy">
			<span class="ss-badge-title">SUBSCRIBED SINCE</span>
			<span class="ss-badge-date" data-ss-date>${dateText}</span>
		</span>
	`;
    return container;
  }
  function removeBadge() {
    document.getElementById(BADGE_ID)?.remove();
  }
  function removeStaleBadge() {
    const existing = document.getElementById(BADGE_ID);
    if (!existing || existing.dataset.ssHref === location.href) {
      return;
    }
    existing.remove();
  }
  function installStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
		.ss-badge-host {
			display: inline-flex !important;
			align-items: center !important;
			gap: 12px !important;
			flex-wrap: wrap !important;
		}

		#${BADGE_ID} {
			--ss-badge-bg: var(--yt-spec-button-chip-background-hover, #f2f2f2);
			--ss-badge-fg: var(--yt-spec-text-primary, #0f0f0f);
			--ss-badge-mark-bg: #cf1a19;
			--ss-badge-mark-fg: #fff;
			display: inline-flex;
			align-items: center;
			gap: 8px;
			box-sizing: border-box;
			min-height: 36px;
			padding: 5px 14px 5px 8px;
			border: 0;
			border-radius: 18px;
			background: var(--ss-badge-bg);
			color: var(--ss-badge-fg);
			font-family: Roboto, Arial, sans-serif;
			line-height: 1.1;
			white-space: nowrap;
			vertical-align: middle;
		}

		#${BADGE_ID} .ss-badge-mark {
			display: inline-grid;
			place-items: center;
			width: 24px;
			height: 24px;
			border-radius: 50%;
			background: var(--ss-badge-mark-bg);
			color: var(--ss-badge-mark-fg);
		}

		#${BADGE_ID} .ss-badge-tenure {
			font-size: 11px;
			font-weight: 800;
			line-height: 1;
			font-variant-numeric: tabular-nums;
		}

		#${BADGE_ID} .ss-badge-copy {
			display: flex;
			flex-direction: column;
			align-items: flex-start;
		}

		#${BADGE_ID} .ss-badge-title {
			font-size: 9px;
			font-weight: 700;
			letter-spacing: 0;
			opacity: 1;
		}

		#${BADGE_ID} .ss-badge-date {
			font-size: 11px;
			font-weight: 700;
			opacity: 1;
		}

		html[dark] #${BADGE_ID},
		[dark] #${BADGE_ID} {
			--ss-badge-bg: #282828;
			--ss-badge-fg: var(--yt-spec-text-primary, #fff);
			--ss-badge-mark-bg: #cf1a19;
			--ss-badge-mark-fg: #fff;
		}

		html[dark] #${BADGE_ID} .ss-badge-mark,
		[dark] #${BADGE_ID} .ss-badge-mark {
			background: var(--ss-badge-mark-bg);
			color: var(--ss-badge-mark-fg);
		}

		@media (max-width: 700px) {
			#${BADGE_ID} {
				margin-top: 8px;
			}
		}
	`;
    document.documentElement.appendChild(style);
  }
  function getSubscriptionTenure(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return { value: 0, unit: "D" };
    }
    const now = /* @__PURE__ */ new Date();
    let years = now.getFullYear() - date.getFullYear();
    if (now < getShiftedDate(date, years, "year")) {
      years -= 1;
    }
    if (years >= 1) {
      return { value: years, unit: "Y" };
    }
    let months = (now.getFullYear() - date.getFullYear()) * 12 + now.getMonth() - date.getMonth();
    if (now < getShiftedDate(date, months, "month")) {
      months -= 1;
    }
    if (months >= 1) {
      return { value: months, unit: "M" };
    }
    const days = Math.max(0, Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY));
    return { value: days, unit: "D" };
  }
  function getShiftedDate(date, amount, unit) {
    const shifted = new Date(date);
    if (unit === "year") {
      shifted.setFullYear(date.getFullYear() + amount);
    } else {
      shifted.setMonth(date.getMonth() + amount);
    }
    return shifted;
  }
  function formatTenureMark(tenure) {
    return `${tenure.value}${tenure.unit}`;
  }
  function formatTenure(tenure) {
    const unit = tenure.unit === "Y" ? "year" : tenure.unit === "M" ? "month" : "day";
    return `${tenure.value} ${unit}${tenure.value === 1 ? "" : "s"}`;
  }
  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat(void 0, {
      month: "long",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }
  function getSubscribeSurfaceText() {
    const target = findSubscribeSurface();
    return [
      target?.textContent,
      target?.getAttribute("aria-label"),
      target?.getAttribute("title")
    ].filter(Boolean).join(" ").trim();
  }
  function findSubscribeSurface() {
    const channelSelectors = [
      "ytd-browse[page-subtype='channels'] ytd-page-header-renderer ytd-subscribe-button-renderer",
      "ytd-browse[page-subtype='channels'] ytd-page-header-renderer button[aria-label*='Subscribe']",
      "ytd-browse[page-subtype='channels'] ytd-page-header-renderer button[aria-label*='Subscribed']",
      "ytd-browse[page-subtype='channels'] yt-page-header-view-model ytd-subscribe-button-renderer",
      "ytd-browse[page-subtype='channels'] yt-page-header-view-model button[aria-label*='Subscribe']",
      "ytd-browse[page-subtype='channels'] yt-page-header-view-model button[aria-label*='Subscribed']",
      "ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer ytd-subscribe-button-renderer",
      "ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribe']",
      "ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribed']"
    ];
    for (const selector of channelSelectors) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        return element;
      }
    }
  }
  function isStatusResponse(response) {
    return "authStatus" in response;
  }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vQHd4dC1kZXYrYnJvd3NlckAwLjEuNC9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vLi4vc3JjL2xpYi9tZXNzYWdlcy50cyIsIi4uLy4uLy4uL3NyYy9lbnRyeXBvaW50cy9jb250ZW50L2luZGV4LnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvY3VzdG9tLWV2ZW50cy5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvY29udGVudC1zY3JpcHQtY29udGV4dC5tanMiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNvbnRlbnRTY3JpcHQoZGVmaW5pdGlvbikge1xuICByZXR1cm4gZGVmaW5pdGlvbjtcbn1cbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgX2Jyb3dzZXIgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBfYnJvd3NlcjtcbmV4cG9ydCB7fTtcbiIsImV4cG9ydCBjb25zdCBDQUNIRV9TVE9SQUdFX0tFWSA9IFwic3MtY2FjaGUtc3RhdGVcIjtcblxuZXhwb3J0IHR5cGUgQXV0aFN0YXR1cyA9IFwic2lnbmVkX291dFwiIHwgXCJzaWduZWRfaW5cIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkID0ge1xuXHRzdWJzY3JpcHRpb25JZDogc3RyaW5nO1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0Y2hhbm5lbFRpdGxlOiBzdHJpbmc7XG5cdHN1YnNjcmliZWRBdDogc3RyaW5nO1xuXHRmZXRjaGVkQXQ6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIENhY2hlU3RhdGUgPSB7XG5cdGF1dGhTdGF0dXM6IEF1dGhTdGF0dXM7XG5cdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRsYXN0RXJyb3I/OiBzdHJpbmc7XG5cdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPjtcbn07XG5cbmV4cG9ydCB0eXBlIFB1YmxpY1N0YXRlID0ge1xuXHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRsYXN0RnVsbFN5bmNBdD86IHN0cmluZztcblx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHRzdWJzY3JpcHRpb25Db3VudDogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR2V0U3RhdHVzUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19HRVRfU1RBVFVTXCI7XG5cdGNoYW5uZWxJZDogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgUmVmcmVzaEFsbFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfUkVGUkVTSF9BTExcIjtcblx0aW50ZXJhY3RpdmU/OiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQXV0aFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfU0lHTl9JTlwiIHwgXCJTU19TSUdOX09VVFwiIHwgXCJTU19HRVRfU1RBVEVcIjtcbn07XG5cbmV4cG9ydCB0eXBlIFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI7XG59O1xuXG5leHBvcnQgdHlwZSBFeHRlbnNpb25SZXF1ZXN0ID1cblx0fCBHZXRTdGF0dXNSZXF1ZXN0XG5cdHwgUmVmcmVzaEFsbFJlcXVlc3Rcblx0fCBBdXRoUmVxdWVzdFxuXHR8IFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdDtcblxuZXhwb3J0IHR5cGUgU3RhdHVzUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0YXV0aFN0YXR1czogQXV0aFN0YXR1cztcblx0XHRcdHN1YnNjcmlwdGlvbj86IFN1YnNjcmlwdGlvblJlY29yZDtcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRcdFx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRcdFx0ZXJyb3I6IHN0cmluZztcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIFN0YXRlUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0c3RhdGU6IFB1YmxpY1N0YXRlO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRzdGF0ZTogUHVibGljU3RhdGU7XG5cdFx0XHRlcnJvcjogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIEV4dGVuc2lvblJlc3BvbnNlID0gU3RhdHVzUmVzcG9uc2UgfCBTdGF0ZVJlc3BvbnNlO1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlDYWNoZVN0YXRlKCk6IENhY2hlU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdGF1dGhTdGF0dXM6IFwic2lnbmVkX291dFwiLFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDoge30sXG5cdH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQge1xuXHRDQUNIRV9TVE9SQUdFX0tFWSxcblx0dHlwZSBFeHRlbnNpb25SZXNwb25zZSxcblx0dHlwZSBTdGF0dXNSZXNwb25zZSxcbn0gZnJvbSBcIi4uLy4uL2xpYi9tZXNzYWdlc1wiO1xuXG5jb25zdCBCQURHRV9JRCA9IFwic3Mtc3Vic2NyaWJlZC1zaW5jZVwiO1xuY29uc3QgU1RZTEVfSUQgPSBcInNzLXN1YnNjcmliZWQtc2luY2Utc3R5bGVcIjtcbmNvbnN0IENIQU5ORUxfSURfUkUgPSAvVUNbXFx3LV17MjAsfS87XG5jb25zdCBET01fUkVOREVSX0RFQk9VTkNFX01TID0gMzUwO1xuY29uc3QgUEFHRV9DT05URVhUX01FU1NBR0VfU09VUkNFID0gXCJzcy1zdWJzY3JpYmVkLXNpbmNlXCI7XG5jb25zdCBQQUdFX0NPTlRFWFRfUkVRVUVTVF9UWVBFID0gXCJTU19HRVRfUEFHRV9DT05URVhUX0NIQU5ORUxfSURcIjtcbmNvbnN0IFBBR0VfQ09OVEVYVF9SRVNQT05TRV9UWVBFID0gXCJTU19QQUdFX0NPTlRFWFRfQ0hBTk5FTF9JRFwiO1xuY29uc3QgUEFHRV9DT05URVhUX1NDUklQVF9JRCA9IFwic3MtcGFnZS1jb250ZXh0LWNoYW5uZWwtcmVhZGVyXCI7XG5jb25zdCBOQVZJR0FUSU9OX1JFTkRFUl9XSU5ET1dfTVMgPSAxMF8wMDA7XG5jb25zdCBOQVZJR0FUSU9OX1JFTkRFUl9JTlRFUlZBTF9NUyA9IDUwMDtcbmNvbnN0IE5BVklHQVRJT05fU0VUVExFX0RFTEFZX01TID0gNjUwO1xuY29uc3QgUEFHRV9XQVRDSERPR19JTlRFUlZBTF9NUyA9IDUwMDA7XG5jb25zdCBNU19QRVJfREFZID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxudHlwZSBTdWJzY3JpcHRpb25UZW51cmUgPSB7XG5cdHZhbHVlOiBudW1iZXI7XG5cdHVuaXQ6IFwiWVwiIHwgXCJNXCIgfCBcIkRcIjtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbnRlbnRTY3JpcHQoe1xuXHRtYXRjaGVzOiBbXCIqOi8vKi55b3V0dWJlLmNvbS8qXCJdLFxuXHRtYWluKCkge1xuXHRcdGxldCBsYXN0UGFnZUtleSA9IFwiXCI7XG5cdFx0bGV0IGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBcIlwiO1xuXHRcdGxldCByZXNvbHZlZEJhZGdlOlxuXHRcdFx0fCB7XG5cdFx0XHRcdFx0cGFnZUtleTogc3RyaW5nO1xuXHRcdFx0XHRcdHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlO1xuXHRcdFx0XHRcdGRhdGVUZXh0OiBzdHJpbmc7XG5cdFx0XHQgIH1cblx0XHRcdHwgdW5kZWZpbmVkO1xuXHRcdGxldCByZW5kZXJSZXF1ZXN0SWQgPSAwO1xuXHRcdGxldCBub3RpZmljYXRpb25PYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IHVuZGVmaW5lZDtcblx0XHRsZXQgcmVuZGVyVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCByZWFkaW5lc3NUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG5cdFx0bGV0IG5hdmlnYXRpb25SZW5kZXJUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBzdWJzY3JpYmVSZXRyeVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcblx0XHRsZXQgc3Vic2NyaWJlQ2hhbmdlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBiYWRnZVJldHJ5VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBwYWdlV2F0Y2hkb2dUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBuYXZpZ2F0aW9uT2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCB1bmRlZmluZWQ7XG5cdFx0bGV0IHJlYWRpbmVzc09ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgdW5kZWZpbmVkO1xuXHRcdGxldCBuYXZpZ2F0aW9uU2V0dGxpbmdVbnRpbCA9IDA7XG5cdFx0bGV0IGlzQWN0aXZlID0gdHJ1ZTtcblxuXHRcdGluc3RhbGxTdHlsZXMoKTtcblx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRzdGFydFBhZ2VXYXRjaGRvZygpO1xuXHRcdG9ic2VydmVZb3VUdWJlTmF2aWdhdGlvbigpO1xuXHRcdG9ic2VydmVQYWdlUmVhZGluZXNzKCk7XG5cdFx0b2JzZXJ2ZUNhY2hlQ2hhbmdlcygpO1xuXHRcdG9ic2VydmVTdWJzY3JpYmVCdXR0b25DaGFuZ2VzKCk7XG5cblx0XHRmdW5jdGlvbiBvYnNlcnZlWW91VHViZU5hdmlnYXRpb24oKSB7XG5cdFx0XHRsZXQgbGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0Y29uc3QgaGFuZGxlTmF2aWdhdGlvbiA9IChjbGVhckJhZGdlOiBib29sZWFuKSA9PiB7XG5cdFx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAobG9jYXRpb24uaHJlZiAhPT0gbGFzdEhyZWYpIHtcblx0XHRcdFx0XHRsYXN0SHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdFx0c3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcChjbGVhckJhZGdlKTtcblx0XHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtbmF2aWdhdGUtc3RhcnRcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKHRydWUpO1xuXHRcdFx0fSk7XG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtbmF2aWdhdGUtZmluaXNoXCIsICgpID0+IHtcblx0XHRcdFx0bGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKHRydWUpO1xuXHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0fSk7XG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtcGFnZS1kYXRhLXVwZGF0ZWRcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0d2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCAoKSA9PiB7XG5cdFx0XHRcdHN0YXJ0TmF2aWdhdGlvblJlbmRlckxvb3AodHJ1ZSk7XG5cdFx0XHR9KTtcblx0XHRcdHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0ZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuXHRcdFx0XHRpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSBcInZpc2libGVcIikge1xuXHRcdFx0XHRcdHN0YXJ0TmF2aWdhdGlvblJlbmRlckxvb3AoZmFsc2UpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblxuXHRcdFx0bmF2aWdhdGlvbk9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuXHRcdFx0XHRoYW5kbGVOYXZpZ2F0aW9uKHRydWUpO1xuXHRcdFx0fSk7XG5cdFx0XHRuYXZpZ2F0aW9uT2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudCwgeyBzdWJ0cmVlOiB0cnVlLCBjaGlsZExpc3Q6IHRydWUgfSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gb2JzZXJ2ZVBhZ2VSZWFkaW5lc3MoKSB7XG5cdFx0XHRyZWFkaW5lc3NPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNTdXBwb3J0ZWRZb3VUdWJlUGFnZSgpKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHJlYWRpbmVzc1RpbWVyKSB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHJlYWRpbmVzc1RpbWVyKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJlYWRpbmVzc1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCQURHRV9JRCk7XG5cdFx0XHRcdFx0Y29uc3QgY2hhbm5lbElkID0gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tRG9tKCk7XG5cblx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHQhYmFkZ2UgfHxcblx0XHRcdFx0XHRcdCFjaGFubmVsSWQgfHxcblx0XHRcdFx0XHRcdGJhZGdlLmRhdGFzZXQuc3NDaGFubmVsSWQgIT09IGNoYW5uZWxJZCB8fFxuXHRcdFx0XHRcdFx0YmFkZ2UuZGF0YXNldC5zc0hyZWYgIT09IGxvY2F0aW9uLmhyZWYgfHxcblx0XHRcdFx0XHRcdCFmaW5kQmFkZ2VUYXJnZXQoZmFsc2UpXG5cdFx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0XHRzY2hlZHVsZVJlbmRlcigpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSwgRE9NX1JFTkRFUl9ERUJPVU5DRV9NUyk7XG5cdFx0XHR9KTtcblx0XHRcdHJlYWRpbmVzc09ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQsIHsgc3VidHJlZTogdHJ1ZSwgY2hpbGRMaXN0OiB0cnVlIH0pO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN0YXJ0UGFnZVdhdGNoZG9nKCkge1xuXHRcdFx0bGV0IGxhc3RPYnNlcnZlZEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXG5cdFx0XHRwYWdlV2F0Y2hkb2dUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChsb2NhdGlvbi5ocmVmICE9PSBsYXN0T2JzZXJ2ZWRIcmVmKSB7XG5cdFx0XHRcdFx0bGFzdE9ic2VydmVkSHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdFx0c3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcCh0cnVlKTtcblx0XHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChkb2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09IFwiaGlkZGVuXCIgfHwgIWlzU3VwcG9ydGVkWW91VHViZVBhZ2UoKSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0IWhhc0NvbmZpcm1lZE5vU3Vic2NyaXB0aW9uRm9yQ3VycmVudEhyZWYoKSAmJlxuXHRcdFx0XHRcdCghYmFkZ2UgfHwgYmFkZ2UuZGF0YXNldC5zc0hyZWYgIT09IGxvY2F0aW9uLmhyZWYgfHwgIWZpbmRCYWRnZVRhcmdldChmYWxzZSkpXG5cdFx0XHRcdCkge1xuXHRcdFx0XHRcdHNjaGVkdWxlUmVuZGVyKCk7XG5cdFx0XHRcdH1cblx0XHRcdH0sIFBBR0VfV0FUQ0hET0dfSU5URVJWQUxfTVMpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGhhc0NvbmZpcm1lZE5vU3Vic2NyaXB0aW9uRm9yQ3VycmVudEhyZWYoKSB7XG5cdFx0XHRyZXR1cm4gbGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleS5zdGFydHNXaXRoKGAke2xvY2F0aW9uLmhyZWZ9fGApO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIG9ic2VydmVDYWNoZUNoYW5nZXMoKSB7XG5cdFx0XHRicm93c2VyLnN0b3JhZ2Uub25DaGFuZ2VkLmFkZExpc3RlbmVyKChjaGFuZ2VzLCBhcmVhTmFtZSkgPT4ge1xuXHRcdFx0XHRpZiAoYXJlYU5hbWUgPT09IFwibG9jYWxcIiAmJiBDQUNIRV9TVE9SQUdFX0tFWSBpbiBjaGFuZ2VzKSB7XG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0XHRcdGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0c2NoZWR1bGVSZW5kZXIoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gb2JzZXJ2ZVN1YnNjcmliZUJ1dHRvbkNoYW5nZXMoKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0bm90aWZpY2F0aW9uT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcblxuXHRcdFx0Y29uc3QgdGFyZ2V0ID0gZmluZFN1YnNjcmliZVN1cmZhY2UoKTtcblxuXHRcdFx0aWYgKCF0YXJnZXQpIHtcblx0XHRcdFx0aWYgKHN1YnNjcmliZVJldHJ5VGltZXIpIHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQoc3Vic2NyaWJlUmV0cnlUaW1lcik7XG5cdFx0XHRcdH1cblx0XHRcdFx0c3Vic2NyaWJlUmV0cnlUaW1lciA9IHNldFRpbWVvdXQob2JzZXJ2ZVN1YnNjcmliZUJ1dHRvbkNoYW5nZXMsIDEwMDApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGxldCBsYXN0VGV4dCA9IGdldFN1YnNjcmliZVN1cmZhY2VUZXh0KCk7XG5cdFx0XHRub3RpZmljYXRpb25PYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IG5leHRUZXh0ID0gZ2V0U3Vic2NyaWJlU3VyZmFjZVRleHQoKTtcblx0XHRcdFx0aWYgKG5leHRUZXh0ID09PSBsYXN0VGV4dCkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGxhc3RUZXh0ID0gbmV4dFRleHQ7XG5cdFx0XHRcdGxhc3RQYWdlS2V5ID0gXCJcIjtcblx0XHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdHZvaWQgc2VuZFJ1bnRpbWVNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiBcIlNTX1ZJU0lCTEVfU1VCU0NSSVBUSU9OX0NIQU5HRURcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHN1YnNjcmliZUNoYW5nZVRpbWVyID0gc2V0VGltZW91dChzY2hlZHVsZVJlbmRlciwgMzUwMCk7XG5cdFx0XHR9KTtcblxuXHRcdFx0bm90aWZpY2F0aW9uT2JzZXJ2ZXIub2JzZXJ2ZSh0YXJnZXQsIHtcblx0XHRcdFx0c3VidHJlZTogdHJ1ZSxcblx0XHRcdFx0Y2hpbGRMaXN0OiB0cnVlLFxuXHRcdFx0XHRjaGFyYWN0ZXJEYXRhOiB0cnVlLFxuXHRcdFx0XHRhdHRyaWJ1dGVzOiB0cnVlLFxuXHRcdFx0XHRhdHRyaWJ1dGVGaWx0ZXI6IFtcImFyaWEtbGFiZWxcIiwgXCJ0aXRsZVwiXSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHNjaGVkdWxlUmVuZGVyKGRlbGF5ID0gMjUwKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHJlbmRlclRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChyZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG5hdmlnYXRpb25TZXR0bGVEZWxheSA9IE1hdGgubWF4KDAsIG5hdmlnYXRpb25TZXR0bGluZ1VudGlsIC0gRGF0ZS5ub3coKSk7XG5cdFx0XHRyZW5kZXJUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR2b2lkIHJlbmRlckZvckN1cnJlbnRQYWdlKCk7XG5cdFx0XHR9LCBNYXRoLm1heChkZWxheSwgbmF2aWdhdGlvblNldHRsZURlbGF5KSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gc3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcChjbGVhckJhZGdlOiBib29sZWFuKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0bGFzdFBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRyZXNvbHZlZEJhZGdlID0gdW5kZWZpbmVkO1xuXHRcdFx0aWYgKGNsZWFyQmFkZ2UpIHtcblx0XHRcdFx0bmF2aWdhdGlvblNldHRsaW5nVW50aWwgPSBEYXRlLm5vdygpICsgTkFWSUdBVElPTl9TRVRUTEVfREVMQVlfTVM7XG5cdFx0XHRcdHJlbW92ZVN0YWxlQmFkZ2UoKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG5hdmlnYXRpb25SZW5kZXJUaW1lcikge1xuXHRcdFx0XHRjbGVhckludGVydmFsKG5hdmlnYXRpb25SZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHN0b3BBdCA9IERhdGUubm93KCkgKyBOQVZJR0FUSU9OX1JFTkRFUl9XSU5ET1dfTVM7XG5cdFx0XHRzY2hlZHVsZVJlbmRlcigpO1xuXHRcdFx0bmF2aWdhdGlvblJlbmRlclRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0XHRpZiAoRGF0ZS5ub3coKSA+IHN0b3BBdCkge1xuXHRcdFx0XHRcdGlmIChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpIHtcblx0XHRcdFx0XHRcdGNsZWFySW50ZXJ2YWwobmF2aWdhdGlvblJlbmRlclRpbWVyKTtcblx0XHRcdFx0XHRcdG5hdmlnYXRpb25SZW5kZXJUaW1lciA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0c2NoZWR1bGVSZW5kZXIoKTtcblx0XHRcdH0sIE5BVklHQVRJT05fUkVOREVSX0lOVEVSVkFMX01TKTtcblx0XHR9XG5cblx0XHRhc3luYyBmdW5jdGlvbiByZW5kZXJGb3JDdXJyZW50UGFnZSgpIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByZXF1ZXN0SWQgPSArK3JlbmRlclJlcXVlc3RJZDtcblx0XHRcdFx0Y29uc3QgY2hhbm5lbElkID0gYXdhaXQgZmluZEN1cnJlbnRDaGFubmVsSWQoKTtcblx0XHRcdFx0Y29uc3QgcGFnZUtleSA9IGAke2xvY2F0aW9uLmhyZWZ9fCR7Y2hhbm5lbElkID8/IFwibm9uZVwifWA7XG5cblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNTdXBwb3J0ZWRZb3VUdWJlUGFnZSgpKSB7XG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBwYWdlS2V5O1xuXHRcdFx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgZXhpc3RpbmdCYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJBREdFX0lEKTtcblx0XHRcdFx0aWYgKCFjaGFubmVsSWQpIHtcblx0XHRcdFx0XHRsYXN0UGFnZUtleSA9IHBhZ2VLZXk7XG5cdFx0XHRcdFx0aWYgKGV4aXN0aW5nQmFkZ2U/LmRhdGFzZXQuc3NIcmVmICE9PSBsb2NhdGlvbi5ocmVmKSB7XG5cdFx0XHRcdFx0XHRyZW1vdmVCYWRnZSgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPT09IHBhZ2VLZXkgJiZcblx0XHRcdFx0XHRleGlzdGluZ0JhZGdlPy5kYXRhc2V0LnNzUGFnZUtleSA9PT0gcGFnZUtleSAmJlxuXHRcdFx0XHRcdGV4aXN0aW5nQmFkZ2UuZGF0YXNldC5zc0hyZWYgPT09IGxvY2F0aW9uLmhyZWZcblx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBwYWdlS2V5O1xuXG5cdFx0XHRcdGlmIChyZXNvbHZlZEJhZGdlPy5wYWdlS2V5ID09PSBwYWdlS2V5KSB7XG5cdFx0XHRcdFx0aW5zZXJ0QmFkZ2Uoe1xuXHRcdFx0XHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0XHRcdFx0dGVudXJlOiByZXNvbHZlZEJhZGdlLnRlbnVyZSxcblx0XHRcdFx0XHRcdGRhdGVUZXh0OiByZXNvbHZlZEJhZGdlLmRhdGVUZXh0LFxuXHRcdFx0XHRcdFx0cGFnZUtleSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAobGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9PT0gcGFnZUtleSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc2VuZFJ1bnRpbWVNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiBcIlNTX0dFVF9TVEFUVVNcIixcblx0XHRcdFx0XHRjaGFubmVsSWQsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGlmICghcmVzcG9uc2UgfHwgcmVxdWVzdElkICE9PSByZW5kZXJSZXF1ZXN0SWQgfHwgIWlzQWN0aXZlKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKCFpc1N0YXR1c1Jlc3BvbnNlKHJlc3BvbnNlKSB8fCAhcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLnN1YnNjcmlwdGlvbikge1xuXHRcdFx0XHRcdGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBwYWdlS2V5O1xuXHRcdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0cmVtb3ZlQmFkZ2UoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRsYXN0Tm9TdWJzY3JpcHRpb25QYWdlS2V5ID0gXCJcIjtcblx0XHRcdFx0cmVzb2x2ZWRCYWRnZSA9IHtcblx0XHRcdFx0XHRwYWdlS2V5LFxuXHRcdFx0XHRcdHRlbnVyZTogZ2V0U3Vic2NyaXB0aW9uVGVudXJlKHJlc3BvbnNlLnN1YnNjcmlwdGlvbi5zdWJzY3JpYmVkQXQpLFxuXHRcdFx0XHRcdGRhdGVUZXh0OiBmb3JtYXREYXRlKHJlc3BvbnNlLnN1YnNjcmlwdGlvbi5zdWJzY3JpYmVkQXQpLFxuXHRcdFx0XHR9O1xuXHRcdFx0XHRpbnNlcnRCYWRnZSh7XG5cdFx0XHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0XHRcdHRlbnVyZTogcmVzb2x2ZWRCYWRnZS50ZW51cmUsXG5cdFx0XHRcdFx0ZGF0ZVRleHQ6IHJlc29sdmVkQmFkZ2UuZGF0ZVRleHQsXG5cdFx0XHRcdFx0cGFnZUtleSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRoYW5kbGVFeHRlbnNpb25FcnJvcihlcnJvcik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaW5zZXJ0QmFkZ2Uoe1xuXHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0dGVudXJlLFxuXHRcdFx0ZGF0ZVRleHQsXG5cdFx0XHRwYWdlS2V5LFxuXHRcdH06IHtcblx0XHRcdGNoYW5uZWxJZDogc3RyaW5nO1xuXHRcdFx0dGVudXJlOiBTdWJzY3JpcHRpb25UZW51cmU7XG5cdFx0XHRkYXRlVGV4dDogc3RyaW5nO1xuXHRcdFx0cGFnZUtleTogc3RyaW5nO1xuXHRcdH0pIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCB0YXJnZXQgPSBmaW5kQmFkZ2VUYXJnZXQoKTtcblx0XHRcdGlmICghdGFyZ2V0KSB7XG5cdFx0XHRcdGlmIChiYWRnZVJldHJ5VGltZXIpIHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQoYmFkZ2VSZXRyeVRpbWVyKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRiYWRnZVJldHJ5VGltZXIgPSBzZXRUaW1lb3V0KHNjaGVkdWxlUmVuZGVyLCA1MDApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRcdFx0aWYgKGV4aXN0aW5nPy5wYXJlbnRFbGVtZW50ID09PSB0YXJnZXQpIHtcblx0XHRcdFx0ZXhpc3RpbmcuZGF0YXNldC5zc0NoYW5uZWxJZCA9IGNoYW5uZWxJZDtcblx0XHRcdFx0ZXhpc3RpbmcuZGF0YXNldC5zc0hyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0XHRleGlzdGluZy5kYXRhc2V0LnNzUGFnZUtleSA9IHBhZ2VLZXk7XG5cdFx0XHRcdGV4aXN0aW5nLnNldEF0dHJpYnV0ZShcblx0XHRcdFx0XHRcImFyaWEtbGFiZWxcIixcblx0XHRcdFx0XHRgU3Vic2NyaWJlZCBzaW5jZSAke2RhdGVUZXh0fSwgJHtmb3JtYXRUZW51cmUodGVudXJlKX1gXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGV4aXN0aW5nLnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1zcy10ZW51cmVdXCIpIS50ZXh0Q29udGVudCA9XG5cdFx0XHRcdFx0Zm9ybWF0VGVudXJlTWFyayh0ZW51cmUpO1xuXHRcdFx0XHRleGlzdGluZy5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtc3MtZGF0ZV1cIikhLnRleHRDb250ZW50ID0gZGF0ZVRleHQ7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0cmVtb3ZlQmFkZ2UoKTtcblx0XHRcdHRhcmdldC5hcHBlbmRDaGlsZChjcmVhdGVCYWRnZSh7IGNoYW5uZWxJZCwgdGVudXJlLCBkYXRlVGV4dCwgcGFnZUtleSB9KSk7XG5cdFx0fVxuXG5cdFx0YXN5bmMgZnVuY3Rpb24gc2VuZFJ1bnRpbWVNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24pIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRyZXR1cm4gKGF3YWl0IGJyb3dzZXIucnVudGltZS5zZW5kTWVzc2FnZShtZXNzYWdlKSkgYXMgRXh0ZW5zaW9uUmVzcG9uc2U7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRoYW5kbGVFeHRlbnNpb25FcnJvcihlcnJvcik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaGFuZGxlRXh0ZW5zaW9uRXJyb3IoZXJyb3I6IHVua25vd24pIHtcblx0XHRcdGlmIChpc0V4dGVuc2lvbkNvbnRleHRJbnZhbGlkYXRlZEVycm9yKGVycm9yKSkge1xuXHRcdFx0XHRzdG9wQ29udGVudFNjcmlwdCgpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN0b3BDb250ZW50U2NyaXB0KCkge1xuXHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlzQWN0aXZlID0gZmFsc2U7XG5cdFx0XHRyZW5kZXJSZXF1ZXN0SWQgKz0gMTtcblx0XHRcdG5vdGlmaWNhdGlvbk9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG5cdFx0XHRuYXZpZ2F0aW9uT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcblx0XHRcdHJlYWRpbmVzc09ic2VydmVyPy5kaXNjb25uZWN0KCk7XG5cdFx0XHRjbGVhck1hbmFnZWRUaW1lcnMoKTtcblx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gY2xlYXJNYW5hZ2VkVGltZXJzKCkge1xuXHRcdFx0aWYgKHJlbmRlclRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChyZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cdFx0XHRpZiAocmVhZGluZXNzVGltZXIpIHtcblx0XHRcdFx0Y2xlYXJUaW1lb3V0KHJlYWRpbmVzc1RpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChzdWJzY3JpYmVSZXRyeVRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChzdWJzY3JpYmVSZXRyeVRpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChzdWJzY3JpYmVDaGFuZ2VUaW1lcikge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQoc3Vic2NyaWJlQ2hhbmdlVGltZXIpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGJhZGdlUmV0cnlUaW1lcikge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQoYmFkZ2VSZXRyeVRpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpIHtcblx0XHRcdFx0Y2xlYXJJbnRlcnZhbChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHBhZ2VXYXRjaGRvZ1RpbWVyKSB7XG5cdFx0XHRcdGNsZWFySW50ZXJ2YWwocGFnZVdhdGNoZG9nVGltZXIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSxcbn0pO1xuXG5mdW5jdGlvbiBpc1N1cHBvcnRlZFlvdVR1YmVQYWdlKCkge1xuXHRyZXR1cm4gaXNDaGFubmVsUGFnZSgpO1xufVxuXG5mdW5jdGlvbiBpc0NoYW5uZWxQYWdlKHBhdGggPSBsb2NhdGlvbi5wYXRobmFtZSkge1xuXHRyZXR1cm4gKFxuXHRcdHBhdGguc3RhcnRzV2l0aChcIi9AXCIpIHx8XG5cdFx0cGF0aC5zdGFydHNXaXRoKFwiL2NoYW5uZWwvXCIpIHx8XG5cdFx0cGF0aC5zdGFydHNXaXRoKFwiL2MvXCIpIHx8XG5cdFx0cGF0aC5zdGFydHNXaXRoKFwiL3VzZXIvXCIpXG5cdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZpbmRDdXJyZW50Q2hhbm5lbElkKCkge1xuXHRjb25zdCBwYXRoID0gbG9jYXRpb24ucGF0aG5hbWU7XG5cdGNvbnN0IHBhdGhDaGFubmVsSWQgPSBtYXRjaENoYW5uZWxJZChwYXRoKTtcblx0aWYgKHBhdGhDaGFubmVsSWQpIHtcblx0XHRyZXR1cm4gcGF0aENoYW5uZWxJZDtcblx0fVxuXG5cdGlmICghaXNDaGFubmVsUGFnZShwYXRoKSkge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRyZXR1cm4gKFxuXHRcdChhd2FpdCBmaW5kQ3VycmVudENoYW5uZWxJZEZyb21QYWdlQ29udGV4dCgpKSA/PyBmaW5kQ3VycmVudENoYW5uZWxJZEZyb21Eb20oKVxuXHQpO1xufVxuXG5mdW5jdGlvbiBmaW5kQ3VycmVudENoYW5uZWxJZEZyb21Eb20oKSB7XG5cdGNvbnN0IGNoYW5uZWxTZWxlY3RvcnMgPSBbXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSBtZXRhW2l0ZW1wcm9wPSdjaGFubmVsSWQnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtYzQtdGFiYmVkLWhlYWRlci1yZW5kZXJlciBhW2hyZWYqPScvY2hhbm5lbC8nXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10gI2NoYW5uZWwtaGVhZGVyIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSAjcGFnZS1oZWFkZXIgYVtocmVmKj0nL2NoYW5uZWwvJ11cIixcblx0XHRcIm1ldGFbaXRlbXByb3A9J2NoYW5uZWxJZCddXCIsXG5cdFx0XCJsaW5rW3JlbD0nY2Fub25pY2FsJ11cIixcblx0XHRcImxpbmtbaXRlbXByb3A9J3VybCddXCIsXG5cdF07XG5cblx0Zm9yIChjb25zdCBzZWxlY3RvciBvZiBjaGFubmVsU2VsZWN0b3JzKSB7XG5cdFx0Y29uc3QgZWxlbWVudCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsZWN0b3IpO1xuXHRcdGNvbnN0IHZhbHVlID1cblx0XHRcdGVsZW1lbnQ/LmdldEF0dHJpYnV0ZShcImNvbnRlbnRcIikgPz9cblx0XHRcdGVsZW1lbnQ/LmdldEF0dHJpYnV0ZShcImhyZWZcIikgPz9cblx0XHRcdGVsZW1lbnQ/LnRleHRDb250ZW50O1xuXHRcdGNvbnN0IGNoYW5uZWxJZCA9IG1hdGNoQ2hhbm5lbElkKHZhbHVlKTtcblx0XHRpZiAoY2hhbm5lbElkKSB7XG5cdFx0XHRyZXR1cm4gY2hhbm5lbElkO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IGJyb3dzZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXVwiKTtcblx0Y29uc3QgaGVhZGVyQ2hhbm5lbElkID0gbWF0Y2hDaGFubmVsSWQoXG5cdFx0YnJvd3NlXG5cdFx0XHQ/LnF1ZXJ5U2VsZWN0b3IoXG5cdFx0XHRcdFwieXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyLCB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsLCB5dGQtYzQtdGFiYmVkLWhlYWRlci1yZW5kZXJlciwgI2NoYW5uZWwtaGVhZGVyLCAjcGFnZS1oZWFkZXJcIlxuXHRcdFx0KVxuXHRcdFx0Py5pbm5lckhUTUxcblx0KTtcblx0aWYgKGhlYWRlckNoYW5uZWxJZCkge1xuXHRcdHJldHVybiBoZWFkZXJDaGFubmVsSWQ7XG5cdH1cbn1cblxuZnVuY3Rpb24gbWF0Y2hDaGFubmVsSWQodmFsdWU/OiBzdHJpbmcgfCBudWxsKSB7XG5cdHJldHVybiB2YWx1ZT8ubWF0Y2goQ0hBTk5FTF9JRF9SRSk/LlswXTtcbn1cblxuZnVuY3Rpb24gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tUGFnZUNvbnRleHQoKSB7XG5cdGNvbnN0IHJlcXVlc3RJZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG5cblx0cmV0dXJuIG5ldyBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4oKHJlc29sdmUpID0+IHtcblx0XHRpbmplY3RQYWdlQ29udGV4dENoYW5uZWxJZFJlYWRlcigpO1xuXG5cdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0d2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIG9uTWVzc2FnZSk7XG5cdFx0XHRyZXNvbHZlKHVuZGVmaW5lZCk7XG5cdFx0fSwgMzAwKTtcblxuXHRcdGZ1bmN0aW9uIG9uTWVzc2FnZShldmVudDogTWVzc2FnZUV2ZW50KSB7XG5cdFx0XHRpZiAoZXZlbnQuc291cmNlICE9PSB3aW5kb3cpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBkYXRhID0gZXZlbnQuZGF0YSBhc1xuXHRcdFx0XHR8IHtcblx0XHRcdFx0XHRcdHNvdXJjZT86IHN0cmluZztcblx0XHRcdFx0XHRcdHR5cGU/OiBzdHJpbmc7XG5cdFx0XHRcdFx0XHRyZXF1ZXN0SWQ/OiBzdHJpbmc7XG5cdFx0XHRcdFx0XHRjaGFubmVsSWQ/OiBzdHJpbmc7XG5cdFx0XHRcdCAgfVxuXHRcdFx0XHR8IHVuZGVmaW5lZDtcblxuXHRcdFx0aWYgKFxuXHRcdFx0XHRkYXRhPy5zb3VyY2UgIT09IFBBR0VfQ09OVEVYVF9NRVNTQUdFX1NPVVJDRSB8fFxuXHRcdFx0XHRkYXRhLnR5cGUgIT09IFBBR0VfQ09OVEVYVF9SRVNQT05TRV9UWVBFIHx8XG5cdFx0XHRcdGRhdGEucmVxdWVzdElkICE9PSByZXF1ZXN0SWRcblx0XHRcdCkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRcdFx0cmVzb2x2ZShtYXRjaENoYW5uZWxJZChkYXRhLmNoYW5uZWxJZCkpO1xuXHRcdH1cblxuXHRcdHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRcdHdpbmRvdy5wb3N0TWVzc2FnZShcblx0XHRcdHtcblx0XHRcdFx0c291cmNlOiBQQUdFX0NPTlRFWFRfTUVTU0FHRV9TT1VSQ0UsXG5cdFx0XHRcdHR5cGU6IFBBR0VfQ09OVEVYVF9SRVFVRVNUX1RZUEUsXG5cdFx0XHRcdHJlcXVlc3RJZCxcblx0XHRcdH0sXG5cdFx0XHR3aW5kb3cubG9jYXRpb24ub3JpZ2luXG5cdFx0KTtcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGluamVjdFBhZ2VDb250ZXh0Q2hhbm5lbElkUmVhZGVyKCkge1xuXHRpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoUEFHRV9DT05URVhUX1NDUklQVF9JRCkpIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBzY3JpcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2NyaXB0XCIpO1xuXHRzY3JpcHQuaWQgPSBQQUdFX0NPTlRFWFRfU0NSSVBUX0lEO1xuXHRzY3JpcHQuc3JjID0gYnJvd3Nlci5ydW50aW1lLmdldFVSTChcIi9wYWdlLWNvbnRleHQtY2hhbm5lbC5qc1wiKTtcblx0ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKHNjcmlwdCk7XG59XG5cbmZ1bmN0aW9uIGlzRXh0ZW5zaW9uQ29udGV4dEludmFsaWRhdGVkRXJyb3IoZXJyb3I6IHVua25vd24pIHtcblx0Y29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0cmV0dXJuIG1lc3NhZ2UudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImV4dGVuc2lvbiBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xufVxuXG5mdW5jdGlvbiBmaW5kQmFkZ2VUYXJnZXQobWFya0hvc3QgPSB0cnVlKSB7XG5cdGNvbnN0IGNoYW5uZWxDYW5kaWRhdGVzID0gW1xuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyICNidXR0b25zXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtcGFnZS1oZWFkZXItcmVuZGVyZXIgeXQtZmxleGlibGUtYWN0aW9ucy12aWV3LW1vZGVsXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsIHl0LWZsZXhpYmxlLWFjdGlvbnMtdmlldy1tb2RlbFwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCAjYnV0dG9uc1wiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgI2J1dHRvbnNcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddICNjaGFubmVsLWhlYWRlciAjYnV0dG9uc1wiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10gI3BhZ2UtaGVhZGVyICNidXR0b25zXCIsXG5cdF07XG5cblx0Zm9yIChjb25zdCBzZWxlY3RvciBvZiBjaGFubmVsQ2FuZGlkYXRlcykge1xuXHRcdGNvbnN0IGVsZW1lbnQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbGVjdG9yKTtcblx0XHRpZiAoZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSB7XG5cdFx0XHRpZiAobWFya0hvc3QpIHtcblx0XHRcdFx0ZWxlbWVudC5jbGFzc0xpc3QuYWRkKFwic3MtYmFkZ2UtaG9zdFwiKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBlbGVtZW50O1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IHN1YnNjcmliZVN1cmZhY2UgPSBmaW5kU3Vic2NyaWJlU3VyZmFjZSgpO1xuXHRjb25zdCB0YXJnZXQgPVxuXHRcdHN1YnNjcmliZVN1cmZhY2U/LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFxuXHRcdFx0XCJ5dC1mbGV4aWJsZS1hY3Rpb25zLXZpZXctbW9kZWwsICNidXR0b25zLCAjc3Vic2NyaWJlLWJ1dHRvblwiXG5cdFx0KSA/P1xuXHRcdHN1YnNjcmliZVN1cmZhY2U/LnBhcmVudEVsZW1lbnQgPz9cblx0XHR1bmRlZmluZWQ7XG5cblx0aWYgKHRhcmdldCAmJiBtYXJrSG9zdCkge1xuXHRcdHRhcmdldC5jbGFzc0xpc3QuYWRkKFwic3MtYmFkZ2UtaG9zdFwiKTtcblx0fVxuXG5cdHJldHVybiB0YXJnZXQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJhZGdlKHtcblx0Y2hhbm5lbElkLFxuXHR0ZW51cmUsXG5cdGRhdGVUZXh0LFxuXHRwYWdlS2V5LFxufToge1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0dGVudXJlOiBTdWJzY3JpcHRpb25UZW51cmU7XG5cdGRhdGVUZXh0OiBzdHJpbmc7XG5cdHBhZ2VLZXk6IHN0cmluZztcbn0pIHtcblx0Y29uc3QgY29udGFpbmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcblx0Y29udGFpbmVyLmlkID0gQkFER0VfSUQ7XG5cdGNvbnRhaW5lci5kYXRhc2V0LnNzQ2hhbm5lbElkID0gY2hhbm5lbElkO1xuXHRjb250YWluZXIuZGF0YXNldC5zc0hyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRjb250YWluZXIuZGF0YXNldC5zc1BhZ2VLZXkgPSBwYWdlS2V5O1xuXHRjb250YWluZXIuc2V0QXR0cmlidXRlKFxuXHRcdFwiYXJpYS1sYWJlbFwiLFxuXHRcdGBTdWJzY3JpYmVkIHNpbmNlICR7ZGF0ZVRleHR9LCAke2Zvcm1hdFRlbnVyZSh0ZW51cmUpfWBcblx0KTtcblx0Y29udGFpbmVyLmlubmVySFRNTCA9IGBcblx0XHQ8c3BhbiBjbGFzcz1cInNzLWJhZGdlLW1hcmtcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5cblx0XHRcdDxzcGFuIGNsYXNzPVwic3MtYmFkZ2UtdGVudXJlXCIgZGF0YS1zcy10ZW51cmU+JHtmb3JtYXRUZW51cmVNYXJrKHRlbnVyZSl9PC9zcGFuPlxuXHRcdDwvc3Bhbj5cblx0XHQ8c3BhbiBjbGFzcz1cInNzLWJhZGdlLWNvcHlcIj5cblx0XHRcdDxzcGFuIGNsYXNzPVwic3MtYmFkZ2UtdGl0bGVcIj5TVUJTQ1JJQkVEIFNJTkNFPC9zcGFuPlxuXHRcdFx0PHNwYW4gY2xhc3M9XCJzcy1iYWRnZS1kYXRlXCIgZGF0YS1zcy1kYXRlPiR7ZGF0ZVRleHR9PC9zcGFuPlxuXHRcdDwvc3Bhbj5cblx0YDtcblx0cmV0dXJuIGNvbnRhaW5lcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlQmFkZ2UoKSB7XG5cdGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJBREdFX0lEKT8ucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVN0YWxlQmFkZ2UoKSB7XG5cdGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRpZiAoIWV4aXN0aW5nIHx8IGV4aXN0aW5nLmRhdGFzZXQuc3NIcmVmID09PSBsb2NhdGlvbi5ocmVmKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0ZXhpc3RpbmcucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKSB7XG5cdGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChTVFlMRV9JRCkpIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcblx0c3R5bGUuaWQgPSBTVFlMRV9JRDtcblx0c3R5bGUudGV4dENvbnRlbnQgPSBgXG5cdFx0LnNzLWJhZGdlLWhvc3Qge1xuXHRcdFx0ZGlzcGxheTogaW5saW5lLWZsZXggIWltcG9ydGFudDtcblx0XHRcdGFsaWduLWl0ZW1zOiBjZW50ZXIgIWltcG9ydGFudDtcblx0XHRcdGdhcDogMTJweCAhaW1wb3J0YW50O1xuXHRcdFx0ZmxleC13cmFwOiB3cmFwICFpbXBvcnRhbnQ7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IHtcblx0XHRcdC0tc3MtYmFkZ2UtYmc6IHZhcigtLXl0LXNwZWMtYnV0dG9uLWNoaXAtYmFja2dyb3VuZC1ob3ZlciwgI2YyZjJmMik7XG5cdFx0XHQtLXNzLWJhZGdlLWZnOiB2YXIoLS15dC1zcGVjLXRleHQtcHJpbWFyeSwgIzBmMGYwZik7XG5cdFx0XHQtLXNzLWJhZGdlLW1hcmstYmc6ICNjZjFhMTk7XG5cdFx0XHQtLXNzLWJhZGdlLW1hcmstZmc6ICNmZmY7XG5cdFx0XHRkaXNwbGF5OiBpbmxpbmUtZmxleDtcblx0XHRcdGFsaWduLWl0ZW1zOiBjZW50ZXI7XG5cdFx0XHRnYXA6IDhweDtcblx0XHRcdGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG5cdFx0XHRtaW4taGVpZ2h0OiAzNnB4O1xuXHRcdFx0cGFkZGluZzogNXB4IDE0cHggNXB4IDhweDtcblx0XHRcdGJvcmRlcjogMDtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDE4cHg7XG5cdFx0XHRiYWNrZ3JvdW5kOiB2YXIoLS1zcy1iYWRnZS1iZyk7XG5cdFx0XHRjb2xvcjogdmFyKC0tc3MtYmFkZ2UtZmcpO1xuXHRcdFx0Zm9udC1mYW1pbHk6IFJvYm90bywgQXJpYWwsIHNhbnMtc2VyaWY7XG5cdFx0XHRsaW5lLWhlaWdodDogMS4xO1xuXHRcdFx0d2hpdGUtc3BhY2U6IG5vd3JhcDtcblx0XHRcdHZlcnRpY2FsLWFsaWduOiBtaWRkbGU7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS1tYXJrIHtcblx0XHRcdGRpc3BsYXk6IGlubGluZS1ncmlkO1xuXHRcdFx0cGxhY2UtaXRlbXM6IGNlbnRlcjtcblx0XHRcdHdpZHRoOiAyNHB4O1xuXHRcdFx0aGVpZ2h0OiAyNHB4O1xuXHRcdFx0Ym9yZGVyLXJhZGl1czogNTAlO1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tc3MtYmFkZ2UtbWFyay1iZyk7XG5cdFx0XHRjb2xvcjogdmFyKC0tc3MtYmFkZ2UtbWFyay1mZyk7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS10ZW51cmUge1xuXHRcdFx0Zm9udC1zaXplOiAxMXB4O1xuXHRcdFx0Zm9udC13ZWlnaHQ6IDgwMDtcblx0XHRcdGxpbmUtaGVpZ2h0OiAxO1xuXHRcdFx0Zm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtcztcblx0XHR9XG5cblx0XHQjJHtCQURHRV9JRH0gLnNzLWJhZGdlLWNvcHkge1xuXHRcdFx0ZGlzcGxheTogZmxleDtcblx0XHRcdGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG5cdFx0XHRhbGlnbi1pdGVtczogZmxleC1zdGFydDtcblx0XHR9XG5cblx0XHQjJHtCQURHRV9JRH0gLnNzLWJhZGdlLXRpdGxlIHtcblx0XHRcdGZvbnQtc2l6ZTogOXB4O1xuXHRcdFx0Zm9udC13ZWlnaHQ6IDcwMDtcblx0XHRcdGxldHRlci1zcGFjaW5nOiAwO1xuXHRcdFx0b3BhY2l0eTogMTtcblx0XHR9XG5cblx0XHQjJHtCQURHRV9JRH0gLnNzLWJhZGdlLWRhdGUge1xuXHRcdFx0Zm9udC1zaXplOiAxMXB4O1xuXHRcdFx0Zm9udC13ZWlnaHQ6IDcwMDtcblx0XHRcdG9wYWNpdHk6IDE7XG5cdFx0fVxuXG5cdFx0aHRtbFtkYXJrXSAjJHtCQURHRV9JRH0sXG5cdFx0W2RhcmtdICMke0JBREdFX0lEfSB7XG5cdFx0XHQtLXNzLWJhZGdlLWJnOiAjMjgyODI4O1xuXHRcdFx0LS1zcy1iYWRnZS1mZzogdmFyKC0teXQtc3BlYy10ZXh0LXByaW1hcnksICNmZmYpO1xuXHRcdFx0LS1zcy1iYWRnZS1tYXJrLWJnOiAjY2YxYTE5O1xuXHRcdFx0LS1zcy1iYWRnZS1tYXJrLWZnOiAjZmZmO1xuXHRcdH1cblxuXHRcdGh0bWxbZGFya10gIyR7QkFER0VfSUR9IC5zcy1iYWRnZS1tYXJrLFxuXHRcdFtkYXJrXSAjJHtCQURHRV9JRH0gLnNzLWJhZGdlLW1hcmsge1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tc3MtYmFkZ2UtbWFyay1iZyk7XG5cdFx0XHRjb2xvcjogdmFyKC0tc3MtYmFkZ2UtbWFyay1mZyk7XG5cdFx0fVxuXG5cdFx0QG1lZGlhIChtYXgtd2lkdGg6IDcwMHB4KSB7XG5cdFx0XHQjJHtCQURHRV9JRH0ge1xuXHRcdFx0XHRtYXJnaW4tdG9wOiA4cHg7XG5cdFx0XHR9XG5cdFx0fVxuXHRgO1xuXHRkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xufVxuXG5mdW5jdGlvbiBnZXRTdWJzY3JpcHRpb25UZW51cmUodmFsdWU6IHN0cmluZyk6IFN1YnNjcmlwdGlvblRlbnVyZSB7XG5cdGNvbnN0IGRhdGUgPSBuZXcgRGF0ZSh2YWx1ZSk7XG5cdGlmIChOdW1iZXIuaXNOYU4oZGF0ZS5nZXRUaW1lKCkpKSB7XG5cdFx0cmV0dXJuIHsgdmFsdWU6IDAsIHVuaXQ6IFwiRFwiIH07XG5cdH1cblxuXHRjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuXHRsZXQgeWVhcnMgPSBub3cuZ2V0RnVsbFllYXIoKSAtIGRhdGUuZ2V0RnVsbFllYXIoKTtcblx0aWYgKG5vdyA8IGdldFNoaWZ0ZWREYXRlKGRhdGUsIHllYXJzLCBcInllYXJcIikpIHtcblx0XHR5ZWFycyAtPSAxO1xuXHR9XG5cdGlmICh5ZWFycyA+PSAxKSB7XG5cdFx0cmV0dXJuIHsgdmFsdWU6IHllYXJzLCB1bml0OiBcIllcIiB9O1xuXHR9XG5cblx0bGV0IG1vbnRocyA9XG5cdFx0KG5vdy5nZXRGdWxsWWVhcigpIC0gZGF0ZS5nZXRGdWxsWWVhcigpKSAqIDEyICtcblx0XHRub3cuZ2V0TW9udGgoKSAtXG5cdFx0ZGF0ZS5nZXRNb250aCgpO1xuXHRpZiAobm93IDwgZ2V0U2hpZnRlZERhdGUoZGF0ZSwgbW9udGhzLCBcIm1vbnRoXCIpKSB7XG5cdFx0bW9udGhzIC09IDE7XG5cdH1cblx0aWYgKG1vbnRocyA+PSAxKSB7XG5cdFx0cmV0dXJuIHsgdmFsdWU6IG1vbnRocywgdW5pdDogXCJNXCIgfTtcblx0fVxuXG5cdGNvbnN0IGRheXMgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChub3cuZ2V0VGltZSgpIC0gZGF0ZS5nZXRUaW1lKCkpIC8gTVNfUEVSX0RBWSkpO1xuXHRyZXR1cm4geyB2YWx1ZTogZGF5cywgdW5pdDogXCJEXCIgfTtcbn1cblxuZnVuY3Rpb24gZ2V0U2hpZnRlZERhdGUoZGF0ZTogRGF0ZSwgYW1vdW50OiBudW1iZXIsIHVuaXQ6IFwieWVhclwiIHwgXCJtb250aFwiKSB7XG5cdGNvbnN0IHNoaWZ0ZWQgPSBuZXcgRGF0ZShkYXRlKTtcblx0aWYgKHVuaXQgPT09IFwieWVhclwiKSB7XG5cdFx0c2hpZnRlZC5zZXRGdWxsWWVhcihkYXRlLmdldEZ1bGxZZWFyKCkgKyBhbW91bnQpO1xuXHR9IGVsc2Uge1xuXHRcdHNoaWZ0ZWQuc2V0TW9udGgoZGF0ZS5nZXRNb250aCgpICsgYW1vdW50KTtcblx0fVxuXHRyZXR1cm4gc2hpZnRlZDtcbn1cblxuZnVuY3Rpb24gZm9ybWF0VGVudXJlTWFyayh0ZW51cmU6IFN1YnNjcmlwdGlvblRlbnVyZSkge1xuXHRyZXR1cm4gYCR7dGVudXJlLnZhbHVlfSR7dGVudXJlLnVuaXR9YDtcbn1cblxuZnVuY3Rpb24gZm9ybWF0VGVudXJlKHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlKSB7XG5cdGNvbnN0IHVuaXQgPVxuXHRcdHRlbnVyZS51bml0ID09PSBcIllcIiA/IFwieWVhclwiIDogdGVudXJlLnVuaXQgPT09IFwiTVwiID8gXCJtb250aFwiIDogXCJkYXlcIjtcblx0cmV0dXJuIGAke3RlbnVyZS52YWx1ZX0gJHt1bml0fSR7dGVudXJlLnZhbHVlID09PSAxID8gXCJcIiA6IFwic1wifWA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdERhdGUodmFsdWU6IHN0cmluZykge1xuXHRjb25zdCBkYXRlID0gbmV3IERhdGUodmFsdWUpO1xuXHRpZiAoTnVtYmVyLmlzTmFOKGRhdGUuZ2V0VGltZSgpKSkge1xuXHRcdHJldHVybiB2YWx1ZTtcblx0fVxuXG5cdHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCh1bmRlZmluZWQsIHtcblx0XHRtb250aDogXCJsb25nXCIsXG5cdFx0ZGF5OiBcIm51bWVyaWNcIixcblx0XHR5ZWFyOiBcIm51bWVyaWNcIixcblx0fSkuZm9ybWF0KGRhdGUpO1xufVxuXG5mdW5jdGlvbiBnZXRTdWJzY3JpYmVTdXJmYWNlVGV4dCgpIHtcblx0Y29uc3QgdGFyZ2V0ID0gZmluZFN1YnNjcmliZVN1cmZhY2UoKTtcblxuXHRyZXR1cm4gW1xuXHRcdHRhcmdldD8udGV4dENvbnRlbnQsXG5cdFx0dGFyZ2V0Py5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpLFxuXHRcdHRhcmdldD8uZ2V0QXR0cmlidXRlKFwidGl0bGVcIiksXG5cdF1cblx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0LmpvaW4oXCIgXCIpXG5cdFx0LnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZmluZFN1YnNjcmliZVN1cmZhY2UoKSB7XG5cdGNvbnN0IGNoYW5uZWxTZWxlY3RvcnMgPSBbXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtcGFnZS1oZWFkZXItcmVuZGVyZXIgeXRkLXN1YnNjcmliZS1idXR0b24tcmVuZGVyZXJcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciBidXR0b25bYXJpYS1sYWJlbCo9J1N1YnNjcmliZSddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtcGFnZS1oZWFkZXItcmVuZGVyZXIgYnV0dG9uW2FyaWEtbGFiZWwqPSdTdWJzY3JpYmVkJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0LXBhZ2UtaGVhZGVyLXZpZXctbW9kZWwgeXRkLXN1YnNjcmliZS1idXR0b24tcmVuZGVyZXJcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0LXBhZ2UtaGVhZGVyLXZpZXctbW9kZWwgYnV0dG9uW2FyaWEtbGFiZWwqPSdTdWJzY3JpYmUnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCBidXR0b25bYXJpYS1sYWJlbCo9J1N1YnNjcmliZWQnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgeXRkLXN1YnNjcmliZS1idXR0b24tcmVuZGVyZXJcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1jNC10YWJiZWQtaGVhZGVyLXJlbmRlcmVyIGJ1dHRvblthcmlhLWxhYmVsKj0nU3Vic2NyaWJlJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1jNC10YWJiZWQtaGVhZGVyLXJlbmRlcmVyIGJ1dHRvblthcmlhLWxhYmVsKj0nU3Vic2NyaWJlZCddXCIsXG5cdF07XG5cblx0Zm9yIChjb25zdCBzZWxlY3RvciBvZiBjaGFubmVsU2VsZWN0b3JzKSB7XG5cdFx0Y29uc3QgZWxlbWVudCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsZWN0b3IpO1xuXHRcdGlmIChlbGVtZW50IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpIHtcblx0XHRcdHJldHVybiBlbGVtZW50O1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBpc1N0YXR1c1Jlc3BvbnNlKHJlc3BvbnNlOiBFeHRlbnNpb25SZXNwb25zZSk6IHJlc3BvbnNlIGlzIFN0YXR1c1Jlc3BvbnNlIHtcblx0cmV0dXJuIFwiYXV0aFN0YXR1c1wiIGluIHJlc3BvbnNlO1xufVxuIiwiZnVuY3Rpb24gcHJpbnQobWV0aG9kLCAuLi5hcmdzKSB7XG4gIGlmIChpbXBvcnQubWV0YS5lbnYuTU9ERSA9PT0gXCJwcm9kdWN0aW9uXCIpIHJldHVybjtcbiAgaWYgKHR5cGVvZiBhcmdzWzBdID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGFyZ3Muc2hpZnQoKTtcbiAgICBtZXRob2QoYFt3eHRdICR7bWVzc2FnZX1gLCAuLi5hcmdzKTtcbiAgfSBlbHNlIHtcbiAgICBtZXRob2QoXCJbd3h0XVwiLCAuLi5hcmdzKTtcbiAgfVxufVxuZXhwb3J0IGNvbnN0IGxvZ2dlciA9IHtcbiAgZGVidWc6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmRlYnVnLCAuLi5hcmdzKSxcbiAgbG9nOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5sb2csIC4uLmFyZ3MpLFxuICB3YXJuOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS53YXJuLCAuLi5hcmdzKSxcbiAgZXJyb3I6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmVycm9yLCAuLi5hcmdzKVxufTtcbiIsImltcG9ydCB7IGJyb3dzZXIgfSBmcm9tIFwid3h0L2Jyb3dzZXJcIjtcbmV4cG9ydCBjbGFzcyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IGV4dGVuZHMgRXZlbnQge1xuICBjb25zdHJ1Y3RvcihuZXdVcmwsIG9sZFVybCkge1xuICAgIHN1cGVyKFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQuRVZFTlRfTkFNRSwge30pO1xuICAgIHRoaXMubmV3VXJsID0gbmV3VXJsO1xuICAgIHRoaXMub2xkVXJsID0gb2xkVXJsO1xuICB9XG4gIHN0YXRpYyBFVkVOVF9OQU1FID0gZ2V0VW5pcXVlRXZlbnROYW1lKFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGdldFVuaXF1ZUV2ZW50TmFtZShldmVudE5hbWUpIHtcbiAgcmV0dXJuIGAke2Jyb3dzZXI/LnJ1bnRpbWU/LmlkfToke2ltcG9ydC5tZXRhLmVudi5FTlRSWVBPSU5UfToke2V2ZW50TmFtZX1gO1xufVxuIiwiaW1wb3J0IHsgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCB9IGZyb20gXCIuL2N1c3RvbS1ldmVudHMubWpzXCI7XG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTG9jYXRpb25XYXRjaGVyKGN0eCkge1xuICBsZXQgaW50ZXJ2YWw7XG4gIGxldCBvbGRVcmw7XG4gIHJldHVybiB7XG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBsb2NhdGlvbiB3YXRjaGVyIGlzIGFjdGl2ZWx5IGxvb2tpbmcgZm9yIFVSTCBjaGFuZ2VzLiBJZiBpdCdzIGFscmVhZHkgd2F0Y2hpbmcsXG4gICAgICogdGhpcyBpcyBhIG5vb3AuXG4gICAgICovXG4gICAgcnVuKCkge1xuICAgICAgaWYgKGludGVydmFsICE9IG51bGwpIHJldHVybjtcbiAgICAgIG9sZFVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgICBpbnRlcnZhbCA9IGN0eC5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGxldCBuZXdVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgICAgICBpZiAobmV3VXJsLmhyZWYgIT09IG9sZFVybC5ocmVmKSB7XG4gICAgICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQobmV3VXJsLCBvbGRVcmwpKTtcbiAgICAgICAgICBvbGRVcmwgPSBuZXdVcmw7XG4gICAgICAgIH1cbiAgICAgIH0sIDFlMyk7XG4gICAgfVxuICB9O1xufVxuIiwiaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSBcIi4uL3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanNcIjtcbmltcG9ydCB7XG4gIGdldFVuaXF1ZUV2ZW50TmFtZVxufSBmcm9tIFwiLi9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlTG9jYXRpb25XYXRjaGVyIH0gZnJvbSBcIi4vaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanNcIjtcbmV4cG9ydCBjbGFzcyBDb250ZW50U2NyaXB0Q29udGV4dCB7XG4gIGNvbnN0cnVjdG9yKGNvbnRlbnRTY3JpcHROYW1lLCBvcHRpb25zKSB7XG4gICAgdGhpcy5jb250ZW50U2NyaXB0TmFtZSA9IGNvbnRlbnRTY3JpcHROYW1lO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gICAgdGhpcy5hYm9ydENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgaWYgKHRoaXMuaXNUb3BGcmFtZSkge1xuICAgICAgdGhpcy5saXN0ZW5Gb3JOZXdlclNjcmlwdHMoeyBpZ25vcmVGaXJzdEV2ZW50OiB0cnVlIH0pO1xuICAgICAgdGhpcy5zdG9wT2xkU2NyaXB0cygpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cygpO1xuICAgIH1cbiAgfVxuICBzdGF0aWMgU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFID0gZ2V0VW5pcXVlRXZlbnROYW1lKFxuICAgIFwid3h0OmNvbnRlbnQtc2NyaXB0LXN0YXJ0ZWRcIlxuICApO1xuICBpc1RvcEZyYW1lID0gd2luZG93LnNlbGYgPT09IHdpbmRvdy50b3A7XG4gIGFib3J0Q29udHJvbGxlcjtcbiAgbG9jYXRpb25XYXRjaGVyID0gY3JlYXRlTG9jYXRpb25XYXRjaGVyKHRoaXMpO1xuICByZWNlaXZlZE1lc3NhZ2VJZHMgPSAvKiBAX19QVVJFX18gKi8gbmV3IFNldCgpO1xuICBnZXQgc2lnbmFsKCkge1xuICAgIHJldHVybiB0aGlzLmFib3J0Q29udHJvbGxlci5zaWduYWw7XG4gIH1cbiAgYWJvcnQocmVhc29uKSB7XG4gICAgcmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLmFib3J0KHJlYXNvbik7XG4gIH1cbiAgZ2V0IGlzSW52YWxpZCgpIHtcbiAgICBpZiAoYnJvd3Nlci5ydW50aW1lLmlkID09IG51bGwpIHtcbiAgICAgIHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuc2lnbmFsLmFib3J0ZWQ7XG4gIH1cbiAgZ2V0IGlzVmFsaWQoKSB7XG4gICAgcmV0dXJuICF0aGlzLmlzSW52YWxpZDtcbiAgfVxuICAvKipcbiAgICogQWRkIGEgbGlzdGVuZXIgdGhhdCBpcyBjYWxsZWQgd2hlbiB0aGUgY29udGVudCBzY3JpcHQncyBjb250ZXh0IGlzIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBAcmV0dXJucyBBIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoY2IpO1xuICAgKiBjb25zdCByZW1vdmVJbnZhbGlkYXRlZExpc3RlbmVyID0gY3R4Lm9uSW52YWxpZGF0ZWQoKCkgPT4ge1xuICAgKiAgIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIoY2IpO1xuICAgKiB9KVxuICAgKiAvLyAuLi5cbiAgICogcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lcigpO1xuICAgKi9cbiAgb25JbnZhbGlkYXRlZChjYikge1xuICAgIHRoaXMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG4gICAgcmV0dXJuICgpID0+IHRoaXMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG4gIH1cbiAgLyoqXG4gICAqIFJldHVybiBhIHByb21pc2UgdGhhdCBuZXZlciByZXNvbHZlcy4gVXNlZnVsIGlmIHlvdSBoYXZlIGFuIGFzeW5jIGZ1bmN0aW9uIHRoYXQgc2hvdWxkbid0IHJ1blxuICAgKiBhZnRlciB0aGUgY29udGV4dCBpcyBleHBpcmVkLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBjb25zdCBnZXRWYWx1ZUZyb21TdG9yYWdlID0gYXN5bmMgKCkgPT4ge1xuICAgKiAgIGlmIChjdHguaXNJbnZhbGlkKSByZXR1cm4gY3R4LmJsb2NrKCk7XG4gICAqXG4gICAqICAgLy8gLi4uXG4gICAqIH1cbiAgICovXG4gIGJsb2NrKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgoKSA9PiB7XG4gICAgfSk7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0SW50ZXJ2YWxgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIEludGVydmFscyBjYW4gYmUgY2xlYXJlZCBieSBjYWxsaW5nIHRoZSBub3JtYWwgYGNsZWFySW50ZXJ2YWxgIGZ1bmN0aW9uLlxuICAgKi9cbiAgc2V0SW50ZXJ2YWwoaGFuZGxlciwgdGltZW91dCkge1xuICAgIGNvbnN0IGlkID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuICAgIH0sIHRpbWVvdXQpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhckludGVydmFsKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIC8qKlxuICAgKiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnNldFRpbWVvdXRgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIFRpbWVvdXRzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgc2V0VGltZW91dGAgZnVuY3Rpb24uXG4gICAqL1xuICBzZXRUaW1lb3V0KGhhbmRsZXIsIHRpbWVvdXQpIHtcbiAgICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuICAgIH0sIHRpbWVvdXQpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhclRpbWVvdXQoaWQpKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG4gICAqIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsQW5pbWF0aW9uRnJhbWVgIGZ1bmN0aW9uLlxuICAgKi9cbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgaWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKC4uLmFyZ3MpID0+IHtcbiAgICAgIGlmICh0aGlzLmlzVmFsaWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuICAgIH0pO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxBbmltYXRpb25GcmFtZShpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0SWRsZUNhbGxiYWNrYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG4gICAqIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsSWRsZUNhbGxiYWNrYCBmdW5jdGlvbi5cbiAgICovXG4gIHJlcXVlc3RJZGxlQ2FsbGJhY2soY2FsbGJhY2ssIG9wdGlvbnMpIHtcbiAgICBjb25zdCBpZCA9IHJlcXVlc3RJZGxlQ2FsbGJhY2soKC4uLmFyZ3MpID0+IHtcbiAgICAgIGlmICghdGhpcy5zaWduYWwuYWJvcnRlZCkgY2FsbGJhY2soLi4uYXJncyk7XG4gICAgfSwgb3B0aW9ucyk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNhbmNlbElkbGVDYWxsYmFjayhpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICBhZGRFdmVudExpc3RlbmVyKHRhcmdldCwgdHlwZSwgaGFuZGxlciwgb3B0aW9ucykge1xuICAgIGlmICh0eXBlID09PSBcInd4dDpsb2NhdGlvbmNoYW5nZVwiKSB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSB0aGlzLmxvY2F0aW9uV2F0Y2hlci5ydW4oKTtcbiAgICB9XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXI/LihcbiAgICAgIHR5cGUuc3RhcnRzV2l0aChcInd4dDpcIikgPyBnZXRVbmlxdWVFdmVudE5hbWUodHlwZSkgOiB0eXBlLFxuICAgICAgaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgc2lnbmFsOiB0aGlzLnNpZ25hbFxuICAgICAgfVxuICAgICk7XG4gIH1cbiAgLyoqXG4gICAqIEBpbnRlcm5hbFxuICAgKiBBYm9ydCB0aGUgYWJvcnQgY29udHJvbGxlciBhbmQgZXhlY3V0ZSBhbGwgYG9uSW52YWxpZGF0ZWRgIGxpc3RlbmVycy5cbiAgICovXG4gIG5vdGlmeUludmFsaWRhdGVkKCkge1xuICAgIHRoaXMuYWJvcnQoXCJDb250ZW50IHNjcmlwdCBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xuICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgIGBDb250ZW50IHNjcmlwdCBcIiR7dGhpcy5jb250ZW50U2NyaXB0TmFtZX1cIiBjb250ZXh0IGludmFsaWRhdGVkYFxuICAgICk7XG4gIH1cbiAgc3RvcE9sZFNjcmlwdHMoKSB7XG4gICAgd2luZG93LnBvc3RNZXNzYWdlKFxuICAgICAge1xuICAgICAgICB0eXBlOiBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUsXG4gICAgICAgIGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuICAgICAgICBtZXNzYWdlSWQ6IE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpXG4gICAgICB9LFxuICAgICAgXCIqXCJcbiAgICApO1xuICB9XG4gIHZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkge1xuICAgIGNvbnN0IGlzU2NyaXB0U3RhcnRlZEV2ZW50ID0gZXZlbnQuZGF0YT8udHlwZSA9PT0gQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFO1xuICAgIGNvbnN0IGlzU2FtZUNvbnRlbnRTY3JpcHQgPSBldmVudC5kYXRhPy5jb250ZW50U2NyaXB0TmFtZSA9PT0gdGhpcy5jb250ZW50U2NyaXB0TmFtZTtcbiAgICBjb25zdCBpc05vdER1cGxpY2F0ZSA9ICF0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5oYXMoZXZlbnQuZGF0YT8ubWVzc2FnZUlkKTtcbiAgICByZXR1cm4gaXNTY3JpcHRTdGFydGVkRXZlbnQgJiYgaXNTYW1lQ29udGVudFNjcmlwdCAmJiBpc05vdER1cGxpY2F0ZTtcbiAgfVxuICBsaXN0ZW5Gb3JOZXdlclNjcmlwdHMob3B0aW9ucykge1xuICAgIGxldCBpc0ZpcnN0ID0gdHJ1ZTtcbiAgICBjb25zdCBjYiA9IChldmVudCkgPT4ge1xuICAgICAgaWYgKHRoaXMudmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSkge1xuICAgICAgICB0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5hZGQoZXZlbnQuZGF0YS5tZXNzYWdlSWQpO1xuICAgICAgICBjb25zdCB3YXNGaXJzdCA9IGlzRmlyc3Q7XG4gICAgICAgIGlzRmlyc3QgPSBmYWxzZTtcbiAgICAgICAgaWYgKHdhc0ZpcnN0ICYmIG9wdGlvbnM/Lmlnbm9yZUZpcnN0RXZlbnQpIHJldHVybjtcbiAgICAgICAgdGhpcy5ub3RpZnlJbnZhbGlkYXRlZCgpO1xuICAgICAgfVxuICAgIH07XG4gICAgYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgY2IpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiByZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYikpO1xuICB9XG59XG4iXSwibmFtZXMiOlsiZGVmaW5pdGlvbiIsImJyb3dzZXIiLCJfYnJvd3NlciIsInByaW50IiwibG9nZ2VyIl0sIm1hcHBpbmdzIjoiOztBQUFPLFdBQVMsb0JBQW9CQSxhQUFZO0FBQzlDLFdBQU9BO0FBQUEsRUFDVDtBQ0RPLFFBQU1DLFlBQVUsV0FBVyxTQUFTLFNBQVMsS0FDaEQsV0FBVyxVQUNYLFdBQVc7QUNGUixRQUFNLFVBQVVDO0FDRGhCLFFBQU0sb0JBQW9CO0FDT2pDLFFBQUEsV0FBQTtBQUNBLFFBQUEsV0FBQTtBQUNBLFFBQUEsZ0JBQUE7QUFDQSxRQUFBLHlCQUFBO0FBQ0EsUUFBQSw4QkFBQTtBQUNBLFFBQUEsNEJBQUE7QUFDQSxRQUFBLDZCQUFBO0FBQ0EsUUFBQSx5QkFBQTtBQUNBLFFBQUEsOEJBQUE7QUFDQSxRQUFBLGdDQUFBO0FBQ0EsUUFBQSw2QkFBQTtBQUNBLFFBQUEsNEJBQUE7QUFDQSxRQUFBLGFBQUEsS0FBQSxLQUFBLEtBQUE7QUFPQSxRQUFBLGFBQUEsb0JBQUE7QUFBQSxJQUFtQyxTQUFBLENBQUEscUJBQUE7QUFBQSxJQUNILE9BQUE7QUFFOUIsVUFBQSxjQUFBO0FBQ0EsVUFBQSw0QkFBQTtBQUNBLFVBQUE7QUFPQSxVQUFBLGtCQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUEsMEJBQUE7QUFDQSxVQUFBLFdBQUE7QUFFQSxvQkFBQTtBQUNBLGdDQUFBLEtBQUE7QUFDQSx3QkFBQTtBQUNBLCtCQUFBO0FBQ0EsMkJBQUE7QUFDQSwwQkFBQTtBQUNBLG9DQUFBO0FBRUEsZUFBQSwyQkFBQTtBQUNDLFlBQUEsV0FBQSxTQUFBO0FBQ0EsY0FBQSxtQkFBQSxDQUFBLGVBQUE7QUFDQyxjQUFBLENBQUEsVUFBQTtBQUNDO0FBQUEsVUFBQTtBQUdELGNBQUEs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
content;