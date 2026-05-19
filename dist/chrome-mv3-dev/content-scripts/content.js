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
			--ss-badge-mark-bg: var(--yt-spec-text-primary, #0f0f0f);
			--ss-badge-mark-fg: var(--yt-spec-base-background, #fff);
			display: inline-flex;
			align-items: center;
			gap: 8px;
			box-sizing: border-box;
			min-height: 36px;
			padding: 5px 12px 5px 6px;
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
			--ss-badge-mark-bg: var(--yt-spec-text-primary, #fff);
			--ss-badge-mark-fg: var(--yt-spec-base-background, #0f0f0f);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vQHd4dC1kZXYrYnJvd3NlckAwLjEuNC9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vLi4vc3JjL2xpYi9tZXNzYWdlcy50cyIsIi4uLy4uLy4uL3NyYy9lbnRyeXBvaW50cy9jb250ZW50L2luZGV4LnRzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3d4dEAwLjIwLjExX0B0eXBlcytub2RlQDI0LjEwLjFfaml0aUAyLjYuMV9saWdodG5pbmdjc3NAMS4zMC4yX3JvbGx1cEA0LjUzLjIvbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvZ2dlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvY3VzdG9tLWV2ZW50cy5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvaW50ZXJuYWwvbG9jYXRpb24td2F0Y2hlci5tanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvLnBucG0vd3h0QDAuMjAuMTFfQHR5cGVzK25vZGVAMjQuMTAuMV9qaXRpQDIuNi4xX2xpZ2h0bmluZ2Nzc0AxLjMwLjJfcm9sbHVwQDQuNTMuMi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvdXRpbHMvY29udGVudC1zY3JpcHQtY29udGV4dC5tanMiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNvbnRlbnRTY3JpcHQoZGVmaW5pdGlvbikge1xuICByZXR1cm4gZGVmaW5pdGlvbjtcbn1cbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgX2Jyb3dzZXIgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBfYnJvd3NlcjtcbmV4cG9ydCB7fTtcbiIsImV4cG9ydCBjb25zdCBDQUNIRV9TVE9SQUdFX0tFWSA9IFwic3MtY2FjaGUtc3RhdGVcIjtcblxuZXhwb3J0IHR5cGUgQXV0aFN0YXR1cyA9IFwic2lnbmVkX291dFwiIHwgXCJzaWduZWRfaW5cIiB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IHR5cGUgU3Vic2NyaXB0aW9uUmVjb3JkID0ge1xuXHRzdWJzY3JpcHRpb25JZDogc3RyaW5nO1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0Y2hhbm5lbFRpdGxlOiBzdHJpbmc7XG5cdHN1YnNjcmliZWRBdDogc3RyaW5nO1xuXHRmZXRjaGVkQXQ6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIENhY2hlU3RhdGUgPSB7XG5cdGF1dGhTdGF0dXM6IEF1dGhTdGF0dXM7XG5cdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRsYXN0RXJyb3I/OiBzdHJpbmc7XG5cdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDogUmVjb3JkPHN0cmluZywgU3Vic2NyaXB0aW9uUmVjb3JkPjtcbn07XG5cbmV4cG9ydCB0eXBlIFB1YmxpY1N0YXRlID0ge1xuXHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRsYXN0RnVsbFN5bmNBdD86IHN0cmluZztcblx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHRzdWJzY3JpcHRpb25Db3VudDogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgR2V0U3RhdHVzUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19HRVRfU1RBVFVTXCI7XG5cdGNoYW5uZWxJZDogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgUmVmcmVzaEFsbFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfUkVGUkVTSF9BTExcIjtcblx0aW50ZXJhY3RpdmU/OiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQXV0aFJlcXVlc3QgPSB7XG5cdHR5cGU6IFwiU1NfU0lHTl9JTlwiIHwgXCJTU19TSUdOX09VVFwiIHwgXCJTU19HRVRfU1RBVEVcIjtcbn07XG5cbmV4cG9ydCB0eXBlIFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdCA9IHtcblx0dHlwZTogXCJTU19WSVNJQkxFX1NVQlNDUklQVElPTl9DSEFOR0VEXCI7XG59O1xuXG5leHBvcnQgdHlwZSBFeHRlbnNpb25SZXF1ZXN0ID1cblx0fCBHZXRTdGF0dXNSZXF1ZXN0XG5cdHwgUmVmcmVzaEFsbFJlcXVlc3Rcblx0fCBBdXRoUmVxdWVzdFxuXHR8IFZpc2libGVTdWJzY3JpcHRpb25DaGFuZ2VkUmVxdWVzdDtcblxuZXhwb3J0IHR5cGUgU3RhdHVzUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0YXV0aFN0YXR1czogQXV0aFN0YXR1cztcblx0XHRcdHN1YnNjcmlwdGlvbj86IFN1YnNjcmlwdGlvblJlY29yZDtcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHRcdFx0bGFzdEVycm9yPzogc3RyaW5nO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRhdXRoU3RhdHVzOiBBdXRoU3RhdHVzO1xuXHRcdFx0ZXJyb3I6IHN0cmluZztcblx0XHRcdGxhc3RGdWxsU3luY0F0Pzogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIFN0YXRlUmVzcG9uc2UgPVxuXHR8IHtcblx0XHRcdG9rOiB0cnVlO1xuXHRcdFx0c3RhdGU6IFB1YmxpY1N0YXRlO1xuXHQgIH1cblx0fCB7XG5cdFx0XHRvazogZmFsc2U7XG5cdFx0XHRzdGF0ZTogUHVibGljU3RhdGU7XG5cdFx0XHRlcnJvcjogc3RyaW5nO1xuXHQgIH07XG5cbmV4cG9ydCB0eXBlIEV4dGVuc2lvblJlc3BvbnNlID0gU3RhdHVzUmVzcG9uc2UgfCBTdGF0ZVJlc3BvbnNlO1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlDYWNoZVN0YXRlKCk6IENhY2hlU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdGF1dGhTdGF0dXM6IFwic2lnbmVkX291dFwiLFxuXHRcdHN1YnNjcmlwdGlvbnNCeUNoYW5uZWxJZDoge30sXG5cdH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQge1xuXHRDQUNIRV9TVE9SQUdFX0tFWSxcblx0dHlwZSBFeHRlbnNpb25SZXNwb25zZSxcblx0dHlwZSBTdGF0dXNSZXNwb25zZSxcbn0gZnJvbSBcIi4uLy4uL2xpYi9tZXNzYWdlc1wiO1xuXG5jb25zdCBCQURHRV9JRCA9IFwic3Mtc3Vic2NyaWJlZC1zaW5jZVwiO1xuY29uc3QgU1RZTEVfSUQgPSBcInNzLXN1YnNjcmliZWQtc2luY2Utc3R5bGVcIjtcbmNvbnN0IENIQU5ORUxfSURfUkUgPSAvVUNbXFx3LV17MjAsfS87XG5jb25zdCBET01fUkVOREVSX0RFQk9VTkNFX01TID0gMzUwO1xuY29uc3QgUEFHRV9DT05URVhUX01FU1NBR0VfU09VUkNFID0gXCJzcy1zdWJzY3JpYmVkLXNpbmNlXCI7XG5jb25zdCBQQUdFX0NPTlRFWFRfUkVRVUVTVF9UWVBFID0gXCJTU19HRVRfUEFHRV9DT05URVhUX0NIQU5ORUxfSURcIjtcbmNvbnN0IFBBR0VfQ09OVEVYVF9SRVNQT05TRV9UWVBFID0gXCJTU19QQUdFX0NPTlRFWFRfQ0hBTk5FTF9JRFwiO1xuY29uc3QgUEFHRV9DT05URVhUX1NDUklQVF9JRCA9IFwic3MtcGFnZS1jb250ZXh0LWNoYW5uZWwtcmVhZGVyXCI7XG5jb25zdCBOQVZJR0FUSU9OX1JFTkRFUl9XSU5ET1dfTVMgPSAxMF8wMDA7XG5jb25zdCBOQVZJR0FUSU9OX1JFTkRFUl9JTlRFUlZBTF9NUyA9IDUwMDtcbmNvbnN0IE5BVklHQVRJT05fU0VUVExFX0RFTEFZX01TID0gNjUwO1xuY29uc3QgUEFHRV9XQVRDSERPR19JTlRFUlZBTF9NUyA9IDUwMDA7XG5jb25zdCBNU19QRVJfREFZID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxudHlwZSBTdWJzY3JpcHRpb25UZW51cmUgPSB7XG5cdHZhbHVlOiBudW1iZXI7XG5cdHVuaXQ6IFwiWVwiIHwgXCJNXCIgfCBcIkRcIjtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbnRlbnRTY3JpcHQoe1xuXHRtYXRjaGVzOiBbXCIqOi8vKi55b3V0dWJlLmNvbS8qXCJdLFxuXHRtYWluKCkge1xuXHRcdGxldCBsYXN0UGFnZUtleSA9IFwiXCI7XG5cdFx0bGV0IGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBcIlwiO1xuXHRcdGxldCByZXNvbHZlZEJhZGdlOlxuXHRcdFx0fCB7XG5cdFx0XHRcdFx0cGFnZUtleTogc3RyaW5nO1xuXHRcdFx0XHRcdHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlO1xuXHRcdFx0XHRcdGRhdGVUZXh0OiBzdHJpbmc7XG5cdFx0XHQgIH1cblx0XHRcdHwgdW5kZWZpbmVkO1xuXHRcdGxldCByZW5kZXJSZXF1ZXN0SWQgPSAwO1xuXHRcdGxldCBub3RpZmljYXRpb25PYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IHVuZGVmaW5lZDtcblx0XHRsZXQgcmVuZGVyVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCByZWFkaW5lc3NUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG5cdFx0bGV0IG5hdmlnYXRpb25SZW5kZXJUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBzdWJzY3JpYmVSZXRyeVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcblx0XHRsZXQgc3Vic2NyaWJlQ2hhbmdlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBiYWRnZVJldHJ5VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBwYWdlV2F0Y2hkb2dUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBuYXZpZ2F0aW9uT2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCB1bmRlZmluZWQ7XG5cdFx0bGV0IHJlYWRpbmVzc09ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgdW5kZWZpbmVkO1xuXHRcdGxldCBuYXZpZ2F0aW9uU2V0dGxpbmdVbnRpbCA9IDA7XG5cdFx0bGV0IGlzQWN0aXZlID0gdHJ1ZTtcblxuXHRcdGluc3RhbGxTdHlsZXMoKTtcblx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRzdGFydFBhZ2VXYXRjaGRvZygpO1xuXHRcdG9ic2VydmVZb3VUdWJlTmF2aWdhdGlvbigpO1xuXHRcdG9ic2VydmVQYWdlUmVhZGluZXNzKCk7XG5cdFx0b2JzZXJ2ZUNhY2hlQ2hhbmdlcygpO1xuXHRcdG9ic2VydmVTdWJzY3JpYmVCdXR0b25DaGFuZ2VzKCk7XG5cblx0XHRmdW5jdGlvbiBvYnNlcnZlWW91VHViZU5hdmlnYXRpb24oKSB7XG5cdFx0XHRsZXQgbGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0Y29uc3QgaGFuZGxlTmF2aWdhdGlvbiA9IChjbGVhckJhZGdlOiBib29sZWFuKSA9PiB7XG5cdFx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAobG9jYXRpb24uaHJlZiAhPT0gbGFzdEhyZWYpIHtcblx0XHRcdFx0XHRsYXN0SHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdFx0c3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcChjbGVhckJhZGdlKTtcblx0XHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtbmF2aWdhdGUtc3RhcnRcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKHRydWUpO1xuXHRcdFx0fSk7XG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtbmF2aWdhdGUtZmluaXNoXCIsICgpID0+IHtcblx0XHRcdFx0bGFzdEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKHRydWUpO1xuXHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0fSk7XG5cdFx0XHRkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwieXQtcGFnZS1kYXRhLXVwZGF0ZWRcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0d2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCAoKSA9PiB7XG5cdFx0XHRcdHN0YXJ0TmF2aWdhdGlvblJlbmRlckxvb3AodHJ1ZSk7XG5cdFx0XHR9KTtcblx0XHRcdHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNcIiwgKCkgPT4ge1xuXHRcdFx0XHRzdGFydE5hdmlnYXRpb25SZW5kZXJMb29wKGZhbHNlKTtcblx0XHRcdH0pO1xuXHRcdFx0ZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuXHRcdFx0XHRpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSBcInZpc2libGVcIikge1xuXHRcdFx0XHRcdHN0YXJ0TmF2aWdhdGlvblJlbmRlckxvb3AoZmFsc2UpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblxuXHRcdFx0bmF2aWdhdGlvbk9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuXHRcdFx0XHRoYW5kbGVOYXZpZ2F0aW9uKHRydWUpO1xuXHRcdFx0fSk7XG5cdFx0XHRuYXZpZ2F0aW9uT2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudCwgeyBzdWJ0cmVlOiB0cnVlLCBjaGlsZExpc3Q6IHRydWUgfSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gb2JzZXJ2ZVBhZ2VSZWFkaW5lc3MoKSB7XG5cdFx0XHRyZWFkaW5lc3NPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNTdXBwb3J0ZWRZb3VUdWJlUGFnZSgpKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHJlYWRpbmVzc1RpbWVyKSB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHJlYWRpbmVzc1RpbWVyKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJlYWRpbmVzc1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCQURHRV9JRCk7XG5cdFx0XHRcdFx0Y29uc3QgY2hhbm5lbElkID0gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tRG9tKCk7XG5cblx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHQhYmFkZ2UgfHxcblx0XHRcdFx0XHRcdCFjaGFubmVsSWQgfHxcblx0XHRcdFx0XHRcdGJhZGdlLmRhdGFzZXQuc3NDaGFubmVsSWQgIT09IGNoYW5uZWxJZCB8fFxuXHRcdFx0XHRcdFx0YmFkZ2UuZGF0YXNldC5zc0hyZWYgIT09IGxvY2F0aW9uLmhyZWYgfHxcblx0XHRcdFx0XHRcdCFmaW5kQmFkZ2VUYXJnZXQoZmFsc2UpXG5cdFx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0XHRzY2hlZHVsZVJlbmRlcigpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSwgRE9NX1JFTkRFUl9ERUJPVU5DRV9NUyk7XG5cdFx0XHR9KTtcblx0XHRcdHJlYWRpbmVzc09ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQsIHsgc3VidHJlZTogdHJ1ZSwgY2hpbGRMaXN0OiB0cnVlIH0pO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN0YXJ0UGFnZVdhdGNoZG9nKCkge1xuXHRcdFx0bGV0IGxhc3RPYnNlcnZlZEhyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXG5cdFx0XHRwYWdlV2F0Y2hkb2dUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChsb2NhdGlvbi5ocmVmICE9PSBsYXN0T2JzZXJ2ZWRIcmVmKSB7XG5cdFx0XHRcdFx0bGFzdE9ic2VydmVkSHJlZiA9IGxvY2F0aW9uLmhyZWY7XG5cdFx0XHRcdFx0c3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcCh0cnVlKTtcblx0XHRcdFx0XHRvYnNlcnZlU3Vic2NyaWJlQnV0dG9uQ2hhbmdlcygpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChkb2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09IFwiaGlkZGVuXCIgfHwgIWlzU3VwcG9ydGVkWW91VHViZVBhZ2UoKSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0IWhhc0NvbmZpcm1lZE5vU3Vic2NyaXB0aW9uRm9yQ3VycmVudEhyZWYoKSAmJlxuXHRcdFx0XHRcdCghYmFkZ2UgfHwgYmFkZ2UuZGF0YXNldC5zc0hyZWYgIT09IGxvY2F0aW9uLmhyZWYgfHwgIWZpbmRCYWRnZVRhcmdldChmYWxzZSkpXG5cdFx0XHRcdCkge1xuXHRcdFx0XHRcdHNjaGVkdWxlUmVuZGVyKCk7XG5cdFx0XHRcdH1cblx0XHRcdH0sIFBBR0VfV0FUQ0hET0dfSU5URVJWQUxfTVMpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGhhc0NvbmZpcm1lZE5vU3Vic2NyaXB0aW9uRm9yQ3VycmVudEhyZWYoKSB7XG5cdFx0XHRyZXR1cm4gbGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleS5zdGFydHNXaXRoKGAke2xvY2F0aW9uLmhyZWZ9fGApO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIG9ic2VydmVDYWNoZUNoYW5nZXMoKSB7XG5cdFx0XHRicm93c2VyLnN0b3JhZ2Uub25DaGFuZ2VkLmFkZExpc3RlbmVyKChjaGFuZ2VzLCBhcmVhTmFtZSkgPT4ge1xuXHRcdFx0XHRpZiAoYXJlYU5hbWUgPT09IFwibG9jYWxcIiAmJiBDQUNIRV9TVE9SQUdFX0tFWSBpbiBjaGFuZ2VzKSB7XG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0XHRcdGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0c2NoZWR1bGVSZW5kZXIoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gb2JzZXJ2ZVN1YnNjcmliZUJ1dHRvbkNoYW5nZXMoKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0bm90aWZpY2F0aW9uT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcblxuXHRcdFx0Y29uc3QgdGFyZ2V0ID0gZmluZFN1YnNjcmliZVN1cmZhY2UoKTtcblxuXHRcdFx0aWYgKCF0YXJnZXQpIHtcblx0XHRcdFx0aWYgKHN1YnNjcmliZVJldHJ5VGltZXIpIHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQoc3Vic2NyaWJlUmV0cnlUaW1lcik7XG5cdFx0XHRcdH1cblx0XHRcdFx0c3Vic2NyaWJlUmV0cnlUaW1lciA9IHNldFRpbWVvdXQob2JzZXJ2ZVN1YnNjcmliZUJ1dHRvbkNoYW5nZXMsIDEwMDApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGxldCBsYXN0VGV4dCA9IGdldFN1YnNjcmliZVN1cmZhY2VUZXh0KCk7XG5cdFx0XHRub3RpZmljYXRpb25PYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IG5leHRUZXh0ID0gZ2V0U3Vic2NyaWJlU3VyZmFjZVRleHQoKTtcblx0XHRcdFx0aWYgKG5leHRUZXh0ID09PSBsYXN0VGV4dCkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGxhc3RUZXh0ID0gbmV4dFRleHQ7XG5cdFx0XHRcdGxhc3RQYWdlS2V5ID0gXCJcIjtcblx0XHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdHZvaWQgc2VuZFJ1bnRpbWVNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiBcIlNTX1ZJU0lCTEVfU1VCU0NSSVBUSU9OX0NIQU5HRURcIixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHN1YnNjcmliZUNoYW5nZVRpbWVyID0gc2V0VGltZW91dChzY2hlZHVsZVJlbmRlciwgMzUwMCk7XG5cdFx0XHR9KTtcblxuXHRcdFx0bm90aWZpY2F0aW9uT2JzZXJ2ZXIub2JzZXJ2ZSh0YXJnZXQsIHtcblx0XHRcdFx0c3VidHJlZTogdHJ1ZSxcblx0XHRcdFx0Y2hpbGRMaXN0OiB0cnVlLFxuXHRcdFx0XHRjaGFyYWN0ZXJEYXRhOiB0cnVlLFxuXHRcdFx0XHRhdHRyaWJ1dGVzOiB0cnVlLFxuXHRcdFx0XHRhdHRyaWJ1dGVGaWx0ZXI6IFtcImFyaWEtbGFiZWxcIiwgXCJ0aXRsZVwiXSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHNjaGVkdWxlUmVuZGVyKGRlbGF5ID0gMjUwKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHJlbmRlclRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChyZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG5hdmlnYXRpb25TZXR0bGVEZWxheSA9IE1hdGgubWF4KDAsIG5hdmlnYXRpb25TZXR0bGluZ1VudGlsIC0gRGF0ZS5ub3coKSk7XG5cdFx0XHRyZW5kZXJUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR2b2lkIHJlbmRlckZvckN1cnJlbnRQYWdlKCk7XG5cdFx0XHR9LCBNYXRoLm1heChkZWxheSwgbmF2aWdhdGlvblNldHRsZURlbGF5KSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gc3RhcnROYXZpZ2F0aW9uUmVuZGVyTG9vcChjbGVhckJhZGdlOiBib29sZWFuKSB7XG5cdFx0XHRpZiAoIWlzQWN0aXZlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0bGFzdFBhZ2VLZXkgPSBcIlwiO1xuXHRcdFx0bGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9IFwiXCI7XG5cdFx0XHRyZXNvbHZlZEJhZGdlID0gdW5kZWZpbmVkO1xuXHRcdFx0aWYgKGNsZWFyQmFkZ2UpIHtcblx0XHRcdFx0bmF2aWdhdGlvblNldHRsaW5nVW50aWwgPSBEYXRlLm5vdygpICsgTkFWSUdBVElPTl9TRVRUTEVfREVMQVlfTVM7XG5cdFx0XHRcdHJlbW92ZVN0YWxlQmFkZ2UoKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG5hdmlnYXRpb25SZW5kZXJUaW1lcikge1xuXHRcdFx0XHRjbGVhckludGVydmFsKG5hdmlnYXRpb25SZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHN0b3BBdCA9IERhdGUubm93KCkgKyBOQVZJR0FUSU9OX1JFTkRFUl9XSU5ET1dfTVM7XG5cdFx0XHRzY2hlZHVsZVJlbmRlcigpO1xuXHRcdFx0bmF2aWdhdGlvblJlbmRlclRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0XHRpZiAoRGF0ZS5ub3coKSA+IHN0b3BBdCkge1xuXHRcdFx0XHRcdGlmIChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpIHtcblx0XHRcdFx0XHRcdGNsZWFySW50ZXJ2YWwobmF2aWdhdGlvblJlbmRlclRpbWVyKTtcblx0XHRcdFx0XHRcdG5hdmlnYXRpb25SZW5kZXJUaW1lciA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0c2NoZWR1bGVSZW5kZXIoKTtcblx0XHRcdH0sIE5BVklHQVRJT05fUkVOREVSX0lOVEVSVkFMX01TKTtcblx0XHR9XG5cblx0XHRhc3luYyBmdW5jdGlvbiByZW5kZXJGb3JDdXJyZW50UGFnZSgpIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByZXF1ZXN0SWQgPSArK3JlbmRlclJlcXVlc3RJZDtcblx0XHRcdFx0Y29uc3QgY2hhbm5lbElkID0gYXdhaXQgZmluZEN1cnJlbnRDaGFubmVsSWQoKTtcblx0XHRcdFx0Y29uc3QgcGFnZUtleSA9IGAke2xvY2F0aW9uLmhyZWZ9fCR7Y2hhbm5lbElkID8/IFwibm9uZVwifWA7XG5cblx0XHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghaXNTdXBwb3J0ZWRZb3VUdWJlUGFnZSgpKSB7XG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBwYWdlS2V5O1xuXHRcdFx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgZXhpc3RpbmdCYWRnZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJBREdFX0lEKTtcblx0XHRcdFx0aWYgKCFjaGFubmVsSWQpIHtcblx0XHRcdFx0XHRsYXN0UGFnZUtleSA9IHBhZ2VLZXk7XG5cdFx0XHRcdFx0aWYgKGV4aXN0aW5nQmFkZ2U/LmRhdGFzZXQuc3NIcmVmICE9PSBsb2NhdGlvbi5ocmVmKSB7XG5cdFx0XHRcdFx0XHRyZW1vdmVCYWRnZSgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0bGFzdFBhZ2VLZXkgPT09IHBhZ2VLZXkgJiZcblx0XHRcdFx0XHRleGlzdGluZ0JhZGdlPy5kYXRhc2V0LnNzUGFnZUtleSA9PT0gcGFnZUtleSAmJlxuXHRcdFx0XHRcdGV4aXN0aW5nQmFkZ2UuZGF0YXNldC5zc0hyZWYgPT09IGxvY2F0aW9uLmhyZWZcblx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0bGFzdFBhZ2VLZXkgPSBwYWdlS2V5O1xuXG5cdFx0XHRcdGlmIChyZXNvbHZlZEJhZGdlPy5wYWdlS2V5ID09PSBwYWdlS2V5KSB7XG5cdFx0XHRcdFx0aW5zZXJ0QmFkZ2Uoe1xuXHRcdFx0XHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0XHRcdFx0dGVudXJlOiByZXNvbHZlZEJhZGdlLnRlbnVyZSxcblx0XHRcdFx0XHRcdGRhdGVUZXh0OiByZXNvbHZlZEJhZGdlLmRhdGVUZXh0LFxuXHRcdFx0XHRcdFx0cGFnZUtleSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAobGFzdE5vU3Vic2NyaXB0aW9uUGFnZUtleSA9PT0gcGFnZUtleSkge1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc2VuZFJ1bnRpbWVNZXNzYWdlKHtcblx0XHRcdFx0XHR0eXBlOiBcIlNTX0dFVF9TVEFUVVNcIixcblx0XHRcdFx0XHRjaGFubmVsSWQsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGlmICghcmVzcG9uc2UgfHwgcmVxdWVzdElkICE9PSByZW5kZXJSZXF1ZXN0SWQgfHwgIWlzQWN0aXZlKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKCFpc1N0YXR1c1Jlc3BvbnNlKHJlc3BvbnNlKSB8fCAhcmVzcG9uc2Uub2sgfHwgIXJlc3BvbnNlLnN1YnNjcmlwdGlvbikge1xuXHRcdFx0XHRcdGxhc3ROb1N1YnNjcmlwdGlvblBhZ2VLZXkgPSBwYWdlS2V5O1xuXHRcdFx0XHRcdHJlc29sdmVkQmFkZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0cmVtb3ZlQmFkZ2UoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRsYXN0Tm9TdWJzY3JpcHRpb25QYWdlS2V5ID0gXCJcIjtcblx0XHRcdFx0cmVzb2x2ZWRCYWRnZSA9IHtcblx0XHRcdFx0XHRwYWdlS2V5LFxuXHRcdFx0XHRcdHRlbnVyZTogZ2V0U3Vic2NyaXB0aW9uVGVudXJlKHJlc3BvbnNlLnN1YnNjcmlwdGlvbi5zdWJzY3JpYmVkQXQpLFxuXHRcdFx0XHRcdGRhdGVUZXh0OiBmb3JtYXREYXRlKHJlc3BvbnNlLnN1YnNjcmlwdGlvbi5zdWJzY3JpYmVkQXQpLFxuXHRcdFx0XHR9O1xuXHRcdFx0XHRpbnNlcnRCYWRnZSh7XG5cdFx0XHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0XHRcdHRlbnVyZTogcmVzb2x2ZWRCYWRnZS50ZW51cmUsXG5cdFx0XHRcdFx0ZGF0ZVRleHQ6IHJlc29sdmVkQmFkZ2UuZGF0ZVRleHQsXG5cdFx0XHRcdFx0cGFnZUtleSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRoYW5kbGVFeHRlbnNpb25FcnJvcihlcnJvcik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaW5zZXJ0QmFkZ2Uoe1xuXHRcdFx0Y2hhbm5lbElkLFxuXHRcdFx0dGVudXJlLFxuXHRcdFx0ZGF0ZVRleHQsXG5cdFx0XHRwYWdlS2V5LFxuXHRcdH06IHtcblx0XHRcdGNoYW5uZWxJZDogc3RyaW5nO1xuXHRcdFx0dGVudXJlOiBTdWJzY3JpcHRpb25UZW51cmU7XG5cdFx0XHRkYXRlVGV4dDogc3RyaW5nO1xuXHRcdFx0cGFnZUtleTogc3RyaW5nO1xuXHRcdH0pIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCB0YXJnZXQgPSBmaW5kQmFkZ2VUYXJnZXQoKTtcblx0XHRcdGlmICghdGFyZ2V0KSB7XG5cdFx0XHRcdGlmIChiYWRnZVJldHJ5VGltZXIpIHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQoYmFkZ2VSZXRyeVRpbWVyKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRiYWRnZVJldHJ5VGltZXIgPSBzZXRUaW1lb3V0KHNjaGVkdWxlUmVuZGVyLCA1MDApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRcdFx0aWYgKGV4aXN0aW5nPy5wYXJlbnRFbGVtZW50ID09PSB0YXJnZXQpIHtcblx0XHRcdFx0ZXhpc3RpbmcuZGF0YXNldC5zc0NoYW5uZWxJZCA9IGNoYW5uZWxJZDtcblx0XHRcdFx0ZXhpc3RpbmcuZGF0YXNldC5zc0hyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRcdFx0XHRleGlzdGluZy5kYXRhc2V0LnNzUGFnZUtleSA9IHBhZ2VLZXk7XG5cdFx0XHRcdGV4aXN0aW5nLnNldEF0dHJpYnV0ZShcblx0XHRcdFx0XHRcImFyaWEtbGFiZWxcIixcblx0XHRcdFx0XHRgU3Vic2NyaWJlZCBzaW5jZSAke2RhdGVUZXh0fSwgJHtmb3JtYXRUZW51cmUodGVudXJlKX1gXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGV4aXN0aW5nLnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1zcy10ZW51cmVdXCIpIS50ZXh0Q29udGVudCA9XG5cdFx0XHRcdFx0Zm9ybWF0VGVudXJlTWFyayh0ZW51cmUpO1xuXHRcdFx0XHRleGlzdGluZy5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtc3MtZGF0ZV1cIikhLnRleHRDb250ZW50ID0gZGF0ZVRleHQ7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0cmVtb3ZlQmFkZ2UoKTtcblx0XHRcdHRhcmdldC5hcHBlbmRDaGlsZChjcmVhdGVCYWRnZSh7IGNoYW5uZWxJZCwgdGVudXJlLCBkYXRlVGV4dCwgcGFnZUtleSB9KSk7XG5cdFx0fVxuXG5cdFx0YXN5bmMgZnVuY3Rpb24gc2VuZFJ1bnRpbWVNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24pIHtcblx0XHRcdGlmICghaXNBY3RpdmUpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRyZXR1cm4gKGF3YWl0IGJyb3dzZXIucnVudGltZS5zZW5kTWVzc2FnZShtZXNzYWdlKSkgYXMgRXh0ZW5zaW9uUmVzcG9uc2U7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRoYW5kbGVFeHRlbnNpb25FcnJvcihlcnJvcik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaGFuZGxlRXh0ZW5zaW9uRXJyb3IoZXJyb3I6IHVua25vd24pIHtcblx0XHRcdGlmIChpc0V4dGVuc2lvbkNvbnRleHRJbnZhbGlkYXRlZEVycm9yKGVycm9yKSkge1xuXHRcdFx0XHRzdG9wQ29udGVudFNjcmlwdCgpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN0b3BDb250ZW50U2NyaXB0KCkge1xuXHRcdFx0aWYgKCFpc0FjdGl2ZSkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlzQWN0aXZlID0gZmFsc2U7XG5cdFx0XHRyZW5kZXJSZXF1ZXN0SWQgKz0gMTtcblx0XHRcdG5vdGlmaWNhdGlvbk9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG5cdFx0XHRuYXZpZ2F0aW9uT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcblx0XHRcdHJlYWRpbmVzc09ic2VydmVyPy5kaXNjb25uZWN0KCk7XG5cdFx0XHRjbGVhck1hbmFnZWRUaW1lcnMoKTtcblx0XHRcdHJlbW92ZUJhZGdlKCk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gY2xlYXJNYW5hZ2VkVGltZXJzKCkge1xuXHRcdFx0aWYgKHJlbmRlclRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChyZW5kZXJUaW1lcik7XG5cdFx0XHR9XG5cdFx0XHRpZiAocmVhZGluZXNzVGltZXIpIHtcblx0XHRcdFx0Y2xlYXJUaW1lb3V0KHJlYWRpbmVzc1RpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChzdWJzY3JpYmVSZXRyeVRpbWVyKSB7XG5cdFx0XHRcdGNsZWFyVGltZW91dChzdWJzY3JpYmVSZXRyeVRpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChzdWJzY3JpYmVDaGFuZ2VUaW1lcikge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQoc3Vic2NyaWJlQ2hhbmdlVGltZXIpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGJhZGdlUmV0cnlUaW1lcikge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQoYmFkZ2VSZXRyeVRpbWVyKTtcblx0XHRcdH1cblx0XHRcdGlmIChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpIHtcblx0XHRcdFx0Y2xlYXJJbnRlcnZhbChuYXZpZ2F0aW9uUmVuZGVyVGltZXIpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHBhZ2VXYXRjaGRvZ1RpbWVyKSB7XG5cdFx0XHRcdGNsZWFySW50ZXJ2YWwocGFnZVdhdGNoZG9nVGltZXIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fSxcbn0pO1xuXG5mdW5jdGlvbiBpc1N1cHBvcnRlZFlvdVR1YmVQYWdlKCkge1xuXHRyZXR1cm4gaXNDaGFubmVsUGFnZSgpO1xufVxuXG5mdW5jdGlvbiBpc0NoYW5uZWxQYWdlKHBhdGggPSBsb2NhdGlvbi5wYXRobmFtZSkge1xuXHRyZXR1cm4gKFxuXHRcdHBhdGguc3RhcnRzV2l0aChcIi9AXCIpIHx8XG5cdFx0cGF0aC5zdGFydHNXaXRoKFwiL2NoYW5uZWwvXCIpIHx8XG5cdFx0cGF0aC5zdGFydHNXaXRoKFwiL2MvXCIpIHx8XG5cdFx0cGF0aC5zdGFydHNXaXRoKFwiL3VzZXIvXCIpXG5cdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZpbmRDdXJyZW50Q2hhbm5lbElkKCkge1xuXHRjb25zdCBwYXRoID0gbG9jYXRpb24ucGF0aG5hbWU7XG5cdGNvbnN0IHBhdGhDaGFubmVsSWQgPSBtYXRjaENoYW5uZWxJZChwYXRoKTtcblx0aWYgKHBhdGhDaGFubmVsSWQpIHtcblx0XHRyZXR1cm4gcGF0aENoYW5uZWxJZDtcblx0fVxuXG5cdGlmICghaXNDaGFubmVsUGFnZShwYXRoKSkge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRyZXR1cm4gKFxuXHRcdChhd2FpdCBmaW5kQ3VycmVudENoYW5uZWxJZEZyb21QYWdlQ29udGV4dCgpKSA/PyBmaW5kQ3VycmVudENoYW5uZWxJZEZyb21Eb20oKVxuXHQpO1xufVxuXG5mdW5jdGlvbiBmaW5kQ3VycmVudENoYW5uZWxJZEZyb21Eb20oKSB7XG5cdGNvbnN0IGNoYW5uZWxTZWxlY3RvcnMgPSBbXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSBtZXRhW2l0ZW1wcm9wPSdjaGFubmVsSWQnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtYzQtdGFiYmVkLWhlYWRlci1yZW5kZXJlciBhW2hyZWYqPScvY2hhbm5lbC8nXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10gI2NoYW5uZWwtaGVhZGVyIGFbaHJlZio9Jy9jaGFubmVsLyddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSAjcGFnZS1oZWFkZXIgYVtocmVmKj0nL2NoYW5uZWwvJ11cIixcblx0XHRcIm1ldGFbaXRlbXByb3A9J2NoYW5uZWxJZCddXCIsXG5cdFx0XCJsaW5rW3JlbD0nY2Fub25pY2FsJ11cIixcblx0XHRcImxpbmtbaXRlbXByb3A9J3VybCddXCIsXG5cdF07XG5cblx0Zm9yIChjb25zdCBzZWxlY3RvciBvZiBjaGFubmVsU2VsZWN0b3JzKSB7XG5cdFx0Y29uc3QgZWxlbWVudCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsZWN0b3IpO1xuXHRcdGNvbnN0IHZhbHVlID1cblx0XHRcdGVsZW1lbnQ/LmdldEF0dHJpYnV0ZShcImNvbnRlbnRcIikgPz9cblx0XHRcdGVsZW1lbnQ/LmdldEF0dHJpYnV0ZShcImhyZWZcIikgPz9cblx0XHRcdGVsZW1lbnQ/LnRleHRDb250ZW50O1xuXHRcdGNvbnN0IGNoYW5uZWxJZCA9IG1hdGNoQ2hhbm5lbElkKHZhbHVlKTtcblx0XHRpZiAoY2hhbm5lbElkKSB7XG5cdFx0XHRyZXR1cm4gY2hhbm5lbElkO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IGJyb3dzZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXVwiKTtcblx0Y29uc3QgaGVhZGVyQ2hhbm5lbElkID0gbWF0Y2hDaGFubmVsSWQoXG5cdFx0YnJvd3NlXG5cdFx0XHQ/LnF1ZXJ5U2VsZWN0b3IoXG5cdFx0XHRcdFwieXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyLCB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsLCB5dGQtYzQtdGFiYmVkLWhlYWRlci1yZW5kZXJlciwgI2NoYW5uZWwtaGVhZGVyLCAjcGFnZS1oZWFkZXJcIlxuXHRcdFx0KVxuXHRcdFx0Py5pbm5lckhUTUxcblx0KTtcblx0aWYgKGhlYWRlckNoYW5uZWxJZCkge1xuXHRcdHJldHVybiBoZWFkZXJDaGFubmVsSWQ7XG5cdH1cbn1cblxuZnVuY3Rpb24gbWF0Y2hDaGFubmVsSWQodmFsdWU/OiBzdHJpbmcgfCBudWxsKSB7XG5cdHJldHVybiB2YWx1ZT8ubWF0Y2goQ0hBTk5FTF9JRF9SRSk/LlswXTtcbn1cblxuZnVuY3Rpb24gZmluZEN1cnJlbnRDaGFubmVsSWRGcm9tUGFnZUNvbnRleHQoKSB7XG5cdGNvbnN0IHJlcXVlc3RJZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG5cblx0cmV0dXJuIG5ldyBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4oKHJlc29sdmUpID0+IHtcblx0XHRpbmplY3RQYWdlQ29udGV4dENoYW5uZWxJZFJlYWRlcigpO1xuXG5cdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0d2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIG9uTWVzc2FnZSk7XG5cdFx0XHRyZXNvbHZlKHVuZGVmaW5lZCk7XG5cdFx0fSwgMzAwKTtcblxuXHRcdGZ1bmN0aW9uIG9uTWVzc2FnZShldmVudDogTWVzc2FnZUV2ZW50KSB7XG5cdFx0XHRpZiAoZXZlbnQuc291cmNlICE9PSB3aW5kb3cpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBkYXRhID0gZXZlbnQuZGF0YSBhc1xuXHRcdFx0XHR8IHtcblx0XHRcdFx0XHRcdHNvdXJjZT86IHN0cmluZztcblx0XHRcdFx0XHRcdHR5cGU/OiBzdHJpbmc7XG5cdFx0XHRcdFx0XHRyZXF1ZXN0SWQ/OiBzdHJpbmc7XG5cdFx0XHRcdFx0XHRjaGFubmVsSWQ/OiBzdHJpbmc7XG5cdFx0XHRcdCAgfVxuXHRcdFx0XHR8IHVuZGVmaW5lZDtcblxuXHRcdFx0aWYgKFxuXHRcdFx0XHRkYXRhPy5zb3VyY2UgIT09IFBBR0VfQ09OVEVYVF9NRVNTQUdFX1NPVVJDRSB8fFxuXHRcdFx0XHRkYXRhLnR5cGUgIT09IFBBR0VfQ09OVEVYVF9SRVNQT05TRV9UWVBFIHx8XG5cdFx0XHRcdGRhdGEucmVxdWVzdElkICE9PSByZXF1ZXN0SWRcblx0XHRcdCkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRcdFx0cmVzb2x2ZShtYXRjaENoYW5uZWxJZChkYXRhLmNoYW5uZWxJZCkpO1xuXHRcdH1cblxuXHRcdHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRcdHdpbmRvdy5wb3N0TWVzc2FnZShcblx0XHRcdHtcblx0XHRcdFx0c291cmNlOiBQQUdFX0NPTlRFWFRfTUVTU0FHRV9TT1VSQ0UsXG5cdFx0XHRcdHR5cGU6IFBBR0VfQ09OVEVYVF9SRVFVRVNUX1RZUEUsXG5cdFx0XHRcdHJlcXVlc3RJZCxcblx0XHRcdH0sXG5cdFx0XHR3aW5kb3cubG9jYXRpb24ub3JpZ2luXG5cdFx0KTtcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGluamVjdFBhZ2VDb250ZXh0Q2hhbm5lbElkUmVhZGVyKCkge1xuXHRpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoUEFHRV9DT05URVhUX1NDUklQVF9JRCkpIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBzY3JpcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2NyaXB0XCIpO1xuXHRzY3JpcHQuaWQgPSBQQUdFX0NPTlRFWFRfU0NSSVBUX0lEO1xuXHRzY3JpcHQuc3JjID0gYnJvd3Nlci5ydW50aW1lLmdldFVSTChcIi9wYWdlLWNvbnRleHQtY2hhbm5lbC5qc1wiKTtcblx0ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmFwcGVuZENoaWxkKHNjcmlwdCk7XG59XG5cbmZ1bmN0aW9uIGlzRXh0ZW5zaW9uQ29udGV4dEludmFsaWRhdGVkRXJyb3IoZXJyb3I6IHVua25vd24pIHtcblx0Y29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0cmV0dXJuIG1lc3NhZ2UudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImV4dGVuc2lvbiBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xufVxuXG5mdW5jdGlvbiBmaW5kQmFkZ2VUYXJnZXQobWFya0hvc3QgPSB0cnVlKSB7XG5cdGNvbnN0IGNoYW5uZWxDYW5kaWRhdGVzID0gW1xuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyICNidXR0b25zXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtcGFnZS1oZWFkZXItcmVuZGVyZXIgeXQtZmxleGlibGUtYWN0aW9ucy12aWV3LW1vZGVsXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsIHl0LWZsZXhpYmxlLWFjdGlvbnMtdmlldy1tb2RlbFwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCAjYnV0dG9uc1wiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgI2J1dHRvbnNcIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddICNjaGFubmVsLWhlYWRlciAjYnV0dG9uc1wiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10gI3BhZ2UtaGVhZGVyICNidXR0b25zXCIsXG5cdF07XG5cblx0Zm9yIChjb25zdCBzZWxlY3RvciBvZiBjaGFubmVsQ2FuZGlkYXRlcykge1xuXHRcdGNvbnN0IGVsZW1lbnQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbGVjdG9yKTtcblx0XHRpZiAoZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSB7XG5cdFx0XHRpZiAobWFya0hvc3QpIHtcblx0XHRcdFx0ZWxlbWVudC5jbGFzc0xpc3QuYWRkKFwic3MtYmFkZ2UtaG9zdFwiKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBlbGVtZW50O1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IHN1YnNjcmliZVN1cmZhY2UgPSBmaW5kU3Vic2NyaWJlU3VyZmFjZSgpO1xuXHRjb25zdCB0YXJnZXQgPVxuXHRcdHN1YnNjcmliZVN1cmZhY2U/LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFxuXHRcdFx0XCJ5dC1mbGV4aWJsZS1hY3Rpb25zLXZpZXctbW9kZWwsICNidXR0b25zLCAjc3Vic2NyaWJlLWJ1dHRvblwiXG5cdFx0KSA/P1xuXHRcdHN1YnNjcmliZVN1cmZhY2U/LnBhcmVudEVsZW1lbnQgPz9cblx0XHR1bmRlZmluZWQ7XG5cblx0aWYgKHRhcmdldCAmJiBtYXJrSG9zdCkge1xuXHRcdHRhcmdldC5jbGFzc0xpc3QuYWRkKFwic3MtYmFkZ2UtaG9zdFwiKTtcblx0fVxuXG5cdHJldHVybiB0YXJnZXQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJhZGdlKHtcblx0Y2hhbm5lbElkLFxuXHR0ZW51cmUsXG5cdGRhdGVUZXh0LFxuXHRwYWdlS2V5LFxufToge1xuXHRjaGFubmVsSWQ6IHN0cmluZztcblx0dGVudXJlOiBTdWJzY3JpcHRpb25UZW51cmU7XG5cdGRhdGVUZXh0OiBzdHJpbmc7XG5cdHBhZ2VLZXk6IHN0cmluZztcbn0pIHtcblx0Y29uc3QgY29udGFpbmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcblx0Y29udGFpbmVyLmlkID0gQkFER0VfSUQ7XG5cdGNvbnRhaW5lci5kYXRhc2V0LnNzQ2hhbm5lbElkID0gY2hhbm5lbElkO1xuXHRjb250YWluZXIuZGF0YXNldC5zc0hyZWYgPSBsb2NhdGlvbi5ocmVmO1xuXHRjb250YWluZXIuZGF0YXNldC5zc1BhZ2VLZXkgPSBwYWdlS2V5O1xuXHRjb250YWluZXIuc2V0QXR0cmlidXRlKFxuXHRcdFwiYXJpYS1sYWJlbFwiLFxuXHRcdGBTdWJzY3JpYmVkIHNpbmNlICR7ZGF0ZVRleHR9LCAke2Zvcm1hdFRlbnVyZSh0ZW51cmUpfWBcblx0KTtcblx0Y29udGFpbmVyLmlubmVySFRNTCA9IGBcblx0XHQ8c3BhbiBjbGFzcz1cInNzLWJhZGdlLW1hcmtcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5cblx0XHRcdDxzcGFuIGNsYXNzPVwic3MtYmFkZ2UtdGVudXJlXCIgZGF0YS1zcy10ZW51cmU+JHtmb3JtYXRUZW51cmVNYXJrKHRlbnVyZSl9PC9zcGFuPlxuXHRcdDwvc3Bhbj5cblx0XHQ8c3BhbiBjbGFzcz1cInNzLWJhZGdlLWNvcHlcIj5cblx0XHRcdDxzcGFuIGNsYXNzPVwic3MtYmFkZ2UtdGl0bGVcIj5TVUJTQ1JJQkVEIFNJTkNFPC9zcGFuPlxuXHRcdFx0PHNwYW4gY2xhc3M9XCJzcy1iYWRnZS1kYXRlXCIgZGF0YS1zcy1kYXRlPiR7ZGF0ZVRleHR9PC9zcGFuPlxuXHRcdDwvc3Bhbj5cblx0YDtcblx0cmV0dXJuIGNvbnRhaW5lcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlQmFkZ2UoKSB7XG5cdGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJBREdFX0lEKT8ucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVN0YWxlQmFkZ2UoKSB7XG5cdGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQkFER0VfSUQpO1xuXHRpZiAoIWV4aXN0aW5nIHx8IGV4aXN0aW5nLmRhdGFzZXQuc3NIcmVmID09PSBsb2NhdGlvbi5ocmVmKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0ZXhpc3RpbmcucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKSB7XG5cdGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChTVFlMRV9JRCkpIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcblx0c3R5bGUuaWQgPSBTVFlMRV9JRDtcblx0c3R5bGUudGV4dENvbnRlbnQgPSBgXG5cdFx0LnNzLWJhZGdlLWhvc3Qge1xuXHRcdFx0ZGlzcGxheTogaW5saW5lLWZsZXggIWltcG9ydGFudDtcblx0XHRcdGFsaWduLWl0ZW1zOiBjZW50ZXIgIWltcG9ydGFudDtcblx0XHRcdGdhcDogMTJweCAhaW1wb3J0YW50O1xuXHRcdFx0ZmxleC13cmFwOiB3cmFwICFpbXBvcnRhbnQ7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IHtcblx0XHRcdC0tc3MtYmFkZ2UtYmc6IHZhcigtLXl0LXNwZWMtYnV0dG9uLWNoaXAtYmFja2dyb3VuZC1ob3ZlciwgI2YyZjJmMik7XG5cdFx0XHQtLXNzLWJhZGdlLWZnOiB2YXIoLS15dC1zcGVjLXRleHQtcHJpbWFyeSwgIzBmMGYwZik7XG5cdFx0XHQtLXNzLWJhZGdlLW1hcmstYmc6IHZhcigtLXl0LXNwZWMtdGV4dC1wcmltYXJ5LCAjMGYwZjBmKTtcblx0XHRcdC0tc3MtYmFkZ2UtbWFyay1mZzogdmFyKC0teXQtc3BlYy1iYXNlLWJhY2tncm91bmQsICNmZmYpO1xuXHRcdFx0ZGlzcGxheTogaW5saW5lLWZsZXg7XG5cdFx0XHRhbGlnbi1pdGVtczogY2VudGVyO1xuXHRcdFx0Z2FwOiA4cHg7XG5cdFx0XHRib3gtc2l6aW5nOiBib3JkZXItYm94O1xuXHRcdFx0bWluLWhlaWdodDogMzZweDtcblx0XHRcdHBhZGRpbmc6IDVweCAxMnB4IDVweCA2cHg7XG5cdFx0XHRib3JkZXI6IDA7XG5cdFx0XHRib3JkZXItcmFkaXVzOiAxOHB4O1xuXHRcdFx0YmFja2dyb3VuZDogdmFyKC0tc3MtYmFkZ2UtYmcpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXNzLWJhZGdlLWZnKTtcblx0XHRcdGZvbnQtZmFtaWx5OiBSb2JvdG8sIEFyaWFsLCBzYW5zLXNlcmlmO1xuXHRcdFx0bGluZS1oZWlnaHQ6IDEuMTtcblx0XHRcdHdoaXRlLXNwYWNlOiBub3dyYXA7XG5cdFx0XHR2ZXJ0aWNhbC1hbGlnbjogbWlkZGxlO1xuXHRcdH1cblxuXHRcdCMke0JBREdFX0lEfSAuc3MtYmFkZ2UtbWFyayB7XG5cdFx0XHRkaXNwbGF5OiBpbmxpbmUtZ3JpZDtcblx0XHRcdHBsYWNlLWl0ZW1zOiBjZW50ZXI7XG5cdFx0XHR3aWR0aDogMjRweDtcblx0XHRcdGhlaWdodDogMjRweDtcblx0XHRcdGJvcmRlci1yYWRpdXM6IDUwJTtcblx0XHRcdGJhY2tncm91bmQ6IHZhcigtLXNzLWJhZGdlLW1hcmstYmcpO1xuXHRcdFx0Y29sb3I6IHZhcigtLXNzLWJhZGdlLW1hcmstZmcpO1xuXHRcdH1cblxuXHRcdCMke0JBREdFX0lEfSAuc3MtYmFkZ2UtdGVudXJlIHtcblx0XHRcdGZvbnQtc2l6ZTogMTFweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA4MDA7XG5cdFx0XHRsaW5lLWhlaWdodDogMTtcblx0XHRcdGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS1jb3B5IHtcblx0XHRcdGRpc3BsYXk6IGZsZXg7XG5cdFx0XHRmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuXHRcdFx0YWxpZ24taXRlbXM6IGZsZXgtc3RhcnQ7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS10aXRsZSB7XG5cdFx0XHRmb250LXNpemU6IDlweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA3MDA7XG5cdFx0XHRsZXR0ZXItc3BhY2luZzogMDtcblx0XHRcdG9wYWNpdHk6IDE7XG5cdFx0fVxuXG5cdFx0IyR7QkFER0VfSUR9IC5zcy1iYWRnZS1kYXRlIHtcblx0XHRcdGZvbnQtc2l6ZTogMTFweDtcblx0XHRcdGZvbnQtd2VpZ2h0OiA3MDA7XG5cdFx0XHRvcGFjaXR5OiAxO1xuXHRcdH1cblxuXHRcdGh0bWxbZGFya10gIyR7QkFER0VfSUR9LFxuXHRcdFtkYXJrXSAjJHtCQURHRV9JRH0ge1xuXHRcdFx0LS1zcy1iYWRnZS1iZzogIzI4MjgyODtcblx0XHRcdC0tc3MtYmFkZ2UtZmc6IHZhcigtLXl0LXNwZWMtdGV4dC1wcmltYXJ5LCAjZmZmKTtcblx0XHRcdC0tc3MtYmFkZ2UtbWFyay1iZzogdmFyKC0teXQtc3BlYy10ZXh0LXByaW1hcnksICNmZmYpO1xuXHRcdFx0LS1zcy1iYWRnZS1tYXJrLWZnOiB2YXIoLS15dC1zcGVjLWJhc2UtYmFja2dyb3VuZCwgIzBmMGYwZik7XG5cdFx0fVxuXG5cdFx0aHRtbFtkYXJrXSAjJHtCQURHRV9JRH0gLnNzLWJhZGdlLW1hcmssXG5cdFx0W2RhcmtdICMke0JBREdFX0lEfSAuc3MtYmFkZ2UtbWFyayB7XG5cdFx0XHRiYWNrZ3JvdW5kOiB2YXIoLS1zcy1iYWRnZS1tYXJrLWJnKTtcblx0XHRcdGNvbG9yOiB2YXIoLS1zcy1iYWRnZS1tYXJrLWZnKTtcblx0XHR9XG5cblx0XHRAbWVkaWEgKG1heC13aWR0aDogNzAwcHgpIHtcblx0XHRcdCMke0JBREdFX0lEfSB7XG5cdFx0XHRcdG1hcmdpbi10b3A6IDhweDtcblx0XHRcdH1cblx0XHR9XG5cdGA7XG5cdGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5hcHBlbmRDaGlsZChzdHlsZSk7XG59XG5cbmZ1bmN0aW9uIGdldFN1YnNjcmlwdGlvblRlbnVyZSh2YWx1ZTogc3RyaW5nKTogU3Vic2NyaXB0aW9uVGVudXJlIHtcblx0Y29uc3QgZGF0ZSA9IG5ldyBEYXRlKHZhbHVlKTtcblx0aWYgKE51bWJlci5pc05hTihkYXRlLmdldFRpbWUoKSkpIHtcblx0XHRyZXR1cm4geyB2YWx1ZTogMCwgdW5pdDogXCJEXCIgfTtcblx0fVxuXG5cdGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG5cdGxldCB5ZWFycyA9IG5vdy5nZXRGdWxsWWVhcigpIC0gZGF0ZS5nZXRGdWxsWWVhcigpO1xuXHRpZiAobm93IDwgZ2V0U2hpZnRlZERhdGUoZGF0ZSwgeWVhcnMsIFwieWVhclwiKSkge1xuXHRcdHllYXJzIC09IDE7XG5cdH1cblx0aWYgKHllYXJzID49IDEpIHtcblx0XHRyZXR1cm4geyB2YWx1ZTogeWVhcnMsIHVuaXQ6IFwiWVwiIH07XG5cdH1cblxuXHRsZXQgbW9udGhzID1cblx0XHQobm93LmdldEZ1bGxZZWFyKCkgLSBkYXRlLmdldEZ1bGxZZWFyKCkpICogMTIgK1xuXHRcdG5vdy5nZXRNb250aCgpIC1cblx0XHRkYXRlLmdldE1vbnRoKCk7XG5cdGlmIChub3cgPCBnZXRTaGlmdGVkRGF0ZShkYXRlLCBtb250aHMsIFwibW9udGhcIikpIHtcblx0XHRtb250aHMgLT0gMTtcblx0fVxuXHRpZiAobW9udGhzID49IDEpIHtcblx0XHRyZXR1cm4geyB2YWx1ZTogbW9udGhzLCB1bml0OiBcIk1cIiB9O1xuXHR9XG5cblx0Y29uc3QgZGF5cyA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKG5vdy5nZXRUaW1lKCkgLSBkYXRlLmdldFRpbWUoKSkgLyBNU19QRVJfREFZKSk7XG5cdHJldHVybiB7IHZhbHVlOiBkYXlzLCB1bml0OiBcIkRcIiB9O1xufVxuXG5mdW5jdGlvbiBnZXRTaGlmdGVkRGF0ZShkYXRlOiBEYXRlLCBhbW91bnQ6IG51bWJlciwgdW5pdDogXCJ5ZWFyXCIgfCBcIm1vbnRoXCIpIHtcblx0Y29uc3Qgc2hpZnRlZCA9IG5ldyBEYXRlKGRhdGUpO1xuXHRpZiAodW5pdCA9PT0gXCJ5ZWFyXCIpIHtcblx0XHRzaGlmdGVkLnNldEZ1bGxZZWFyKGRhdGUuZ2V0RnVsbFllYXIoKSArIGFtb3VudCk7XG5cdH0gZWxzZSB7XG5cdFx0c2hpZnRlZC5zZXRNb250aChkYXRlLmdldE1vbnRoKCkgKyBhbW91bnQpO1xuXHR9XG5cdHJldHVybiBzaGlmdGVkO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRUZW51cmVNYXJrKHRlbnVyZTogU3Vic2NyaXB0aW9uVGVudXJlKSB7XG5cdHJldHVybiBgJHt0ZW51cmUudmFsdWV9JHt0ZW51cmUudW5pdH1gO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRUZW51cmUodGVudXJlOiBTdWJzY3JpcHRpb25UZW51cmUpIHtcblx0Y29uc3QgdW5pdCA9XG5cdFx0dGVudXJlLnVuaXQgPT09IFwiWVwiID8gXCJ5ZWFyXCIgOiB0ZW51cmUudW5pdCA9PT0gXCJNXCIgPyBcIm1vbnRoXCIgOiBcImRheVwiO1xuXHRyZXR1cm4gYCR7dGVudXJlLnZhbHVlfSAke3VuaXR9JHt0ZW51cmUudmFsdWUgPT09IDEgPyBcIlwiIDogXCJzXCJ9YDtcbn1cblxuZnVuY3Rpb24gZm9ybWF0RGF0ZSh2YWx1ZTogc3RyaW5nKSB7XG5cdGNvbnN0IGRhdGUgPSBuZXcgRGF0ZSh2YWx1ZSk7XG5cdGlmIChOdW1iZXIuaXNOYU4oZGF0ZS5nZXRUaW1lKCkpKSB7XG5cdFx0cmV0dXJuIHZhbHVlO1xuXHR9XG5cblx0cmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KHVuZGVmaW5lZCwge1xuXHRcdG1vbnRoOiBcImxvbmdcIixcblx0XHRkYXk6IFwibnVtZXJpY1wiLFxuXHRcdHllYXI6IFwibnVtZXJpY1wiLFxuXHR9KS5mb3JtYXQoZGF0ZSk7XG59XG5cbmZ1bmN0aW9uIGdldFN1YnNjcmliZVN1cmZhY2VUZXh0KCkge1xuXHRjb25zdCB0YXJnZXQgPSBmaW5kU3Vic2NyaWJlU3VyZmFjZSgpO1xuXG5cdHJldHVybiBbXG5cdFx0dGFyZ2V0Py50ZXh0Q29udGVudCxcblx0XHR0YXJnZXQ/LmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiksXG5cdFx0dGFyZ2V0Py5nZXRBdHRyaWJ1dGUoXCJ0aXRsZVwiKSxcblx0XVxuXHRcdC5maWx0ZXIoQm9vbGVhbilcblx0XHQuam9pbihcIiBcIilcblx0XHQudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBmaW5kU3Vic2NyaWJlU3VyZmFjZSgpIHtcblx0Y29uc3QgY2hhbm5lbFNlbGVjdG9ycyA9IFtcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciB5dGQtc3Vic2NyaWJlLWJ1dHRvbi1yZW5kZXJlclwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLXBhZ2UtaGVhZGVyLXJlbmRlcmVyIGJ1dHRvblthcmlhLWxhYmVsKj0nU3Vic2NyaWJlJ11cIixcblx0XHRcInl0ZC1icm93c2VbcGFnZS1zdWJ0eXBlPSdjaGFubmVscyddIHl0ZC1wYWdlLWhlYWRlci1yZW5kZXJlciBidXR0b25bYXJpYS1sYWJlbCo9J1N1YnNjcmliZWQnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCB5dGQtc3Vic2NyaWJlLWJ1dHRvbi1yZW5kZXJlclwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXQtcGFnZS1oZWFkZXItdmlldy1tb2RlbCBidXR0b25bYXJpYS1sYWJlbCo9J1N1YnNjcmliZSddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dC1wYWdlLWhlYWRlci12aWV3LW1vZGVsIGJ1dHRvblthcmlhLWxhYmVsKj0nU3Vic2NyaWJlZCddXCIsXG5cdFx0XCJ5dGQtYnJvd3NlW3BhZ2Utc3VidHlwZT0nY2hhbm5lbHMnXSB5dGQtYzQtdGFiYmVkLWhlYWRlci1yZW5kZXJlciB5dGQtc3Vic2NyaWJlLWJ1dHRvbi1yZW5kZXJlclwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgYnV0dG9uW2FyaWEtbGFiZWwqPSdTdWJzY3JpYmUnXVwiLFxuXHRcdFwieXRkLWJyb3dzZVtwYWdlLXN1YnR5cGU9J2NoYW5uZWxzJ10geXRkLWM0LXRhYmJlZC1oZWFkZXItcmVuZGVyZXIgYnV0dG9uW2FyaWEtbGFiZWwqPSdTdWJzY3JpYmVkJ11cIixcblx0XTtcblxuXHRmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIGNoYW5uZWxTZWxlY3RvcnMpIHtcblx0XHRjb25zdCBlbGVtZW50ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWxlY3Rvcik7XG5cdFx0aWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkge1xuXHRcdFx0cmV0dXJuIGVsZW1lbnQ7XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGlzU3RhdHVzUmVzcG9uc2UocmVzcG9uc2U6IEV4dGVuc2lvblJlc3BvbnNlKTogcmVzcG9uc2UgaXMgU3RhdHVzUmVzcG9uc2Uge1xuXHRyZXR1cm4gXCJhdXRoU3RhdHVzXCIgaW4gcmVzcG9uc2U7XG59XG4iLCJmdW5jdGlvbiBwcmludChtZXRob2QsIC4uLmFyZ3MpIHtcbiAgaWYgKGltcG9ydC5tZXRhLmVudi5NT0RFID09PSBcInByb2R1Y3Rpb25cIikgcmV0dXJuO1xuICBpZiAodHlwZW9mIGFyZ3NbMF0gPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gYXJncy5zaGlmdCgpO1xuICAgIG1ldGhvZChgW3d4dF0gJHttZXNzYWdlfWAsIC4uLmFyZ3MpO1xuICB9IGVsc2Uge1xuICAgIG1ldGhvZChcIlt3eHRdXCIsIC4uLmFyZ3MpO1xuICB9XG59XG5leHBvcnQgY29uc3QgbG9nZ2VyID0ge1xuICBkZWJ1ZzogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUuZGVidWcsIC4uLmFyZ3MpLFxuICBsb2c6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmxvZywgLi4uYXJncyksXG4gIHdhcm46ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLndhcm4sIC4uLmFyZ3MpLFxuICBlcnJvcjogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUuZXJyb3IsIC4uLmFyZ3MpXG59O1xuIiwiaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuZXhwb3J0IGNsYXNzIFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG4gIGNvbnN0cnVjdG9yKG5ld1VybCwgb2xkVXJsKSB7XG4gICAgc3VwZXIoV3h0TG9jYXRpb25DaGFuZ2VFdmVudC5FVkVOVF9OQU1FLCB7fSk7XG4gICAgdGhpcy5uZXdVcmwgPSBuZXdVcmw7XG4gICAgdGhpcy5vbGRVcmwgPSBvbGRVcmw7XG4gIH1cbiAgc3RhdGljIEVWRU5UX05BTUUgPSBnZXRVbmlxdWVFdmVudE5hbWUoXCJ3eHQ6bG9jYXRpb25jaGFuZ2VcIik7XG59XG5leHBvcnQgZnVuY3Rpb24gZ2V0VW5pcXVlRXZlbnROYW1lKGV2ZW50TmFtZSkge1xuICByZXR1cm4gYCR7YnJvd3Nlcj8ucnVudGltZT8uaWR9OiR7aW1wb3J0Lm1ldGEuZW52LkVOVFJZUE9JTlR9OiR7ZXZlbnROYW1lfWA7XG59XG4iLCJpbXBvcnQgeyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IH0gZnJvbSBcIi4vY3VzdG9tLWV2ZW50cy5tanNcIjtcbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVMb2NhdGlvbldhdGNoZXIoY3R4KSB7XG4gIGxldCBpbnRlcnZhbDtcbiAgbGV0IG9sZFVybDtcbiAgcmV0dXJuIHtcbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGxvY2F0aW9uIHdhdGNoZXIgaXMgYWN0aXZlbHkgbG9va2luZyBmb3IgVVJMIGNoYW5nZXMuIElmIGl0J3MgYWxyZWFkeSB3YXRjaGluZyxcbiAgICAgKiB0aGlzIGlzIGEgbm9vcC5cbiAgICAgKi9cbiAgICBydW4oKSB7XG4gICAgICBpZiAoaW50ZXJ2YWwgIT0gbnVsbCkgcmV0dXJuO1xuICAgICAgb2xkVXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICAgIGludGVydmFsID0gY3R4LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgbGV0IG5ld1VybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgICAgIGlmIChuZXdVcmwuaHJlZiAhPT0gb2xkVXJsLmhyZWYpIHtcbiAgICAgICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgV3h0TG9jYXRpb25DaGFuZ2VFdmVudChuZXdVcmwsIG9sZFVybCkpO1xuICAgICAgICAgIG9sZFVybCA9IG5ld1VybDtcbiAgICAgICAgfVxuICAgICAgfSwgMWUzKTtcbiAgICB9XG4gIH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi4vdXRpbHMvaW50ZXJuYWwvbG9nZ2VyLm1qc1wiO1xuaW1wb3J0IHtcbiAgZ2V0VW5pcXVlRXZlbnROYW1lXG59IGZyb20gXCIuL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVMb2NhdGlvbldhdGNoZXIgfSBmcm9tIFwiLi9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLm1qc1wiO1xuZXhwb3J0IGNsYXNzIENvbnRlbnRTY3JpcHRDb250ZXh0IHtcbiAgY29uc3RydWN0b3IoY29udGVudFNjcmlwdE5hbWUsIG9wdGlvbnMpIHtcbiAgICB0aGlzLmNvbnRlbnRTY3JpcHROYW1lID0gY29udGVudFNjcmlwdE5hbWU7XG4gICAgdGhpcy5vcHRpb25zID0gb3B0aW9ucztcbiAgICB0aGlzLmFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBpZiAodGhpcy5pc1RvcEZyYW1lKSB7XG4gICAgICB0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cyh7IGlnbm9yZUZpcnN0RXZlbnQ6IHRydWUgfSk7XG4gICAgICB0aGlzLnN0b3BPbGRTY3JpcHRzKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubGlzdGVuRm9yTmV3ZXJTY3JpcHRzKCk7XG4gICAgfVxuICB9XG4gIHN0YXRpYyBTQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUgPSBnZXRVbmlxdWVFdmVudE5hbWUoXG4gICAgXCJ3eHQ6Y29udGVudC1zY3JpcHQtc3RhcnRlZFwiXG4gICk7XG4gIGlzVG9wRnJhbWUgPSB3aW5kb3cuc2VsZiA9PT0gd2luZG93LnRvcDtcbiAgYWJvcnRDb250cm9sbGVyO1xuICBsb2NhdGlvbldhdGNoZXIgPSBjcmVhdGVMb2NhdGlvbldhdGNoZXIodGhpcyk7XG4gIHJlY2VpdmVkTWVzc2FnZUlkcyA9IC8qIEBfX1BVUkVfXyAqLyBuZXcgU2V0KCk7XG4gIGdldCBzaWduYWwoKSB7XG4gICAgcmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLnNpZ25hbDtcbiAgfVxuICBhYm9ydChyZWFzb24pIHtcbiAgICByZXR1cm4gdGhpcy5hYm9ydENvbnRyb2xsZXIuYWJvcnQocmVhc29uKTtcbiAgfVxuICBnZXQgaXNJbnZhbGlkKCkge1xuICAgIGlmIChicm93c2VyLnJ1bnRpbWUuaWQgPT0gbnVsbCkge1xuICAgICAgdGhpcy5ub3RpZnlJbnZhbGlkYXRlZCgpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5zaWduYWwuYWJvcnRlZDtcbiAgfVxuICBnZXQgaXNWYWxpZCgpIHtcbiAgICByZXR1cm4gIXRoaXMuaXNJbnZhbGlkO1xuICB9XG4gIC8qKlxuICAgKiBBZGQgYSBsaXN0ZW5lciB0aGF0IGlzIGNhbGxlZCB3aGVuIHRoZSBjb250ZW50IHNjcmlwdCdzIGNvbnRleHQgaXMgaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIEByZXR1cm5zIEEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihjYik7XG4gICAqIGNvbnN0IHJlbW92ZUludmFsaWRhdGVkTGlzdGVuZXIgPSBjdHgub25JbnZhbGlkYXRlZCgoKSA9PiB7XG4gICAqICAgYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5yZW1vdmVMaXN0ZW5lcihjYik7XG4gICAqIH0pXG4gICAqIC8vIC4uLlxuICAgKiByZW1vdmVJbnZhbGlkYXRlZExpc3RlbmVyKCk7XG4gICAqL1xuICBvbkludmFsaWRhdGVkKGNiKSB7XG4gICAgdGhpcy5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcbiAgICByZXR1cm4gKCkgPT4gdGhpcy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcbiAgfVxuICAvKipcbiAgICogUmV0dXJuIGEgcHJvbWlzZSB0aGF0IG5ldmVyIHJlc29sdmVzLiBVc2VmdWwgaWYgeW91IGhhdmUgYW4gYXN5bmMgZnVuY3Rpb24gdGhhdCBzaG91bGRuJ3QgcnVuXG4gICAqIGFmdGVyIHRoZSBjb250ZXh0IGlzIGV4cGlyZWQuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGNvbnN0IGdldFZhbHVlRnJvbVN0b3JhZ2UgPSBhc3luYyAoKSA9PiB7XG4gICAqICAgaWYgKGN0eC5pc0ludmFsaWQpIHJldHVybiBjdHguYmxvY2soKTtcbiAgICpcbiAgICogICAvLyAuLi5cbiAgICogfVxuICAgKi9cbiAgYmxvY2soKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKCgpID0+IHtcbiAgICB9KTtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5zZXRJbnRlcnZhbGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWwgd2hlbiBpbnZhbGlkYXRlZC5cbiAgICpcbiAgICogSW50ZXJ2YWxzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2xlYXJJbnRlcnZhbGAgZnVuY3Rpb24uXG4gICAqL1xuICBzZXRJbnRlcnZhbChoYW5kbGVyLCB0aW1lb3V0KSB7XG4gICAgY29uc3QgaWQgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSBoYW5kbGVyKCk7XG4gICAgfSwgdGltZW91dCk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNsZWFySW50ZXJ2YWwoaWQpKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0VGltZW91dGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWwgd2hlbiBpbnZhbGlkYXRlZC5cbiAgICpcbiAgICogVGltZW91dHMgY2FuIGJlIGNsZWFyZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBzZXRUaW1lb3V0YCBmdW5jdGlvbi5cbiAgICovXG4gIHNldFRpbWVvdXQoaGFuZGxlciwgdGltZW91dCkge1xuICAgIGNvbnN0IGlkID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSBoYW5kbGVyKCk7XG4gICAgfSwgdGltZW91dCk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNsZWFyVGltZW91dChpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWVgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cbiAgICogaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxBbmltYXRpb25GcmFtZWAgZnVuY3Rpb24uXG4gICAqL1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoY2FsbGJhY2spIHtcbiAgICBjb25zdCBpZCA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSgoLi4uYXJncykgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgY2FsbGJhY2soLi4uYXJncyk7XG4gICAgfSk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNhbmNlbEFuaW1hdGlvbkZyYW1lKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIC8qKlxuICAgKiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnJlcXVlc3RJZGxlQ2FsbGJhY2tgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cbiAgICogaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxJZGxlQ2FsbGJhY2tgIGZ1bmN0aW9uLlxuICAgKi9cbiAgcmVxdWVzdElkbGVDYWxsYmFjayhjYWxsYmFjaywgb3B0aW9ucykge1xuICAgIGNvbnN0IGlkID0gcmVxdWVzdElkbGVDYWxsYmFjaygoLi4uYXJncykgPT4ge1xuICAgICAgaWYgKCF0aGlzLnNpZ25hbC5hYm9ydGVkKSBjYWxsYmFjayguLi5hcmdzKTtcbiAgICB9LCBvcHRpb25zKTtcbiAgICB0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2FuY2VsSWRsZUNhbGxiYWNrKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIGFkZEV2ZW50TGlzdGVuZXIodGFyZ2V0LCB0eXBlLCBoYW5kbGVyLCBvcHRpb25zKSB7XG4gICAgaWYgKHR5cGUgPT09IFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpIHtcbiAgICAgIGlmICh0aGlzLmlzVmFsaWQpIHRoaXMubG9jYXRpb25XYXRjaGVyLnJ1bigpO1xuICAgIH1cbiAgICB0YXJnZXQuYWRkRXZlbnRMaXN0ZW5lcj8uKFxuICAgICAgdHlwZS5zdGFydHNXaXRoKFwid3h0OlwiKSA/IGdldFVuaXF1ZUV2ZW50TmFtZSh0eXBlKSA6IHR5cGUsXG4gICAgICBoYW5kbGVyLFxuICAgICAge1xuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgICBzaWduYWw6IHRoaXMuc2lnbmFsXG4gICAgICB9XG4gICAgKTtcbiAgfVxuICAvKipcbiAgICogQGludGVybmFsXG4gICAqIEFib3J0IHRoZSBhYm9ydCBjb250cm9sbGVyIGFuZCBleGVjdXRlIGFsbCBgb25JbnZhbGlkYXRlZGAgbGlzdGVuZXJzLlxuICAgKi9cbiAgbm90aWZ5SW52YWxpZGF0ZWQoKSB7XG4gICAgdGhpcy5hYm9ydChcIkNvbnRlbnQgc2NyaXB0IGNvbnRleHQgaW52YWxpZGF0ZWRcIik7XG4gICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgYENvbnRlbnQgc2NyaXB0IFwiJHt0aGlzLmNvbnRlbnRTY3JpcHROYW1lfVwiIGNvbnRleHQgaW52YWxpZGF0ZWRgXG4gICAgKTtcbiAgfVxuICBzdG9wT2xkU2NyaXB0cygpIHtcbiAgICB3aW5kb3cucG9zdE1lc3NhZ2UoXG4gICAgICB7XG4gICAgICAgIHR5cGU6IENvbnRlbnRTY3JpcHRDb250ZXh0LlNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSxcbiAgICAgICAgY29udGVudFNjcmlwdE5hbWU6IHRoaXMuY29udGVudFNjcmlwdE5hbWUsXG4gICAgICAgIG1lc3NhZ2VJZDogTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMilcbiAgICAgIH0sXG4gICAgICBcIipcIlxuICAgICk7XG4gIH1cbiAgdmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSB7XG4gICAgY29uc3QgaXNTY3JpcHRTdGFydGVkRXZlbnQgPSBldmVudC5kYXRhPy50eXBlID09PSBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEU7XG4gICAgY29uc3QgaXNTYW1lQ29udGVudFNjcmlwdCA9IGV2ZW50LmRhdGE/LmNvbnRlbnRTY3JpcHROYW1lID09PSB0aGlzLmNvbnRlbnRTY3JpcHROYW1lO1xuICAgIGNvbnN0IGlzTm90RHVwbGljYXRlID0gIXRoaXMucmVjZWl2ZWRNZXNzYWdlSWRzLmhhcyhldmVudC5kYXRhPy5tZXNzYWdlSWQpO1xuICAgIHJldHVybiBpc1NjcmlwdFN0YXJ0ZWRFdmVudCAmJiBpc1NhbWVDb250ZW50U2NyaXB0ICYmIGlzTm90RHVwbGljYXRlO1xuICB9XG4gIGxpc3RlbkZvck5ld2VyU2NyaXB0cyhvcHRpb25zKSB7XG4gICAgbGV0IGlzRmlyc3QgPSB0cnVlO1xuICAgIGNvbnN0IGNiID0gKGV2ZW50KSA9PiB7XG4gICAgICBpZiAodGhpcy52ZXJpZnlTY3JpcHRTdGFydGVkRXZlbnQoZXZlbnQpKSB7XG4gICAgICAgIHRoaXMucmVjZWl2ZWRNZXNzYWdlSWRzLmFkZChldmVudC5kYXRhLm1lc3NhZ2VJZCk7XG4gICAgICAgIGNvbnN0IHdhc0ZpcnN0ID0gaXNGaXJzdDtcbiAgICAgICAgaXNGaXJzdCA9IGZhbHNlO1xuICAgICAgICBpZiAod2FzRmlyc3QgJiYgb3B0aW9ucz8uaWdub3JlRmlyc3RFdmVudCkgcmV0dXJuO1xuICAgICAgICB0aGlzLm5vdGlmeUludmFsaWRhdGVkKCk7XG4gICAgICB9XG4gICAgfTtcbiAgICBhZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYik7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IHJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIGNiKSk7XG4gIH1cbn1cbiJdLCJuYW1lcyI6WyJkZWZpbml0aW9uIiwiYnJvd3NlciIsIl9icm93c2VyIiwicHJpbnQiLCJsb2dnZXIiXSwibWFwcGluZ3MiOiI7O0FBQU8sV0FBUyxvQkFBb0JBLGFBQVk7QUFDOUMsV0FBT0E7QUFBQSxFQUNUO0FDRE8sUUFBTUMsWUFBVSxXQUFXLFNBQVMsU0FBUyxLQUNoRCxXQUFXLFVBQ1gsV0FBVztBQ0ZSLFFBQU0sVUFBVUM7QUNEaEIsUUFBTSxvQkFBb0I7QUNPakMsUUFBQSxXQUFBO0FBQ0EsUUFBQSxXQUFBO0FBQ0EsUUFBQSxnQkFBQTtBQUNBLFFBQUEseUJBQUE7QUFDQSxRQUFBLDhCQUFBO0FBQ0EsUUFBQSw0QkFBQTtBQUNBLFFBQUEsNkJBQUE7QUFDQSxRQUFBLHlCQUFBO0FBQ0EsUUFBQSw4QkFBQTtBQUNBLFFBQUEsZ0NBQUE7QUFDQSxRQUFBLDZCQUFBO0FBQ0EsUUFBQSw0QkFBQTtBQUNBLFFBQUEsYUFBQSxLQUFBLEtBQUEsS0FBQTtBQU9BLFFBQUEsYUFBQSxvQkFBQTtBQUFBLElBQW1DLFNBQUEsQ0FBQSxxQkFBQTtBQUFBLElBQ0gsT0FBQTtBQUU5QixVQUFBLGNBQUE7QUFDQSxVQUFBLDRCQUFBO0FBQ0EsVUFBQTtBQU9BLFVBQUEsa0JBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUE7QUFDQSxVQUFBO0FBQ0EsVUFBQSwwQkFBQTtBQUNBLFVBQUEsV0FBQTtBQUVBLG9CQUFBO0FBQ0EsZ0NBQUEsS0FBQTtBQUNBLHdCQUFBO0FBQ0EsK0JBQUE7QUFDQSwyQkFBQTtBQUNBLDBC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L0MsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLGlCQUFpQixRQUFRLE1BQU0sU0FBUyxTQUFTO0FBQy9DLFVBQUksU0FBUyxzQkFBc0I7QUFDakMsWUFBSSxLQUFLLFFBQVMsTUFBSyxnQkFBZ0IsSUFBRztBQUFBLE1BQzVDO0FBQ0EsYUFBTztBQUFBLFFBQ0wsS0FBSyxXQUFXLE1BQU0sSUFBSSxtQkFBbUIsSUFBSSxJQUFJO0FBQUEsUUFDckQ7QUFBQSxRQUNBO0FBQUEsVUFDRSxHQUFHO0FBQUEsVUFDSCxRQUFRLEtBQUs7QUFBQSxRQUNyQjtBQUFBLE1BQ0E7QUFBQSxJQUNFO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtBLG9CQUFvQjtBQUNsQixXQUFLLE1BQU0sb0NBQW9DO0FBQy9DQyxlQUFPO0FBQUEsUUFDTCxtQkFBbUIsS0FBSyxpQkFBaUI7QUFBQSxNQUMvQztBQUFBLElBQ0U7QUFBQSxJQUNBLGlCQUFpQjtBQUNmLGFBQU87QUFBQSxRQUNMO0FBQUEsVUFDRSxNQUFNLHFCQUFxQjtBQUFBLFVBQzNCLG1CQUFtQixLQUFLO0FBQUEsVUFDeEIsV0FBVyxLQUFLLE9BQU0sRUFBRyxTQUFTLEVBQUUsRUFBRSxNQUFNLENBQUM7QUFBQSxRQUNyRDtBQUFBLFFBQ007QUFBQSxNQUNOO0FBQUEsSUFDRTtBQUFBLElBQ0EseUJBQXlCLE9BQU87QUFDOUIsWUFBTSx1QkFBdUIsTUFBTSxNQUFNLFNBQVMscUJBQXFCO0FBQ3ZFLFlBQU0sc0JBQXNCLE1BQU0sTUFBTSxzQkFBc0IsS0FBSztBQUNuRSxZQUFNLGlCQUFpQixDQUFDLEtBQUssbUJBQW1CLElBQUksTUFBTSxNQUFNLFNBQVM7QUFDekUsYUFBTyx3QkFBd0IsdUJBQXVCO0FBQUEsSUFDeEQ7QUFBQSxJQUNBLHNCQUFzQixTQUFTO0FBQzdCLFVBQUksVUFBVTtBQUNkLFlBQU0sS0FBSyxDQUFDLFVBQVU7QUFDcEIsWUFBSSxLQUFLLHlCQUF5QixLQUFLLEdBQUc7QUFDeEMsZUFBSyxtQkFBbUIsSUFBSSxNQUFNLEtBQUssU0FBUztBQUNoRCxnQkFBTSxXQUFXO0FBQ2pCLG9CQUFVO0FBQ1YsY0FBSSxZQUFZLFNBQVMsaUJBQWtCO0FBQzNDLGVBQUssa0JBQWlCO0FBQUEsUUFDeEI7QUFBQSxNQUNGO0FBQ0EsdUJBQWlCLFdBQVcsRUFBRTtBQUM5QixXQUFLLGNBQWMsTUFBTSxvQkFBb0IsV0FBVyxFQUFFLENBQUM7QUFBQSxJQUM3RDtBQUFBLEVBQ0Y7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OzsiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMCwxLDIsNSw2LDcsOF19
content;