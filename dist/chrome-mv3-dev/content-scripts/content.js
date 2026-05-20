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
  const fullDateFormatter = new Intl.DateTimeFormat(void 0, {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
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
          if (!isActive) {
            return;
          }
          if (!isSupportedYouTubePage()) {
            lastPageKey = `${location.href}|none`;
            removeBadge();
            return;
          }
          const channelId = await findCurrentChannelId();
          const pageKey = `${location.href}|${channelId ?? "none"}`;
          if (!isActive) {
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
    return fullDateFormatter.format(date);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vQHd4dC1kZXYrYnJvd3NlckAwLjEuNC9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vLi4vc3JjL2xpYi9tZXNzYWdlcy50cyIsIi4uLy4uLy4uL3NyYy9lbnRyeXBvaW50cy9jb250ZW50L2luZGV4LnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvY3VzdG9tLWV2ZW50cy5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvY29udGVudC1zY3JpcHQtY29udGV4dC5tanMiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNvbnRlbnRTY3JpcHQoZGVmaW5pdGlvbikge1xuICByZXR1cm4gZGVmaW5pdGlvbjtcbn1cbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgX2Jyb3dzZXIgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBfYnJvd3NlcjtcbmV4cG9ydCB7fTtcbiIsImV4cG9ydCBjb25zdCBDQUNIRV9TVE9SQUdFX0tFWSA9IFwic3MtY2FjaGUtc3RhdGVcIjtcblxuZXhwb3J0IHR5cGUgQXV0aFN0YXR1cyA9IFwic2lnbmVkX291dFwiIHwgXCJzaWduZWRfaW5cIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkID0ge1xuXHRzdWJzY3JpcHRpb25JZDogc3RyaW5nO1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0Y2hhbm5lbFRpdGxlOiBzdHJpbmc7XG5cdHN1YnNjcmliZWRBdDogc3RyaW5nO1xuXHRmZXRjaGVkQXQ6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIENhY2hlU3RhdGUgPSB7XG5cdGF1dGhTdGF0dXM6IEF1dGhTdGF0dXM7XG5cdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRsYXN0RXJyb3I/OiBzdHJpbmc7XG5cdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPjtcbn07XG5cbmV4cG9ydCB0eXBlIFB1YmxpY1N0YXRlID0ge1xuXHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRsYXN0RnVsbFN5bmNBdD86IHN0cmluZztcblx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHRzdWJzY3JpcHRpb25Db3VudDogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR2V0U3RhdHVzUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19HRVRfU1RBVFVTXCI7XG5cdGNoYW5uZWxJZDogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgUmVmcmVzaEFsbFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfUkVGUkVTSF9BTExcIjtcblx0aW50ZXJhY3RpdmU/OiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQXV0aFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfU0lHTl9JTlwiIHwgXCJTU19TSUdOX09VVFwiIHwgXCJTU19HRVRfU1RBVEVcIjtcbn07XG5cbmV4cG9ydCB0eXBlIFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI7XG59O1xuXG5leHBvcnQgdHlwZSBFeHRlbnNpb25SZXF1ZXN0ID1cblx0fCBHZXRTdGF0dXNSZXF1ZXN0XG5cdHwgUmVmcmVzaEFsbFJlcXVlc3Rcblx0fCBBdXRoUmVxdWVzdFxuXHR8IFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdDtcblxuZXhwb3J0IHR5cGUgU3RhdHVzUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0YXV0aFN0YXR1czogQXV0aFN0YXR1cztcblx0XHRcdHN1YnNjcmlwdGlvbj86IFN1YnNjcmlwdGlvblJlY29yZDtcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRcdFx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRcdFx0ZXJyb3I6IHN0cmluZztcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIFN0YXRlUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0c3RhdGU6IFB1YmxpY1N0YXRlO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRzdGF0ZTogUHVibGljU3RhdGU7XG5cdFx0XHRlcnJvcjogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIEV4dGVuc2lvblJlc3BvbnNlID0gU3RhdHVzUmVzcG9uc2UgfCBTdGF0ZVJlc3BvbnNlO1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlDYWNoZVN0YXRlKCk6IENhY2hlU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdGF1dGhTdGF0dXM6IFwic2lnbmVkX291dFwiLFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDoge30sXG5cdH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQge1xuXHRDQUNIRV9TVE9SQUdFX0tFWSxcblx0dHlwZSBFeHRlbnNpb25SZXNwb25zZSxcblx0dHlwZSBTdGF0dXNSZXNwb25zZSxcbn0gZnJvbSBcIi4uLy4uL2xpYi9tZXNzYWdlc1wiO1xuXG5jb25zdCBCQURHRV9JRCA9IFwic3Mtc3Vic2NyaWJlZC1zaW5jZVwiO1xuY29uc3QgU1RZTEVfSUQgPSBcInNzLXN1YnNjcmliZWQtc2luY2Utc3R5bGVcIjtcbmNvbnN0IENIQU5ORUxfSURfUkUgPSAvVUNbXFx3LV17MjAsfS87XG5jb25zdCBET01fUkVOREVSX0RFQk9VTkNFX01TID0gMzUwO1xuY29uc3QgUEFHRV9DT05URVhUX01FU1NBR0VfU09VUkNFID0gXCJzcy1zdWJzY3JpYmVkLXNpbmNlXCI7XG5jb25zdCBQQUdFX0NPTlRFWFRfUkVRVUVTVF9UWVBFID0gXCJTU19HRVRfUEFHRV9DT05URVhUX0NIQU5ORUxfSURcIjtcbmNvbnN0IFBBR0VfQ09OVEVYVF9SRVNQT05TRV9UWVBFID0gXCJTU19QQUdFX0NPTlRFWFRfQ0hBTk5FTF9JRFwiO1xuY29uc3QgUEFHRV9DT05URVhUX1NDUklQVF9JRCA9IFwic3MtcGFnZS1jb250ZXh0LWNoYW5uZWwtcmVhZGVyXCI7XG5jb25zdCBOQVZJR0FUSU9OX1JFTkRFUl9XSU5ET1dfTVMgPSAxMF8wMDA7XG5jb25zdCBOQVZJR0FUSU9OX1JFTkRFUl9JTlRFUlZBTF9NUyA9IDUwMDtcbmNvbnN0IE5BVklHQVRJT05fU0VUVExFX0RFTEFZX01TID0gNjUwO1xuY29uc3QgUEFHRV9XQVRDSERPR19JTlRFUlZBTF9NUyA9IDUwMDA7XG5jb25zdCBNU19QRVJfREFZID0gMjQgKiA2MCAqIDYwICogMTAwMDtcbmNvbnN0IGZ1bGxEYXRlRm9ybWF0dGVyID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQodW5kZWZpbmVkLCB7XG5cdG1vbnRoOiBcImxvbmdcIixcblx0ZGF5OiBcIm51bWVyaWNcIixcblx0eWVhcjogXCJudW1lcmljXCIsXG59KTtcblxudHlwZSBTdWJzY3JpcHRpb25UZW51cmUgPSB7XG5cdHZhbHVlOiBudW1iZXI7XG5cdHVuaXQ6IFwiWVwiIHwgXCJNXCIgfCBcIkRcIjtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbnRlbnRTY3JpcHQoe1xuXHRtYXRjaGVzOiBbXCIqOi8vKi55b3V0dWJlLmNvbS8qXCJdLFxuXHRtYWluKCkge1xuXHRcdGxldCBsYXN0UGFnZUtleSA9IFwiXCI7XG5cdFx0bGV0IGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBcIlwiO1xuXHRcdGxldCByZXNvbHZlZEJhZGdlOlxuXHRcdFx0fCB7XG5cdFx0XHRcdFx0cGFnZUtleTogc3RyaW5nO1xuXHRcdFx0XHRcdHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlO1xuXHRcdFx0XHRcdGRhdGVUZXh0OiBzdHJpbmc7XG5cdFx0XHQgIH1cblx0XHRcdHwgdW5kZWZpbmVkO1xuXHRcdGxldCByZW5kZXJSZXF1ZXN0SWQgPSAwO1xuXHRcdGxldCBub3RpZmljYXRpb25PYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IHVuZGVmaW5lZDtcblx0XHRsZXQgcmVuZGVyVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCByZWFkaW5lc3NUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG5cdFx0bGV0IG5hdmlnYXRpb25SZW5kZXJUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBzdWJzY3JpYmVSZXRyeVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcblx0XHRsZXQgc3Vic2NyaWJlQ2hhbmdlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBiYWRnZVJldHJ5VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBwYWdlV2F0Y2hkb2dUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBuYXZpZ2F0aW9uT2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCB1bmRlZmluZWQ7XG5cdFx0bGV0IHJlYWRpbmVzc09ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgdW5kZWZpbmVkO1xuXHRcdGxldCBuYXZpZ2F0aW9uU2V0dGxpbmdVbnRpbCA9IDA7XG5cdFx0bGV0IGlzQWN0aXZlID0gdHJ1ZTtcblxuXHRcdGluc3RhbGxTdHlsZXMoKTtcblx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRzdGFydFBhZ2VXYXRjaGRvZygpO1xuXHRcdG9ic2VydmVZb3VUdWJlTmF2aWdhdGlvbigpO1xuXHRcdG9ic2VydmVQYWdlUmVhZGluZXNzKCk7XG5cdFx0b2JzZXJ2ZUNhY2hlQ2hhbmdlcygpO1xuXHRcdG9ic2VydmVTdWJzY3JpYmVCdXR0b25DaGFuZ2VzKCk7XG5cblx0XHRmdW5jdGlvbiBvYnNlcnZlWW91VHViZU5hdmlnYXRpb24oKSB7XG5cdFx0XHRsZXQgbGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0Y29uc3QgaGFuZGxlTmF2aWdhdGlvbiA9IChjbGVhckJhZGdlOiBib29sZWFuKSA9PiB7XG5cdFx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAobG9jYXRpb24uaHJlZiAhPT0gbGFzdEhyZWYpIHtcblx0XHRcdFx0XHRsYXN0SHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdFx0c3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcChjbGVhckJhZGdlKTtcblx0XHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtbmF2aWdhdGUtc3RhcnRcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKHRydWUpO1xuXHRcdFx0fSk7XG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtbmF2aWdhdGUtZmluaXNoXCIsICgpID0+IHtcblx0XHRcdFx0bGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKHRydWUpO1xuXHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0fSk7XG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtcGFnZS1kYXRhLXVwZGF0ZWRcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0d2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCAoKSA9PiB7XG5cdFx0XHRcdHN0YXJ0TmF2aWdhdGlvblJlbmRlckxvb3AodHJ1ZSk7XG5cdFx0XHR9KTtcblx0XHRcdHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0ZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuXHRcdFx0XHRpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSBcInZpc2libGVcIikge1xuXHRcdFx0XHRcdHN0YXJ0TmF2aWdhdGlvblJlbmRlckxvb3AoZmFsc2UpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblxuXHRcdFx0bmF2aWdhdGlvbk9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuXHRcdFx0XHRoYW5kbGVOYXZpZ2F0aW9uKHRydWUpO1xuXHRcdFx0fSk7XG5cdFx0XHRuYXZpZ2F0aW9uT2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudCwgeyBzdWJ0cmVlOiB0cnVlLCBjaGlsZExpc3Q6IHRydWUgfSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gb2JzZXJ2ZVBhZ2VSZWFkaW5lc3MoKSB7XG5cdFx0XHRyZWFkaW5lc3NPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNTdXBwb3J0ZWRZb3VUdWJlUGFnZSgpKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHJlYWRpbmVzc1RpbWVyKSB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHJlYWRpbmVzc1RpbWVyKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJlYWRpbmVzc1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCQURHRV9JRCk7XG5cdFx0XHRcdFx0Y29uc3QgY2hhbm5lbElkID0gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tRG9tKCk7XG5cblx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHQhYmFkZ2UgfHxcblx0XHRcdFx0XHRcdCFjaGFubmVsSWQgfHxcblx0XHRcdFx0XHRcdGJhZGdlLmRhdGFzZXQuc3NDaGFubmVsSWQgIT09IGNoYW5uZWxJZCB8fFxuXHRcdFx0XHRcdFx0YmFkZ2UuZGF0YXNldC5zc0hyZWYgIT09IGxvY2F0aW9uLmhyZWYgfHxcblx0XHRcdFx0XHRcdCFmaW5kQmFkZ2VUYXJnZXQoZmFsc2UpXG5cdFx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0XHRzY2hlZHVsZVJlbmRlcigpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSwgRE9NX1JFTkRFUl9ERUJPVU5DRV9NUyk7XG5cdFx0XHR9KTtcblx0XHRcdHJlYWRpbmVzc09ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQsIHsgc3VidHJlZTogdHJ1ZSwgY2hpbGRMaXN0OiB0cnVlIH0pO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN0YXJ0UGFnZVdhdGNoZG9nKCkge1xuXHRcdFx0bGV0IGxhc3RPYnNlcnZlZEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXG5cdFx0XHRwYWdlV2F0Y2hkb2dUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChsb2NhdGlvbi5ocmVmICE9PSBsYXN0T2JzZXJ2ZWRIcmVmKSB7XG5cdFx0XHRcdFx0bGFzdE9ic2VydmVkSHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdFx0c3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcCh0cnVlKTtcblx0XHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChkb2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09IFwiaGlkZGVuXCIgfHwgIWlzU3VwcG9ydGVkWW91VHViZVBhZ2UoKSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0IWhhc0NvbmZpcm1lZE5vU3Vic2NyaXB0aW9uRm9yQ3VycmVudEhyZWYoKSAmJlxuXHRcdFx0XHRcdCghYmFkZ2UgfHwgYmFkZ2UuZGF0YXNldC5zc0hyZWYgIT09IGxvY2F0aW9uLmhyZWYgfHwgIWZpbmRCYWRnZVRhcmdldChmYWxzZSkpXG5cdFx0XHRcdCkge1xuXHRcdFx0XHRcdHNjaGVkdWxlUmVuZGVyKCk7XG5cdFx0XHRcdH1cblx0XHRcdH0sIFBBR0VfV0FUQ0hET0dfSU5URVJWQUxfTVMpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGhhc0NvbmZpcm1lZE5vU3Vic2NyaXB0aW9uRm9yQ3VycmVudEhyZWYoKSB7XG5cdFx0XHRyZXR1cm4gbGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleS5zdGFydHNXaXRoKGAke2xvY2F0aW9uLmhyZWZ9fGApO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIG9ic2VydmVDYWNoZUNoYW5nZXMoKSB7XG5cdFx0XHRicm93c2VyLnN0b3JhZ2Uub25DaGFuZ2VkLmFkZExpc3RlbmVyKChjaGFuZ2VzLCBhcmVhTmFtZSkgPT4ge1xuXHRcdFx0XHRpZiAoYXJlYU5hbWUgPT09IFwibG9jYWxcIiAmJiBDQUNIRV9TVE9SQUdFX0tFWSBpbiBjaGFuZ2VzKSB7XG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0XHRcdGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0c2NoZWR1bGVSZW5kZXIoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gb2JzZXJ2ZVN1YnNjcmliZUJ1dHRvbkNoYW5nZXMoKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0bm90aWZpY2F0aW9uT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcblxuXHRcdFx0Y29uc3QgdGFyZ2V0ID0gZmluZFN1YnNjcmliZVN1cmZhY2UoKTtcblxuXHRcdFx0aWYgKCF0YXJnZXQpIHtcblx0XHRcdFx0aWYgKHN1YnNjcmliZVJldHJ5VGltZXIpIHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQoc3Vic2NyaWJlUmV0cnlUaW1lcik7XG5cdFx0XHRcdH1cblx0XHRcdFx0c3Vic2NyaWJlUmV0cnlUaW1lciA9IHNldFRpbWVvdXQob2JzZXJ2ZVN1YnNjcmliZUJ1dHRvbkNoYW5nZXMsIDEwMDApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGxldCBsYXN0VGV4dCA9IGdldFN1YnNjcmliZVN1cmZhY2VUZXh0KCk7XG5cdFx0XHRub3RpZmljYXRpb25PYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IG5leHRUZXh0ID0gZ2V0U3Vic2NyaWJlU3VyZmFjZVRleHQoKTtcblx0XHRcdFx0aWYgKG5leHRUZXh0ID09PSBsYXN0VGV4dCkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGxhc3RUZXh0ID0gbmV4dFRleHQ7XG5cdFx0XHRcdGxhc3RQYWdlS2V5ID0gXCJcIjtcblx0XHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdHZvaWQgc2VuZFJ1bnRpbWVNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiBcIlNTX1ZJU0lCTEVfU1VCU0NSSVBUSU9OX0NIQU5HRURcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHN1YnNjcmliZUNoYW5nZVRpbWVyID0gc2V0VGltZW91dChzY2hlZHVsZVJlbmRlciwgMzUwMCk7XG5cdFx0XHR9KTtcblxuXHRcdFx0bm90aWZpY2F0aW9uT2JzZXJ2ZXIub2JzZXJ2ZSh0YXJnZXQsIHtcblx0XHRcdFx0c3VidHJlZTogdHJ1ZSxcblx0XHRcdFx0Y2hpbGRMaXN0OiB0cnVlLFxuXHRcdFx0XHRjaGFyYWN0ZXJEYXRhOiB0cnVlLFxuXHRcdFx0XHRhdHRyaWJ1dGVzOiB0cnVlLFxuXHRcdFx0XHRhdHRyaWJ1dGVGaWx0ZXI6IFtcImFyaWEtbGFiZWxcIiwgXCJ0aXRsZVwiXSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHNjaGVkdWxlUmVuZGVyKGRlbGF5ID0gMjUwKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHJlbmRlclRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChyZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG5hdmlnYXRpb25TZXR0bGVEZWxheSA9IE1hdGgubWF4KDAsIG5hdmlnYXRpb25TZXR0bGluZ1VudGlsIC0gRGF0ZS5ub3coKSk7XG5cdFx0XHRyZW5kZXJUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR2b2lkIHJlbmRlckZvckN1cnJlbnRQYWdlKCk7XG5cdFx0XHR9LCBNYXRoLm1heChkZWxheSwgbmF2aWdhdGlvblNldHRsZURlbGF5KSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gc3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcChjbGVhckJhZGdlOiBib29sZWFuKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0bGFzdFBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRyZXNvbHZlZEJhZGdlID0gdW5kZWZpbmVkO1xuXHRcdFx0aWYgKGNsZWFyQmFkZ2UpIHtcblx0XHRcdFx0bmF2aWdhdGlvblNldHRsaW5nVW50aWwgPSBEYXRlLm5vdygpICsgTkFWSUdBVElPTl9TRVRUTEVfREVMQVlfTVM7XG5cdFx0XHRcdHJlbW92ZVN0YWxlQmFkZ2UoKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG5hdmlnYXRpb25SZW5kZXJUaW1lcikge1xuXHRcdFx0XHRjbGVhckludGVydmFsKG5hdmlnYXRpb25SZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHN0b3BBdCA9IERhdGUubm93KCkgKyBOQVZJR0FUSU9OX1JFTkRFUl9XSU5ET1dfTVM7XG5cdFx0XHRzY2hlZHVsZVJlbmRlcigpO1xuXHRcdFx0bmF2aWdhdGlvblJlbmRlclRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0XHRpZiAoRGF0ZS5ub3coKSA+IHN0b3BBdCkge1xuXHRcdFx0XHRcdGlmIChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpIHtcblx0XHRcdFx0XHRcdGNsZWFySW50ZXJ2YWwobmF2aWdhdGlvblJlbmRlclRpbWVyKTtcblx0XHRcdFx0XHRcdG5hdmlnYXRpb25SZW5kZXJUaW1lciA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0c2NoZWR1bGVSZW5kZXIoKTtcblx0XHRcdH0sIE5BVklHQVRJT05fUkVOREVSX0lOVEVSVkFMX01TKTtcblx0XHR9XG5cblx0XHRhc3luYyBmdW5jdGlvbiByZW5kZXJGb3JDdXJyZW50UGFnZSgpIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByZXF1ZXN0SWQgPSArK3JlbmRlclJlcXVlc3RJZDtcblxuXHRcdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKCFpc1N1cHBvcnRlZFlvdVR1YmVQYWdlKCkpIHtcblx0XHRcdFx0XHRsYXN0UGFnZUtleSA9IGAke2xvY2F0aW9uLmhyZWZ9fG5vbmVgO1xuXHRcdFx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgY2hhbm5lbElkID0gYXdhaXQgZmluZEN1cnJlbnRDaGFubmVsSWQoKTtcblx0XHRcdFx0Y29uc3QgcGFnZUtleSA9IGAke2xvY2F0aW9uLmhyZWZ9fCR7Y2hhbm5lbElkID8/IFwibm9uZVwifWA7XG5cblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGV4aXN0aW5nQmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCQURHRV9JRCk7XG5cdFx0XHRcdGlmICghY2hhbm5lbElkKSB7XG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBwYWdlS2V5O1xuXHRcdFx0XHRcdGlmIChleGlzdGluZ0JhZGdlPy5kYXRhc2V0LnNzSHJlZiAhPT0gbG9jYXRpb24uaHJlZikge1xuXHRcdFx0XHRcdFx0cmVtb3ZlQmFkZ2UoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKFxuXHRcdFx0XHRcdGxhc3RQYWdlS2V5ID09PSBwYWdlS2V5ICYmXG5cdFx0XHRcdFx0ZXhpc3RpbmdCYWRnZT8uZGF0YXNldC5zc1BhZ2VLZXkgPT09IHBhZ2VLZXkgJiZcblx0XHRcdFx0XHRleGlzdGluZ0JhZGdlLmRhdGFzZXQuc3NIcmVmID09PSBsb2NhdGlvbi5ocmVmXG5cdFx0XHRcdCkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGxhc3RQYWdlS2V5ID0gcGFnZUtleTtcblxuXHRcdFx0XHRpZiAocmVzb2x2ZWRCYWRnZT8ucGFnZUtleSA9PT0gcGFnZUtleSkge1xuXHRcdFx0XHRcdGluc2VydEJhZGdlKHtcblx0XHRcdFx0XHRcdGNoYW5uZWxJZCxcblx0XHRcdFx0XHRcdHRlbnVyZTogcmVzb2x2ZWRCYWRnZS50ZW51cmUsXG5cdFx0XHRcdFx0XHRkYXRlVGV4dDogcmVzb2x2ZWRCYWRnZS5kYXRlVGV4dCxcblx0XHRcdFx0XHRcdHBhZ2VLZXksXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPT09IHBhZ2VLZXkpIHtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHNlbmRSdW50aW1lTWVzc2FnZSh7XG5cdFx0XHRcdFx0dHlwZTogXCJTU19HRVRfU1RBVFVTXCIsXG5cdFx0XHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRpZiAoIXJlc3BvbnNlIHx8IHJlcXVlc3RJZCAhPT0gcmVuZGVyUmVxdWVzdElkIHx8ICFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNTdGF0dXNSZXNwb25zZShyZXNwb25zZSkgfHwgIXJlc3BvbnNlLm9rIHx8ICFyZXNwb25zZS5zdWJzY3JpcHRpb24pIHtcblx0XHRcdFx0XHRsYXN0Tm9TdWJzY3JpcHRpb25QYWdlS2V5ID0gcGFnZUtleTtcblx0XHRcdFx0XHRyZXNvbHZlZEJhZGdlID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB7XG5cdFx0XHRcdFx0cGFnZUtleSxcblx0XHRcdFx0XHR0ZW51cmU6IGdldFN1YnNjcmlwdGlvblRlbnVyZShyZXNwb25zZS5zdWJzY3JpcHRpb24uc3Vic2NyaWJlZEF0KSxcblx0XHRcdFx0XHRkYXRlVGV4dDogZm9ybWF0RGF0ZShyZXNwb25zZS5zdWJzY3JpcHRpb24uc3Vic2NyaWJlZEF0KSxcblx0XHRcdFx0fTtcblx0XHRcdFx0aW5zZXJ0QmFkZ2Uoe1xuXHRcdFx0XHRcdGNoYW5uZWxJZCxcblx0XHRcdFx0XHR0ZW51cmU6IHJlc29sdmVkQmFkZ2UudGVudXJlLFxuXHRcdFx0XHRcdGRhdGVUZXh0OiByZXNvbHZlZEJhZGdlLmRhdGVUZXh0LFxuXHRcdFx0XHRcdHBhZ2VLZXksXG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0aGFuZGxlRXh0ZW5zaW9uRXJyb3IoZXJyb3IpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGluc2VydEJhZGdlKHtcblx0XHRcdGNoYW5uZWxJZCxcblx0XHRcdHRlbnVyZSxcblx0XHRcdGRhdGVUZXh0LFxuXHRcdFx0cGFnZUtleSxcblx0XHR9OiB7XG5cdFx0XHRjaGFubmVsSWQ6IHN0cmluZztcblx0XHRcdHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlO1xuXHRcdFx0ZGF0ZVRleHQ6IHN0cmluZztcblx0XHRcdHBhZ2VLZXk6IHN0cmluZztcblx0XHR9KSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgdGFyZ2V0ID0gZmluZEJhZGdlVGFyZ2V0KCk7XG5cdFx0XHRpZiAoIXRhcmdldCkge1xuXHRcdFx0XHRpZiAoYmFkZ2VSZXRyeVRpbWVyKSB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KGJhZGdlUmV0cnlUaW1lcik7XG5cdFx0XHRcdH1cblx0XHRcdFx0YmFkZ2VSZXRyeVRpbWVyID0gc2V0VGltZW91dChzY2hlZHVsZVJlbmRlciwgNTAwKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJBREdFX0lEKTtcblx0XHRcdGlmIChleGlzdGluZz8ucGFyZW50RWxlbWVudCA9PT0gdGFyZ2V0KSB7XG5cdFx0XHRcdGV4aXN0aW5nLmRhdGFzZXQuc3NDaGFubmVsSWQgPSBjaGFubmVsSWQ7XG5cdFx0XHRcdGV4aXN0aW5nLmRhdGFzZXQuc3NIcmVmID0gbG9jYXRpb24uaHJlZjtcblx0XHRcdFx0ZXhpc3RpbmcuZGF0YXNldC5zc1BhZ2VLZXkgPSBwYWdlS2V5O1xuXHRcdFx0XHRleGlzdGluZy5zZXRBdHRyaWJ1dGUoXG5cdFx0XHRcdFx0XCJhcmlhLWxhYmVsXCIsXG5cdFx0XHRcdFx0YFN1YnNjcmliZWQgc2luY2UgJHtkYXRlVGV4dH0sICR7Zm9ybWF0VGVudXJlKHRlbnVyZSl9YFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRleGlzdGluZy5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtc3MtdGVudXJlXVwiKSEudGV4dENvbnRlbnQgPVxuXHRcdFx0XHRcdGZvcm1hdFRlbnVyZU1hcmsodGVudXJlKTtcblx0XHRcdFx0ZXhpc3RpbmcucXVlcnlTZWxlY3RvcihcIltkYXRhLXNzLWRhdGVdXCIpIS50ZXh0Q29udGVudCA9IGRhdGVUZXh0O1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0XHR0YXJnZXQuYXBwZW5kQ2hpbGQoY3JlYXRlQmFkZ2UoeyBjaGFubmVsSWQsIHRlbnVyZSwgZGF0ZVRleHQsIHBhZ2VLZXkgfSkpO1xuXHRcdH1cblxuXHRcdGFzeW5jIGZ1bmN0aW9uIHNlbmRSdW50aW1lTWVzc2FnZShtZXNzYWdlOiB1bmtub3duKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0cmV0dXJuIChhd2FpdCBicm93c2VyLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobWVzc2FnZSkpIGFzIEV4dGVuc2lvblJlc3BvbnNlO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0aGFuZGxlRXh0ZW5zaW9uRXJyb3IoZXJyb3IpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGhhbmRsZUV4dGVuc2lvbkVycm9yKGVycm9yOiB1bmtub3duKSB7XG5cdFx0XHRpZiAoaXNFeHRlbnNpb25Db250ZXh0SW52YWxpZGF0ZWRFcnJvcihlcnJvcikpIHtcblx0XHRcdFx0c3RvcENvbnRlbnRTY3JpcHQoKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRmdW5jdGlvbiBzdG9wQ29udGVudFNjcmlwdCgpIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpc0FjdGl2ZSA9IGZhbHNlO1xuXHRcdFx0cmVuZGVyUmVxdWVzdElkICs9IDE7XG5cdFx0XHRub3RpZmljYXRpb25PYnNlcnZlcj8uZGlzY29ubmVjdCgpO1xuXHRcdFx0bmF2aWdhdGlvbk9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG5cdFx0XHRyZWFkaW5lc3NPYnNlcnZlcj8uZGlzY29ubmVjdCgpO1xuXHRcdFx0Y2xlYXJNYW5hZ2VkVGltZXJzKCk7XG5cdFx0XHRyZW1vdmVCYWRnZSgpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGNsZWFyTWFuYWdlZFRpbWVycygpIHtcblx0XHRcdGlmIChyZW5kZXJUaW1lcikge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQocmVuZGVyVGltZXIpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHJlYWRpbmVzc1RpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChyZWFkaW5lc3NUaW1lcik7XG5cdFx0XHR9XG5cdFx0XHRpZiAoc3Vic2NyaWJlUmV0cnlUaW1lcikge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQoc3Vic2NyaWJlUmV0cnlUaW1lcik7XG5cdFx0XHR9XG5cdFx0XHRpZiAoc3Vic2NyaWJlQ2hhbmdlVGltZXIpIHtcblx0XHRcdFx0Y2xlYXJUaW1lb3V0KHN1YnNjcmliZUNoYW5nZVRpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChiYWRnZVJldHJ5VGltZXIpIHtcblx0XHRcdFx0Y2xlYXJUaW1lb3V0KGJhZGdlUmV0cnlUaW1lcik7XG5cdFx0XHR9XG5cdFx0XHRpZiAobmF2aWdhdGlvblJlbmRlclRpbWVyKSB7XG5cdFx0XHRcdGNsZWFySW50ZXJ2YWwobmF2aWdhdGlvblJlbmRlclRpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChwYWdlV2F0Y2hkb2dUaW1lcikge1xuXHRcdFx0XHRjbGVhckludGVydmFsKHBhZ2VXYXRjaGRvZ1RpbWVyKTtcblx0XHRcdH1cblx0XHR9XG5cdH0sXG59KTtcblxuZnVuY3Rpb24gaXNTdXBwb3J0ZWRZb3VUdWJlUGFnZSgpIHtcblx0cmV0dXJuIGlzQ2hhbm5lbFBhZ2UoKTtcbn1cblxuZnVuY3Rpb24gaXNDaGFubmVsUGFnZShwYXRoID0gbG9jYXRpb24ucGF0aG5hbWUpIHtcblx0cmV0dXJuIChcblx0XHRwYXRoLnN0YXJ0c1dpdGgoXCIvQFwiKSB8fFxuXHRcdHBhdGguc3RhcnRzV2l0aChcIi9jaGFubmVsL1wiKSB8fFxuXHRcdHBhdGguc3RhcnRzV2l0aChcIi9jL1wiKSB8fFxuXHRcdHBhdGguc3RhcnRzV2l0aChcIi91c2VyL1wiKVxuXHQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmaW5kQ3VycmVudENoYW5uZWxJZCgpIHtcblx0Y29uc3QgcGF0aCA9IGxvY2F0aW9uLnBhdGhuYW1lO1xuXHRjb25zdCBwYXRoQ2hhbm5lbElkID0gbWF0Y2hDaGFubmVsSWQocGF0aCk7XG5cdGlmIChwYXRoQ2hhbm5lbElkKSB7XG5cdFx0cmV0dXJuIHBhdGhDaGFubmVsSWQ7XG5cdH1cblxuXHRpZiAoIWlzQ2hhbm5lbFBhZ2UocGF0aCkpIHtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0cmV0dXJuIChcblx0XHQoYXdhaXQgZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tUGFnZUNvbnRleHQoKSkgPz8gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tRG9tKClcblx0KTtcbn1cblxuZnVuY3Rpb24gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tRG9tKCkge1xuXHRjb25zdCBjaGFubmVsU2VsZWN0b3JzID0gW1xuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10gbWV0YVtpdGVtcHJvcD0nY2hhbm5lbElkJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciBhW2hyZWYqPScvY2hhbm5lbC8nXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCBhW2hyZWYqPScvY2hhbm5lbC8nXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgYVtocmVmKj0nL2NoYW5uZWwvJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddICNjaGFubmVsLWhlYWRlciBhW2hyZWYqPScvY2hhbm5lbC8nXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10gI3BhZ2UtaGVhZGVyIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJtZXRhW2l0ZW1wcm9wPSdjaGFubmVsSWQnXVwiLFxuXHRcdFwibGlua1tyZWw9J2Nhbm9uaWNhbCddXCIsXG5cdFx0XCJsaW5rW2l0ZW1wcm9wPSd1cmwnXVwiLFxuXHRdO1xuXG5cdGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgY2hhbm5lbFNlbGVjdG9ycykge1xuXHRcdGNvbnN0IGVsZW1lbnQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbGVjdG9yKTtcblx0XHRjb25zdCB2YWx1ZSA9XG5cdFx0XHRlbGVtZW50Py5nZXRBdHRyaWJ1dGUoXCJjb250ZW50XCIpID8/XG5cdFx0XHRlbGVtZW50Py5nZXRBdHRyaWJ1dGUoXCJocmVmXCIpID8/XG5cdFx0XHRlbGVtZW50Py50ZXh0Q29udGVudDtcblx0XHRjb25zdCBjaGFubmVsSWQgPSBtYXRjaENoYW5uZWxJZCh2YWx1ZSk7XG5cdFx0aWYgKGNoYW5uZWxJZCkge1xuXHRcdFx0cmV0dXJuIGNoYW5uZWxJZDtcblx0XHR9XG5cdH1cblxuXHRjb25zdCBicm93c2UgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ11cIik7XG5cdGNvbnN0IGhlYWRlckNoYW5uZWxJZCA9IG1hdGNoQ2hhbm5lbElkKFxuXHRcdGJyb3dzZVxuXHRcdFx0Py5xdWVyeVNlbGVjdG9yKFxuXHRcdFx0XHRcInl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciwgeXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCwgeXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIsICNjaGFubmVsLWhlYWRlciwgI3BhZ2UtaGVhZGVyXCJcblx0XHRcdClcblx0XHRcdD8uaW5uZXJIVE1MXG5cdCk7XG5cdGlmIChoZWFkZXJDaGFubmVsSWQpIHtcblx0XHRyZXR1cm4gaGVhZGVyQ2hhbm5lbElkO1xuXHR9XG59XG5cbmZ1bmN0aW9uIG1hdGNoQ2hhbm5lbElkKHZhbHVlPzogc3RyaW5nIHwgbnVsbCkge1xuXHRyZXR1cm4gdmFsdWU/Lm1hdGNoKENIQU5ORUxfSURfUkUpPy5bMF07XG59XG5cbmZ1bmN0aW9uIGZpbmRDdXJyZW50Q2hhbm5lbElkRnJvbVBhZ2VDb250ZXh0KCkge1xuXHRjb25zdCByZXF1ZXN0SWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXG5cdHJldHVybiBuZXcgUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0aW5qZWN0UGFnZUNvbnRleHRDaGFubmVsSWRSZWFkZXIoKTtcblxuXHRcdGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRcdFx0cmVzb2x2ZSh1bmRlZmluZWQpO1xuXHRcdH0sIDMwMCk7XG5cblx0XHRmdW5jdGlvbiBvbk1lc3NhZ2UoZXZlbnQ6IE1lc3NhZ2VFdmVudCkge1xuXHRcdFx0aWYgKGV2ZW50LnNvdXJjZSAhPT0gd2luZG93KSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZGF0YSA9IGV2ZW50LmRhdGEgYXNcblx0XHRcdFx0fCB7XG5cdFx0XHRcdFx0XHRzb3VyY2U/OiBzdHJpbmc7XG5cdFx0XHRcdFx0XHR0eXBlPzogc3RyaW5nO1xuXHRcdFx0XHRcdFx0cmVxdWVzdElkPzogc3RyaW5nO1xuXHRcdFx0XHRcdFx0Y2hhbm5lbElkPzogc3RyaW5nO1xuXHRcdFx0XHQgIH1cblx0XHRcdFx0fCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmIChcblx0XHRcdFx0ZGF0YT8uc291cmNlICE9PSBQQUdFX0NPTlRFWFRfTUVTU0FHRV9TT1VSQ0UgfHxcblx0XHRcdFx0ZGF0YS50eXBlICE9PSBQQUdFX0NPTlRFWFRfUkVTUE9OU0VfVFlQRSB8fFxuXHRcdFx0XHRkYXRhLnJlcXVlc3RJZCAhPT0gcmVxdWVzdElkXG5cdFx0XHQpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0XHR3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgb25NZXNzYWdlKTtcblx0XHRcdHJlc29sdmUobWF0Y2hDaGFubmVsSWQoZGF0YS5jaGFubmVsSWQpKTtcblx0XHR9XG5cblx0XHR3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgb25NZXNzYWdlKTtcblx0XHR3aW5kb3cucG9zdE1lc3NhZ2UoXG5cdFx0XHR7XG5cdFx0XHRcdHNvdXJjZTogUEFHRV9DT05URVhUX01FU1NBR0VfU09VUkNFLFxuXHRcdFx0XHR0eXBlOiBQQUdFX0NPTlRFWFRfUkVRVUVTVF9UWVBFLFxuXHRcdFx0XHRyZXF1ZXN0SWQsXG5cdFx0XHR9LFxuXHRcdFx0d2luZG93LmxvY2F0aW9uLm9yaWdpblxuXHRcdCk7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBpbmplY3RQYWdlQ29udGV4dENoYW5uZWxJZFJlYWRlcigpIHtcblx0aWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFBBR0VfQ09OVEVYVF9TQ1JJUFRfSUQpKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Y29uc3Qgc2NyaXB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNjcmlwdFwiKTtcblx0c2NyaXB0LmlkID0gUEFHRV9DT05URVhUX1NDUklQVF9JRDtcblx0c2NyaXB0LnNyYyA9IGJyb3dzZXIucnVudGltZS5nZXRVUkwoXCIvcGFnZS1jb250ZXh0LWNoYW5uZWwuanNcIik7XG5cdGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5hcHBlbmRDaGlsZChzY3JpcHQpO1xufVxuXG5mdW5jdGlvbiBpc0V4dGVuc2lvbkNvbnRleHRJbnZhbGlkYXRlZEVycm9yKGVycm9yOiB1bmtub3duKSB7XG5cdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdHJldHVybiBtZXNzYWdlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJleHRlbnNpb24gY29udGV4dCBpbnZhbGlkYXRlZFwiKTtcbn1cblxuZnVuY3Rpb24gZmluZEJhZGdlVGFyZ2V0KG1hcmtIb3N0ID0gdHJ1ZSkge1xuXHRjb25zdCBjaGFubmVsQ2FuZGlkYXRlcyA9IFtcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciAjYnV0dG9uc1wiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyIHl0LWZsZXhpYmxlLWFjdGlvbnMtdmlldy1tb2RlbFwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCB5dC1mbGV4aWJsZS1hY3Rpb25zLXZpZXctbW9kZWxcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0LXBhZ2UtaGVhZGVyLXZpZXctbW9kZWwgI2J1dHRvbnNcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1jNC10YWJiZWQtaGVhZGVyLXJlbmRlcmVyICNidXR0b25zXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSAjY2hhbm5lbC1oZWFkZXIgI2J1dHRvbnNcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddICNwYWdlLWhlYWRlciAjYnV0dG9uc1wiLFxuXHRdO1xuXG5cdGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgY2hhbm5lbENhbmRpZGF0ZXMpIHtcblx0XHRjb25zdCBlbGVtZW50ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWxlY3Rvcik7XG5cdFx0aWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkge1xuXHRcdFx0aWYgKG1hcmtIb3N0KSB7XG5cdFx0XHRcdGVsZW1lbnQuY2xhc3NMaXN0LmFkZChcInNzLWJhZGdlLWhvc3RcIik7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gZWxlbWVudDtcblx0XHR9XG5cdH1cblxuXHRjb25zdCBzdWJzY3JpYmVTdXJmYWNlID0gZmluZFN1YnNjcmliZVN1cmZhY2UoKTtcblx0Y29uc3QgdGFyZ2V0ID1cblx0XHRzdWJzY3JpYmVTdXJmYWNlPy5jbG9zZXN0PEhUTUxFbGVtZW50Pihcblx0XHRcdFwieXQtZmxleGlibGUtYWN0aW9ucy12aWV3LW1vZGVsLCAjYnV0dG9ucywgI3N1YnNjcmliZS1idXR0b25cIlxuXHRcdCkgPz9cblx0XHRzdWJzY3JpYmVTdXJmYWNlPy5wYXJlbnRFbGVtZW50ID8/XG5cdFx0dW5kZWZpbmVkO1xuXG5cdGlmICh0YXJnZXQgJiYgbWFya0hvc3QpIHtcblx0XHR0YXJnZXQuY2xhc3NMaXN0LmFkZChcInNzLWJhZGdlLWhvc3RcIik7XG5cdH1cblxuXHRyZXR1cm4gdGFyZ2V0O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVCYWRnZSh7XG5cdGNoYW5uZWxJZCxcblx0dGVudXJlLFxuXHRkYXRlVGV4dCxcblx0cGFnZUtleSxcbn06IHtcblx0Y2hhbm5lbElkOiBzdHJpbmc7XG5cdHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlO1xuXHRkYXRlVGV4dDogc3RyaW5nO1xuXHRwYWdlS2V5OiBzdHJpbmc7XG59KSB7XG5cdGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG5cdGNvbnRhaW5lci5pZCA9IEJBREdFX0lEO1xuXHRjb250YWluZXIuZGF0YXNldC5zc0NoYW5uZWxJZCA9IGNoYW5uZWxJZDtcblx0Y29udGFpbmVyLmRhdGFzZXQuc3NIcmVmID0gbG9jYXRpb24uaHJlZjtcblx0Y29udGFpbmVyLmRhdGFzZXQuc3NQYWdlS2V5ID0gcGFnZUtleTtcblx0Y29udGFpbmVyLnNldEF0dHJpYnV0ZShcblx0XHRcImFyaWEtbGFiZWxcIixcblx0XHRgU3Vic2NyaWJlZCBzaW5jZSAke2RhdGVUZXh0fSwgJHtmb3JtYXRUZW51cmUodGVudXJlKX1gXG5cdCk7XG5cdGNvbnRhaW5lci5pbm5lckhUTUwgPSBgXG5cdFx0PHNwYW4gY2xhc3M9XCJzcy1iYWRnZS1tYXJrXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+XG5cdFx0XHQ8c3BhbiBjbGFzcz1cInNzLWJhZGdlLXRlbnVyZVwiIGRhdGEtc3MtdGVudXJlPiR7Zm9ybWF0VGVudXJlTWFyayh0ZW51cmUpfTwvc3Bhbj5cblx0XHQ8L3NwYW4+XG5cdFx0PHNwYW4gY2xhc3M9XCJzcy1iYWRnZS1jb3B5XCI+XG5cdFx0XHQ8c3BhbiBjbGFzcz1cInNzLWJhZGdlLXRpdGxlXCI+U1VCU0NSSUJFRCBTSU5DRTwvc3Bhbj5cblx0XHRcdDxzcGFuIGNsYXNzPVwic3MtYmFkZ2UtZGF0ZVwiIGRhdGEtc3MtZGF0ZT4ke2RhdGVUZXh0fTwvc3Bhbj5cblx0XHQ8L3NwYW4+XG5cdGA7XG5cdHJldHVybiBjb250YWluZXI7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZUJhZGdlKCkge1xuXHRkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCQURHRV9JRCk/LnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiByZW1vdmVTdGFsZUJhZGdlKCkge1xuXHRjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJBREdFX0lEKTtcblx0aWYgKCFleGlzdGluZyB8fCBleGlzdGluZy5kYXRhc2V0LnNzSHJlZiA9PT0gbG9jYXRpb24uaHJlZikge1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGV4aXN0aW5nLnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsU3R5bGVzKCkge1xuXHRpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoU1RZTEVfSUQpKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Y29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XG5cdHN0eWxlLmlkID0gU1RZTEVfSUQ7XG5cdHN0eWxlLnRleHRDb250ZW50ID0gYFxuXHRcdC5zcy1iYWRnZS1ob3N0IHtcblx0XHRcdGRpc3BsYXk6IGlubGluZS1mbGV4ICFpbXBvcnRhbnQ7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyICFpbXBvcnRhbnQ7XG5cdFx0XHRnYXA6IDEycHggIWltcG9ydGFudDtcblx0XHRcdGZsZXgtd3JhcDogd3JhcCAhaW1wb3J0YW50O1xuXHRcdH1cblxuXHRcdCMke0JBREdFX0lEfSB7XG5cdFx0XHQtLXNzLWJhZGdlLWJnOiB2YXIoLS15dC1zcGVjLWJ1dHRvbi1jaGlwLWJhY2tncm91bmQtaG92ZXIsICNmMmYyZjIpO1xuXHRcdFx0LS1zcy1iYWRnZS1mZzogdmFyKC0teXQtc3BlYy10ZXh0LXByaW1hcnksICMwZjBmMGYpO1xuXHRcdFx0LS1zcy1iYWRnZS1tYXJrLWJnOiAjY2YxYTE5O1xuXHRcdFx0LS1zcy1iYWRnZS1tYXJrLWZnOiAjZmZmO1xuXHRcdFx0ZGlzcGxheTogaW5saW5lLWZsZXg7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyO1xuXHRcdFx0Z2FwOiA4cHg7XG5cdFx0XHRib3gtc2l6aW5nOiBib3JkZXItYm94O1xuXHRcdFx0bWluLWhlaWdodDogMzZweDtcblx0XHRcdHBhZGRpbmc6IDVweCAxNHB4IDVweCA4cHg7XG5cdFx0XHRib3JkZXI6IDA7XG5cdFx0XHRib3JkZXItcmFkaXVzOiAxOHB4O1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tc3MtYmFkZ2UtYmcpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXNzLWJhZGdlLWZnKTtcblx0XHRcdGZvbnQtZmFtaWx5OiBSb2JvdG8sIEFyaWFsLCBzYW5zLXNlcmlmO1xuXHRcdFx0bGluZS1oZWlnaHQ6IDEuMTtcblx0XHRcdHdoaXRlLXNwYWNlOiBub3dyYXA7XG5cdFx0XHR2ZXJ0aWNhbC1hbGlnbjogbWlkZGxlO1xuXHRcdH1cblxuXHRcdCMke0JBREdFX0lEfSAuc3MtYmFkZ2UtbWFyayB7XG5cdFx0XHRkaXNwbGF5OiBpbmxpbmUtZ3JpZDtcblx0XHRcdHBsYWNlLWl0ZW1zOiBjZW50ZXI7XG5cdFx0XHR3aWR0aDogMjRweDtcblx0XHRcdGhlaWdodDogMjRweDtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDUwJTtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXNzLWJhZGdlLW1hcmstYmcpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXNzLWJhZGdlLW1hcmstZmcpO1xuXHRcdH1cblxuXHRcdCMke0JBREdFX0lEfSAuc3MtYmFkZ2UtdGVudXJlIHtcblx0XHRcdGZvbnQtc2l6ZTogMTFweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA4MDA7XG5cdFx0XHRsaW5lLWhlaWdodDogMTtcblx0XHRcdGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS1jb3B5IHtcblx0XHRcdGRpc3BsYXk6IGZsZXg7XG5cdFx0XHRmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuXHRcdFx0YWxpZ24taXRlbXM6IGZsZXgtc3RhcnQ7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS10aXRsZSB7XG5cdFx0XHRmb250LXNpemU6IDlweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA3MDA7XG5cdFx0XHRsZXR0ZXItc3BhY2luZzogMDtcblx0XHRcdG9wYWNpdHk6IDE7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS1kYXRlIHtcblx0XHRcdGZvbnQtc2l6ZTogMTFweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA3MDA7XG5cdFx0XHRvcGFjaXR5OiAxO1xuXHRcdH1cblxuXHRcdGh0bWxbZGFya10gIyR7QkFER0VfSUR9LFxuXHRcdFtkYXJrXSAjJHtCQURHRV9JRH0ge1xuXHRcdFx0LS1zcy1iYWRnZS1iZzogIzI4MjgyODtcblx0XHRcdC0tc3MtYmFkZ2UtZmc6IHZhcigtLXl0LXNwZWMtdGV4dC1wcmltYXJ5LCAjZmZmKTtcblx0XHRcdC0tc3MtYmFkZ2UtbWFyay1iZzogI2NmMWExOTtcblx0XHRcdC0tc3MtYmFkZ2UtbWFyay1mZzogI2ZmZjtcblx0XHR9XG5cblx0XHRodG1sW2RhcmtdICMke0JBREdFX0lEfSAuc3MtYmFkZ2UtbWFyayxcblx0XHRbZGFya10gIyR7QkFER0VfSUR9IC5zcy1iYWRnZS1tYXJrIHtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXNzLWJhZGdlLW1hcmstYmcpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXNzLWJhZGdlLW1hcmstZmcpO1xuXHRcdH1cblxuXHRcdEBtZWRpYSAobWF4LXdpZHRoOiA3MDBweCkge1xuXHRcdFx0IyR7QkFER0VfSUR9IHtcblx0XHRcdFx0bWFyZ2luLXRvcDogOHB4O1xuXHRcdFx0fVxuXHRcdH1cblx0YDtcblx0ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuZnVuY3Rpb24gZ2V0U3Vic2NyaXB0aW9uVGVudXJlKHZhbHVlOiBzdHJpbmcpOiBTdWJzY3JpcHRpb25UZW51cmUge1xuXHRjb25zdCBkYXRlID0gbmV3IERhdGUodmFsdWUpO1xuXHRpZiAoTnVtYmVyLmlzTmFOKGRhdGUuZ2V0VGltZSgpKSkge1xuXHRcdHJldHVybiB7IHZhbHVlOiAwLCB1bml0OiBcIkRcIiB9O1xuXHR9XG5cblx0Y29uc3Qgbm93ID0gbmV3IERhdGUoKTtcblx0bGV0IHllYXJzID0gbm93LmdldEZ1bGxZZWFyKCkgLSBkYXRlLmdldEZ1bGxZZWFyKCk7XG5cdGlmIChub3cgPCBnZXRTaGlmdGVkRGF0ZShkYXRlLCB5ZWFycywgXCJ5ZWFyXCIpKSB7XG5cdFx0eWVhcnMgLT0gMTtcblx0fVxuXHRpZiAoeWVhcnMgPj0gMSkge1xuXHRcdHJldHVybiB7IHZhbHVlOiB5ZWFycywgdW5pdDogXCJZXCIgfTtcblx0fVxuXG5cdGxldCBtb250aHMgPVxuXHRcdChub3cuZ2V0RnVsbFllYXIoKSAtIGRhdGUuZ2V0RnVsbFllYXIoKSkgKiAxMiArXG5cdFx0bm93LmdldE1vbnRoKCkgLVxuXHRcdGRhdGUuZ2V0TW9udGgoKTtcblx0aWYgKG5vdyA8IGdldFNoaWZ0ZWREYXRlKGRhdGUsIG1vbnRocywgXCJtb250aFwiKSkge1xuXHRcdG1vbnRocyAtPSAxO1xuXHR9XG5cdGlmIChtb250aHMgPj0gMSkge1xuXHRcdHJldHVybiB7IHZhbHVlOiBtb250aHMsIHVuaXQ6IFwiTVwiIH07XG5cdH1cblxuXHRjb25zdCBkYXlzID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcigobm93LmdldFRpbWUoKSAtIGRhdGUuZ2V0VGltZSgpKSAvIE1TX1BFUl9EQVkpKTtcblx0cmV0dXJuIHsgdmFsdWU6IGRheXMsIHVuaXQ6IFwiRFwiIH07XG59XG5cbmZ1bmN0aW9uIGdldFNoaWZ0ZWREYXRlKGRhdGU6IERhdGUsIGFtb3VudDogbnVtYmVyLCB1bml0OiBcInllYXJcIiB8IFwibW9udGhcIikge1xuXHRjb25zdCBzaGlmdGVkID0gbmV3IERhdGUoZGF0ZSk7XG5cdGlmICh1bml0ID09PSBcInllYXJcIikge1xuXHRcdHNoaWZ0ZWQuc2V0RnVsbFllYXIoZGF0ZS5nZXRGdWxsWWVhcigpICsgYW1vdW50KTtcblx0fSBlbHNlIHtcblx0XHRzaGlmdGVkLnNldE1vbnRoKGRhdGUuZ2V0TW9udGgoKSArIGFtb3VudCk7XG5cdH1cblx0cmV0dXJuIHNoaWZ0ZWQ7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFRlbnVyZU1hcmsodGVudXJlOiBTdWJzY3JpcHRpb25UZW51cmUpIHtcblx0cmV0dXJuIGAke3RlbnVyZS52YWx1ZX0ke3RlbnVyZS51bml0fWA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFRlbnVyZSh0ZW51cmU6IFN1YnNjcmlwdGlvblRlbnVyZSkge1xuXHRjb25zdCB1bml0ID1cblx0XHR0ZW51cmUudW5pdCA9PT0gXCJZXCIgPyBcInllYXJcIiA6IHRlbnVyZS51bml0ID09PSBcIk1cIiA/IFwibW9udGhcIiA6IFwiZGF5XCI7XG5cdHJldHVybiBgJHt0ZW51cmUudmFsdWV9ICR7dW5pdH0ke3RlbnVyZS52YWx1ZSA9PT0gMSA/IFwiXCIgOiBcInNcIn1gO1xufVxuXG5mdW5jdGlvbiBmb3JtYXREYXRlKHZhbHVlOiBzdHJpbmcpIHtcblx0Y29uc3QgZGF0ZSA9IG5ldyBEYXRlKHZhbHVlKTtcblx0aWYgKE51bWJlci5pc05hTihkYXRlLmdldFRpbWUoKSkpIHtcblx0XHRyZXR1cm4gdmFsdWU7XG5cdH1cblxuXHRyZXR1cm4gZnVsbERhdGVGb3JtYXR0ZXIuZm9ybWF0KGRhdGUpO1xufVxuXG5mdW5jdGlvbiBnZXRTdWJzY3JpYmVTdXJmYWNlVGV4dCgpIHtcblx0Y29uc3QgdGFyZ2V0ID0gZmluZFN1YnNjcmliZVN1cmZhY2UoKTtcblxuXHRyZXR1cm4gW1xuXHRcdHRhcmdldD8udGV4dENvbnRlbnQsXG5cdFx0dGFyZ2V0Py5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpLFxuXHRcdHRhcmdldD8uZ2V0QXR0cmlidXRlKFwidGl0bGVcIiksXG5cdF1cblx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0LmpvaW4oXCIgXCIpXG5cdFx0LnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZmluZFN1YnNjcmliZVN1cmZhY2UoKSB7XG5cdGNvbnN0IGNoYW5uZWxTZWxlY3RvcnMgPSBbXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtcGFnZS1oZWFkZXItcmVuZGVyZXIgeXRkLXN1YnNjcmliZS1idXR0b24tcmVuZGVyZXJcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciBidXR0b25bYXJpYS1sYWJlbCo9J1N1YnNjcmliZSddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtcGFnZS1oZWFkZXItcmVuZGVyZXIgYnV0dG9uW2FyaWEtbGFiZWwqPSdTdWJzY3JpYmVkJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0LXBhZ2UtaGVhZGVyLXZpZXctbW9kZWwgeXRkLXN1YnNjcmliZS1idXR0b24tcmVuZGVyZXJcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0LXBhZ2UtaGVhZGVyLXZpZXctbW9kZWwgYnV0dG9uW2FyaWEtbGFiZWwqPSdTdWJzY3JpYmUnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCBidXR0b25bYXJpYS1sYWJlbCo9J1N1YnNjcmliZWQnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgeXRkLXN1YnNjcmliZS1idXR0b24tcmVuZGVyZXJcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1jNC10YWJiZWQtaGVhZGVyLXJlbmRlcmVyIGJ1dHRvblthcmlhLWxhYmVsKj0nU3Vic2NyaWJlJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1jNC10YWJiZWQtaGVhZGVyLXJlbmRlcmVyIGJ1dHRvblthcmlhLWxhYmVsKj0nU3Vic2NyaWJlZCddXCIsXG5cdF07XG5cblx0Zm9yIChjb25zdCBzZWxlY3RvciBvZiBjaGFubmVsU2VsZWN0b3JzKSB7XG5cdFx0Y29uc3QgZWxlbWVudCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsZWN0b3IpO1xuXHRcdGlmIChlbGVtZW50IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpIHtcblx0XHRcdHJldHVybiBlbGVtZW50O1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBpc1N0YXR1c1Jlc3BvbnNlKHJlc3BvbnNlOiBFeHRlbnNpb25SZXNwb25zZSk6IHJlc3BvbnNlIGlzIFN0YXR1c1Jlc3BvbnNlIHtcblx0cmV0dXJuIFwiYXV0aFN0YXR1c1wiIGluIHJlc3BvbnNlO1xufVxuIiwiZnVuY3Rpb24gcHJpbnQobWV0aG9kLCAuLi5hcmdzKSB7XG4gIGlmIChpbXBvcnQubWV0YS5lbnYuTU9ERSA9PT0gXCJwcm9kdWN0aW9uXCIpIHJldHVybjtcbiAgaWYgKHR5cGVvZiBhcmdzWzBdID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGFyZ3Muc2hpZnQoKTtcbiAgICBtZXRob2QoYFt3eHRdICR7bWVzc2FnZX1gLCAuLi5hcmdzKTtcbiAgfSBlbHNlIHtcbiAgICBtZXRob2QoXCJbd3h0XVwiLCAuLi5hcmdzKTtcbiAgfVxufVxuZXhwb3J0IGNvbnN0IGxvZ2dlciA9IHtcbiAgZGVidWc6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmRlYnVnLCAuLi5hcmdzKSxcbiAgbG9nOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5sb2csIC4uLmFyZ3MpLFxuICB3YXJuOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS53YXJuLCAuLi5hcmdzKSxcbiAgZXJyb3I6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmVycm9yLCAuLi5hcmdzKVxufTtcbiIsImltcG9ydCB7IGJyb3dzZXIgfSBmcm9tIFwid3h0L2Jyb3dzZXJcIjtcbmV4cG9ydCBjbGFzcyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IGV4dGVuZHMgRXZlbnQge1xuICBjb25zdHJ1Y3RvcihuZXdVcmwsIG9sZFVybCkge1xuICAgIHN1cGVyKFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQuRVZFTlRfTkFNRSwge30pO1xuICAgIHRoaXMubmV3VXJsID0gbmV3VXJsO1xuICAgIHRoaXMub2xkVXJsID0gb2xkVXJsO1xuICB9XG4gIHN0YXRpYyBFVkVOVF9OQU1FID0gZ2V0VW5pcXVlRXZlbnROYW1lKFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGdldFVuaXF1ZUV2ZW50TmFtZShldmVudE5hbWUpIHtcbiAgcmV0dXJuIGAke2Jyb3dzZXI/LnJ1bnRpbWU/LmlkfToke2ltcG9ydC5tZXRhLmVudi5FTlRSWVBPSU5UfToke2V2ZW50TmFtZX1gO1xufVxuIiwiaW1wb3J0IHsgV3h0TG9jYXRpb25DaGFuZ2VFdmVudCB9IGZyb20gXCIuL2N1c3RvbS1ldmVudHMubWpzXCI7XG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTG9jYXRpb25XYXRjaGVyKGN0eCkge1xuICBsZXQgaW50ZXJ2YWw7XG4gIGxldCBvbGRVcmw7XG4gIHJldHVybiB7XG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBsb2NhdGlvbiB3YXRjaGVyIGlzIGFjdGl2ZWx5IGxvb2tpbmcgZm9yIFVSTCBjaGFuZ2VzLiBJZiBpdCdzIGFscmVhZHkgd2F0Y2hpbmcsXG4gICAgICogdGhpcyBpcyBhIG5vb3AuXG4gICAgICovXG4gICAgcnVuKCkge1xuICAgICAgaWYgKGludGVydmFsICE9IG51bGwpIHJldHVybjtcbiAgICAgIG9sZFVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgICBpbnRlcnZhbCA9IGN0eC5zZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGxldCBuZXdVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgICAgICBpZiAobmV3VXJsLmhyZWYgIT09IG9sZFVybC5ocmVmKSB7XG4gICAgICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQobmV3VXJsLCBvbGRVcmwpKTtcbiAgICAgICAgICBvbGRVcmwgPSBuZXdVcmw7XG4gICAgICAgIH1cbiAgICAgIH0sIDFlMyk7XG4gICAgfVxuICB9O1xufVxuIiwiaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSBcIi4uL3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanNcIjtcbmltcG9ydCB7XG4gIGdldFVuaXF1ZUV2ZW50TmFtZVxufSBmcm9tIFwiLi9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLm1qc1wiO1xuaW1wb3J0IHsgY3JlYXRlTG9jYXRpb25XYXRjaGVyIH0gZnJvbSBcIi4vaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanNcIjtcbmV4cG9ydCBjbGFzcyBDb250ZW50U2NyaXB0Q29udGV4dCB7XG4gIGNvbnN0cnVjdG9yKGNvbnRlbnRTY3JpcHROYW1lLCBvcHRpb25zKSB7XG4gICAgdGhpcy5jb250ZW50U2NyaXB0TmFtZSA9IGNvbnRlbnRTY3JpcHROYW1lO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gICAgdGhpcy5hYm9ydENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgaWYgKHRoaXMuaXNUb3BGcmFtZSkge1xuICAgICAgdGhpcy5saXN0ZW5Gb3JOZXdlclNjcmlwdHMoeyBpZ25vcmVGaXJzdEV2ZW50OiB0cnVlIH0pO1xuICAgICAgdGhpcy5zdG9wT2xkU2NyaXB0cygpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cygpO1xuICAgIH1cbiAgfVxuICBzdGF0aWMgU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFID0gZ2V0VW5pcXVlRXZlbnROYW1lKFxuICAgIFwid3h0OmNvbnRlbnQtc2NyaXB0LXN0YXJ0ZWRcIlxuICApO1xuICBpc1RvcEZyYW1lID0gd2luZG93LnNlbGYgPT09IHdpbmRvdy50b3A7XG4gIGFib3J0Q29udHJvbGxlcjtcbiAgbG9jYXRpb25XYXRjaGVyID0gY3JlYXRlTG9jYXRpb25XYXRjaGVyKHRoaXMpO1xuICByZWNlaXZlZE1lc3NhZ2VJZHMgPSAvKiBAX19QVVJFX18gKi8gbmV3IFNldCgpO1xuICBnZXQgc2lnbmFsKCkge1xuICAgIHJldHVybiB0aGlzLmFib3J0Q29udHJvbGxlci5zaWduYWw7XG4gIH1cbiAgYWJvcnQocmVhc29uKSB7XG4gICAgcmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLmFib3J0KHJlYXNvbik7XG4gIH1cbiAgZ2V0IGlzSW52YWxpZCgpIHtcbiAgICBpZiAoYnJvd3Nlci5ydW50aW1lLmlkID09IG51bGwpIHtcbiAgICAgIHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuc2lnbmFsLmFib3J0ZWQ7XG4gIH1cbiAgZ2V0IGlzVmFsaWQoKSB7XG4gICAgcmV0dXJuICF0aGlzLmlzSW52YWxpZDtcbiAgfVxuICAvKipcbiAgICogQWRkIGEgbGlzdGVuZXIgdGhhdCBpcyBjYWxsZWQgd2hlbiB0aGUgY29udGVudCBzY3JpcHQncyBjb250ZXh0IGlzIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBAcmV0dXJucyBBIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoY2IpO1xuICAgKiBjb25zdCByZW1vdmVJbnZhbGlkYXRlZExpc3RlbmVyID0gY3R4Lm9uSW52YWxpZGF0ZWQoKCkgPT4ge1xuICAgKiAgIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIoY2IpO1xuICAgKiB9KVxuICAgKiAvLyAuLi5cbiAgICogcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lcigpO1xuICAgKi9cbiAgb25JbnZhbGlkYXRlZChjYikge1xuICAgIHRoaXMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG4gICAgcmV0dXJuICgpID0+IHRoaXMuc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBjYik7XG4gIH1cbiAgLyoqXG4gICAqIFJldHVybiBhIHByb21pc2UgdGhhdCBuZXZlciByZXNvbHZlcy4gVXNlZnVsIGlmIHlvdSBoYXZlIGFuIGFzeW5jIGZ1bmN0aW9uIHRoYXQgc2hvdWxkbid0IHJ1blxuICAgKiBhZnRlciB0aGUgY29udGV4dCBpcyBleHBpcmVkLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBjb25zdCBnZXRWYWx1ZUZyb21TdG9yYWdlID0gYXN5bmMgKCkgPT4ge1xuICAgKiAgIGlmIChjdHguaXNJbnZhbGlkKSByZXR1cm4gY3R4LmJsb2NrKCk7XG4gICAqXG4gICAqICAgLy8gLi4uXG4gICAqIH1cbiAgICovXG4gIGJsb2NrKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgoKSA9PiB7XG4gICAgfSk7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0SW50ZXJ2YWxgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIEludGVydmFscyBjYW4gYmUgY2xlYXJlZCBieSBjYWxsaW5nIHRoZSBub3JtYWwgYGNsZWFySW50ZXJ2YWxgIGZ1bmN0aW9uLlxuICAgKi9cbiAgc2V0SW50ZXJ2YWwoaGFuZGxlciwgdGltZW91dCkge1xuICAgIGNvbnN0IGlkID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuICAgIH0sIHRpbWVvdXQpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhckludGVydmFsKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIC8qKlxuICAgKiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnNldFRpbWVvdXRgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIFRpbWVvdXRzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgc2V0VGltZW91dGAgZnVuY3Rpb24uXG4gICAqL1xuICBzZXRUaW1lb3V0KGhhbmRsZXIsIHRpbWVvdXQpIHtcbiAgICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuICAgIH0sIHRpbWVvdXQpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhclRpbWVvdXQoaWQpKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG4gICAqIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsQW5pbWF0aW9uRnJhbWVgIGZ1bmN0aW9uLlxuICAgKi9cbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgaWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKC4uLmFyZ3MpID0+IHtcbiAgICAgIGlmICh0aGlzLmlzVmFsaWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuICAgIH0pO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxBbmltYXRpb25GcmFtZShpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0SWRsZUNhbGxiYWNrYCB0aGF0IGF1dG9tYXRpY2FsbHkgY2FuY2VscyB0aGUgcmVxdWVzdCB3aGVuXG4gICAqIGludmFsaWRhdGVkLlxuICAgKlxuICAgKiBDYWxsYmFja3MgY2FuIGJlIGNhbmNlbGVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2FuY2VsSWRsZUNhbGxiYWNrYCBmdW5jdGlvbi5cbiAgICovXG4gIHJlcXVlc3RJZGxlQ2FsbGJhY2soY2FsbGJhY2ssIG9wdGlvbnMpIHtcbiAgICBjb25zdCBpZCA9IHJlcXVlc3RJZGxlQ2FsbGJhY2soKC4uLmFyZ3MpID0+IHtcbiAgICAgIGlmICghdGhpcy5zaWduYWwuYWJvcnRlZCkgY2FsbGJhY2soLi4uYXJncyk7XG4gICAgfSwgb3B0aW9ucyk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNhbmNlbElkbGVDYWxsYmFjayhpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICBhZGRFdmVudExpc3RlbmVyKHRhcmdldCwgdHlwZSwgaGFuZGxlciwgb3B0aW9ucykge1xuICAgIGlmICh0eXBlID09PSBcInd4dDpsb2NhdGlvbmNoYW5nZVwiKSB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSB0aGlzLmxvY2F0aW9uV2F0Y2hlci5ydW4oKTtcbiAgICB9XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXI/LihcbiAgICAgIHR5cGUuc3RhcnRzV2l0aChcInd4dDpcIikgPyBnZXRVbmlxdWVFdmVudE5hbWUodHlwZSkgOiB0eXBlLFxuICAgICAgaGFuZGxlcixcbiAgICAgIHtcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgc2lnbmFsOiB0aGlzLnNpZ25hbFxuICAgICAgfVxuICAgICk7XG4gIH1cbiAgLyoqXG4gICAqIEBpbnRlcm5hbFxuICAgKiBBYm9ydCB0aGUgYWJvcnQgY29udHJvbGxlciBhbmQgZXhlY3V0ZSBhbGwgYG9uSW52YWxpZGF0ZWRgIGxpc3RlbmVycy5cbiAgICovXG4gIG5vdGlmeUludmFsaWRhdGVkKCkge1xuICAgIHRoaXMuYWJvcnQoXCJDb250ZW50IHNjcmlwdCBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xuICAgIGxvZ2dlci5kZWJ1ZyhcbiAgICAgIGBDb250ZW50IHNjcmlwdCBcIiR7dGhpcy5jb250ZW50U2NyaXB0TmFtZX1cIiBjb250ZXh0IGludmFsaWRhdGVkYFxuICAgICk7XG4gIH1cbiAgc3RvcE9sZFNjcmlwdHMoKSB7XG4gICAgd2luZG93LnBvc3RNZXNzYWdlKFxuICAgICAge1xuICAgICAgICB0eXBlOiBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUsXG4gICAgICAgIGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuICAgICAgICBtZXNzYWdlSWQ6IE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpXG4gICAgICB9LFxuICAgICAgXCIqXCJcbiAgICApO1xuICB9XG4gIHZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkge1xuICAgIGNvbnN0IGlzU2NyaXB0U3RhcnRlZEV2ZW50ID0gZXZlbnQuZGF0YT8udHlwZSA9PT0gQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFO1xuICAgIGNvbnN0IGlzU2FtZUNvbnRlbnRTY3JpcHQgPSBldmVudC5kYXRhPy5jb250ZW50U2NyaXB0TmFtZSA9PT0gdGhpcy5jb250ZW50U2NyaXB0TmFtZTtcbiAgICBjb25zdCBpc05vdER1cGxpY2F0ZSA9ICF0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5oYXMoZXZlbnQuZGF0YT8ubWVzc2FnZUlkKTtcbiAgICByZXR1cm4gaXNTY3JpcHRTdGFydGVkRXZlbnQgJiYgaXNTYW1lQ29udGVudFNjcmlwdCAmJiBpc05vdER1cGxpY2F0ZTtcbiAgfVxuICBsaXN0ZW5Gb3JOZXdlclNjcmlwdHMob3B0aW9ucykge1xuICAgIGxldCBpc0ZpcnN0ID0gdHJ1ZTtcbiAgICBjb25zdCBjYiA9IChldmVudCkgPT4ge1xuICAgICAgaWYgKHRoaXMudmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSkge1xuICAgICAgICB0aGlzLnJlY2VpdmVkTWVzc2FnZUlkcy5hZGQoZXZlbnQuZGF0YS5tZXNzYWdlSWQpO1xuICAgICAgICBjb25zdCB3YXNGaXJzdCA9IGlzRmlyc3Q7XG4gICAgICAgIGlzRmlyc3QgPSBmYWxzZTtcbiAgICAgICAgaWYgKHdhc0ZpcnN0ICYmIG9wdGlvbnM/Lmlnbm9yZUZpcnN0RXZlbnQpIHJldHVybjtcbiAgICAgICAgdGhpcy5ub3RpZnlJbnZhbGlkYXRlZCgpO1xuICAgICAgfVxuICAgIH07XG4gICAgYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgY2IpO1xuICAgIHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiByZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYikpO1xuICB9XG59XG4iXSwibmFtZXMiOlsiZGVmaW5pdGlvbiIsImJyb3dzZXIiLCJfYnJvd3NlciIsInByaW50IiwibG9nZ2VyIl0sIm1hcHBpbmdzIjoiOztBQUFPLFdBQVMsb0JBQW9CQSxhQUFZO0FBQzlDLFdBQU9BO0FBQUEsRUFDVDtBQ0RPLFFBQU1DLFlBQVUsV0FBVyxTQUFTLFNBQVMsS0FDaEQsV0FBVyxVQUNYLFdBQVc7QUNGUixRQUFNLFVBQVVDO0FDRGhCLFFBQU0sb0JBQW9CO0FDT2pDLFFBQUEsV0FBQTtBQUNBLFFBQUEsV0FBQTtBQUNBLFFBQUEsZ0JBQUE7QUFDQSxRQUFBLHlCQUFBO0FBQ0EsUUFBQSw4QkFBQTtBQUNBLFFBQUEsNEJBQUE7QUFDQSxRQUFBLDZCQUFBO0FBQ0EsUUFBQSx5QkFBQTtBQUNBLFFBQUEsOEJBQUE7QUFDQSxRQUFBLGdDQUFBO0FBQ0EsUUFBQSw2QkFBQTtBQUNBLFFBQUEsNEJBQUE7QUFDQSxRQUFBLGFBQUEsS0FBQSxLQUFBLEtBQUE7QUFDQSxRQUFBLG9CQUFBLElBQUEsS0FBQSxlQUFBLFFBQUE7QUFBQSxJQUE2RCxPQUFBO0FBQUEsSUFDckQsS0FBQTtBQUFBLElBQ0YsTUFBQTtBQUFBLEVBRU4sQ0FBQTtBQU9BLFFBQUEsYUFBQSxvQkFBQTtBQUFBLElBQW1DLFNBQUEsQ0FBQSxxQkFBQTtBQUFBLElBQ0gsT0FBQTtBQUU5QixVQUFBLGNBQUE7QUFDQSxVQUFBLDRCQUFBO0FBQ0EsVUFBQTtBQU9BLFVBQUEsa0JBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFB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QUEsTUFDNUMsR0FBRyxPQUFPO0FBQ1YsV0FBSyxjQUFjLE1BQU0sbUJBQW1CLEVBQUUsQ0FBQztBQUMvQyxhQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsaUJBQWlCLFFBQVEsTUFBTSxTQUFTLFNBQVM7QUFDL0MsVUFBSSxTQUFTLHNCQUFzQjtBQUNqQyxZQUFJLEtBQUssUUFBUyxNQUFLLGdCQUFnQixJQUFHO0FBQUEsTUFDNUM7QUFDQSxhQUFPO0FBQUEsUUFDTCxLQUFLLFdBQVcsTUFBTSxJQUFJLG1CQUFtQixJQUFJLElBQUk7QUFBQSxRQUNyRDtBQUFBLFFBQ0E7QUFBQSxVQUNFLEdBQUc7QUFBQSxVQUNILFFBQVEsS0FBSztBQUFBLFFBQ3JCO0FBQUEsTUFDQTtBQUFBLElBQ0U7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBS0Esb0JBQW9CO0FBQ2xCLFdBQUssTUFBTSxvQ0FBb0M7QUFDL0NDLGVBQU87QUFBQSxRQUNMLG1CQUFtQixLQUFLLGlCQUFpQjtBQUFBLE1BQy9DO0FBQUEsSUFDRTtBQUFBLElBQ0EsaUJBQWlCO0FBQ2YsYUFBTztBQUFBLFFBQ0w7QUFBQSxVQUNFLE1BQU0scUJBQXFCO0FBQUEsVUFDM0IsbUJBQW1CLEtBQUs7QUFBQSxVQUN4QixXQUFXLEtBQUssT0FBTSxFQUFHLFNBQVMsRUFBRSxFQUFFLE1BQU0sQ0FBQztBQUFBLFFBQ3JEO0FBQUEsUUFDTTtBQUFBLE1BQ047QUFBQSxJQUNFO0FBQUEsSUFDQSx5QkFBeUIsT0FBTztBQUM5QixZQUFNLHVCQUF1QixNQUFNLE1BQU0sU0FBUyxxQkFBcUI7QUFDdkUsWUFBTSxzQkFBc0IsTUFBTSxNQUFNLHNCQUFzQixLQUFLO0FBQ25FLFlBQU0saUJBQWlCLENBQUMsS0FBSyxtQkFBbUIsSUFBSSxNQUFNLE1BQU0sU0FBUztBQUN6RSxhQUFPLHdCQUF3Qix1QkFBdUI7QUFBQSxJQUN4RDtBQUFBLElBQ0Esc0JBQXNCLFNBQVM7QUFDN0IsVUFBSSxVQUFVO0FBQ2QsWUFBTSxLQUFLLENBQUMsVUFBVTtBQUNwQixZQUFJLEtBQUsseUJBQXlCLEtBQUssR0FBRztBQUN4QyxlQUFLLG1CQUFtQixJQUFJLE1BQU0sS0FBSyxTQUFTO0FBQ2hELGdCQUFNLFdBQVc7QUFDakIsb0JBQVU7QUFDVixjQUFJLFlBQVksU0FBUyxpQkFBa0I7QUFDM0MsZUFBSyxrQkFBaUI7QUFBQSxRQUN4QjtBQUFBLE1BQ0Y7QUFDQSx1QkFBaUIsV0FBVyxFQUFFO0FBQzlCLFdBQUssY0FBYyxNQUFNLG9CQUFvQixXQUFXLEVBQUUsQ0FBQztBQUFBLElBQzdEO0FBQUEsRUFDRjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OyIsInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswLDEsMiw1LDYsNyw4XX0=
content;