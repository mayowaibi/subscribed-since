import { browser } from "wxt/browser";
import {
	CACHE_STORAGE_KEY,
	type ExtensionResponse,
	type StatusResponse,
} from "../../lib/messages";

const BADGE_ID = "ss-subscribed-since";
const STYLE_ID = "ss-subscribed-since-style";
const CHANNEL_ID_RE = /UC[\w-]{20,}/;
const DOM_RENDER_DEBOUNCE_MS = 350;
const PAGE_CONTEXT_MESSAGE_SOURCE = "ss-subscribed-since";
const PAGE_CONTEXT_REQUEST_TYPE = "SS_GET_PAGE_CONTEXT_CHANNEL_ID";
const PAGE_CONTEXT_RESPONSE_TYPE = "SS_PAGE_CONTEXT_CHANNEL_ID";
const PAGE_CONTEXT_SCRIPT_ID = "ss-page-context-channel-reader";
const NAVIGATION_RENDER_WINDOW_MS = 10_000;
const NAVIGATION_RENDER_INTERVAL_MS = 500;
const NAVIGATION_SETTLE_DELAY_MS = 650;
const PAGE_WATCHDOG_INTERVAL_MS = 5000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type SubscriptionTenure = {
	value: number;
	unit: "Y" | "M" | "D";
};

export default defineContentScript({
	matches: ["*://*.youtube.com/*"],
	main() {
		let lastPageKey = "";
		let lastNoSubscriptionPageKey = "";
		let resolvedBadge:
			| {
					pageKey: string;
					tenure: SubscriptionTenure;
					dateText: string;
			  }
			| undefined;
		let renderRequestId = 0;
		let notificationObserver: MutationObserver | undefined;
		let renderTimer: ReturnType<typeof setTimeout> | undefined;
		let readinessTimer: ReturnType<typeof setTimeout> | undefined;
		let navigationRenderTimer: ReturnType<typeof setInterval> | undefined;
		let subscribeRetryTimer: ReturnType<typeof setTimeout> | undefined;
		let subscribeChangeTimer: ReturnType<typeof setTimeout> | undefined;
		let badgeRetryTimer: ReturnType<typeof setTimeout> | undefined;
		let pageWatchdogTimer: ReturnType<typeof setInterval> | undefined;
		let navigationObserver: MutationObserver | undefined;
		let readinessObserver: MutationObserver | undefined;
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
			const handleNavigation = (clearBadge: boolean) => {
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

					if (
						!badge ||
						!channelId ||
						badge.dataset.ssChannelId !== channelId ||
						badge.dataset.ssHref !== location.href ||
						!findBadgeTarget(false)
					) {
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
				if (
					!hasConfirmedNoSubscriptionForCurrentHref() &&
					(!badge || badge.dataset.ssHref !== location.href || !findBadgeTarget(false))
				) {
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
					resolvedBadge = undefined;
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
				subscribeRetryTimer = setTimeout(observeSubscribeButtonChanges, 1000);
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
				resolvedBadge = undefined;
				void sendRuntimeMessage({
					type: "SS_VISIBLE_SUBSCRIPTION_CHANGED",
				});
				subscribeChangeTimer = setTimeout(scheduleRender, 3500);
			});

			notificationObserver.observe(target, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
				attributeFilter: ["aria-label", "title"],
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

		function startNavigationRenderLoop(clearBadge: boolean) {
			if (!isActive) {
				return;
			}

			lastPageKey = "";
			lastNoSubscriptionPageKey = "";
			resolvedBadge = undefined;
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
						navigationRenderTimer = undefined;
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

				if (
					lastPageKey === pageKey &&
					existingBadge?.dataset.ssPageKey === pageKey &&
					existingBadge.dataset.ssHref === location.href
				) {
					return;
				}

				lastPageKey = pageKey;

				if (resolvedBadge?.pageKey === pageKey) {
					insertBadge({
						channelId,
						tenure: resolvedBadge.tenure,
						dateText: resolvedBadge.dateText,
						pageKey,
					});
					return;
				}

				if (lastNoSubscriptionPageKey === pageKey) {
					return;
				}

				const response = await sendRuntimeMessage({
					type: "SS_GET_STATUS",
					channelId,
				});

				if (!response || requestId !== renderRequestId || !isActive) {
					return;
				}

				if (!isStatusResponse(response) || !response.ok || !response.subscription) {
					lastNoSubscriptionPageKey = pageKey;
					resolvedBadge = undefined;
					removeBadge();
					return;
				}

				lastNoSubscriptionPageKey = "";
				resolvedBadge = {
					pageKey,
					tenure: getSubscriptionTenure(response.subscription.subscribedAt),
					dateText: formatDate(response.subscription.subscribedAt),
				};
				insertBadge({
					channelId,
					tenure: resolvedBadge.tenure,
					dateText: resolvedBadge.dateText,
					pageKey,
				});
			} catch (error) {
				handleExtensionError(error);
			}
		}

		function insertBadge({
			channelId,
			tenure,
			dateText,
			pageKey,
		}: {
			channelId: string;
			tenure: SubscriptionTenure;
			dateText: string;
			pageKey: string;
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
				existing.querySelector("[data-ss-tenure]")!.textContent =
					formatTenureMark(tenure);
				existing.querySelector("[data-ss-date]")!.textContent = dateText;
				return;
			}

			removeBadge();
			target.appendChild(createBadge({ channelId, tenure, dateText, pageKey }));
		}

		async function sendRuntimeMessage(message: unknown) {
			if (!isActive) {
				return;
			}

			try {
				return (await browser.runtime.sendMessage(message)) as ExtensionResponse;
			} catch (error) {
				handleExtensionError(error);
			}
		}

		function handleExtensionError(error: unknown) {
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
	},
});

function isSupportedYouTubePage() {
	return isChannelPage();
}

function isChannelPage(path = location.pathname) {
	return (
		path.startsWith("/@") ||
		path.startsWith("/channel/") ||
		path.startsWith("/c/") ||
		path.startsWith("/user/")
	);
}

async function findCurrentChannelId() {
	const path = location.pathname;
	const pathChannelId = matchChannelId(path);
	if (pathChannelId) {
		return pathChannelId;
	}

	if (!isChannelPage(path)) {
		return undefined;
	}

	return (
		(await findCurrentChannelIdFromPageContext()) ?? findCurrentChannelIdFromDom()
	);
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
		"link[itemprop='url']",
	];

	for (const selector of channelSelectors) {
		const element = document.querySelector(selector);
		const value =
			element?.getAttribute("content") ??
			element?.getAttribute("href") ??
			element?.textContent;
		const channelId = matchChannelId(value);
		if (channelId) {
			return channelId;
		}
	}

	const browse = document.querySelector("ytd-browse[page-subtype='channels']");
	const headerChannelId = matchChannelId(
		browse
			?.querySelector(
				"ytd-page-header-renderer, yt-page-header-view-model, ytd-c4-tabbed-header-renderer, #channel-header, #page-header"
			)
			?.innerHTML
	);
	if (headerChannelId) {
		return headerChannelId;
	}
}

function matchChannelId(value?: string | null) {
	return value?.match(CHANNEL_ID_RE)?.[0];
}

function findCurrentChannelIdFromPageContext() {
	const requestId = crypto.randomUUID();

	return new Promise<string | undefined>((resolve) => {
		injectPageContextChannelIdReader();

		const timeout = setTimeout(() => {
			window.removeEventListener("message", onMessage);
			resolve(undefined);
		}, 300);

		function onMessage(event: MessageEvent) {
			if (event.source !== window) {
				return;
			}

			const data = event.data as
				| {
						source?: string;
						type?: string;
						requestId?: string;
						channelId?: string;
				  }
				| undefined;

			if (
				data?.source !== PAGE_CONTEXT_MESSAGE_SOURCE ||
				data.type !== PAGE_CONTEXT_RESPONSE_TYPE ||
				data.requestId !== requestId
			) {
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
				requestId,
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

function isExtensionContextInvalidatedError(error: unknown) {
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
		"ytd-browse[page-subtype='channels'] #page-header #buttons",
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
	const target =
		subscribeSurface?.closest<HTMLElement>(
			"yt-flexible-actions-view-model, #buttons, #subscribe-button"
		) ??
		subscribeSurface?.parentElement ??
		undefined;

	if (target && markHost) {
		target.classList.add("ss-badge-host");
	}

	return target;
}

function createBadge({
	channelId,
	tenure,
	dateText,
	pageKey,
}: {
	channelId: string;
	tenure: SubscriptionTenure;
	dateText: string;
	pageKey: string;
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

function getSubscriptionTenure(value: string): SubscriptionTenure {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return { value: 0, unit: "D" };
	}

	const now = new Date();
	let years = now.getFullYear() - date.getFullYear();
	if (now < getShiftedDate(date, years, "year")) {
		years -= 1;
	}
	if (years >= 1) {
		return { value: years, unit: "Y" };
	}

	let months =
		(now.getFullYear() - date.getFullYear()) * 12 +
		now.getMonth() -
		date.getMonth();
	if (now < getShiftedDate(date, months, "month")) {
		months -= 1;
	}
	if (months >= 1) {
		return { value: months, unit: "M" };
	}

	const days = Math.max(0, Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY));
	return { value: days, unit: "D" };
}

function getShiftedDate(date: Date, amount: number, unit: "year" | "month") {
	const shifted = new Date(date);
	if (unit === "year") {
		shifted.setFullYear(date.getFullYear() + amount);
	} else {
		shifted.setMonth(date.getMonth() + amount);
	}
	return shifted;
}

function formatTenureMark(tenure: SubscriptionTenure) {
	return `${tenure.value}${tenure.unit}`;
}

function formatTenure(tenure: SubscriptionTenure) {
	const unit =
		tenure.unit === "Y" ? "year" : tenure.unit === "M" ? "month" : "day";
	return `${tenure.value} ${unit}${tenure.value === 1 ? "" : "s"}`;
}

function formatDate(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return new Intl.DateTimeFormat(undefined, {
		month: "long",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

function getSubscribeSurfaceText() {
	const target = findSubscribeSurface();

	return [
		target?.textContent,
		target?.getAttribute("aria-label"),
		target?.getAttribute("title"),
	]
		.filter(Boolean)
		.join(" ")
		.trim();
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
		"ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribed']",
	];

	for (const selector of channelSelectors) {
		const element = document.querySelector(selector);
		if (element instanceof HTMLElement) {
			return element;
		}
	}
}

function isStatusResponse(response: ExtensionResponse): response is StatusResponse {
	return "authStatus" in response;
}
