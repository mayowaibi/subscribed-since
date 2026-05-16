import { browser } from "wxt/browser";
import {
	CACHE_STORAGE_KEY,
	type CacheState,
	type ExtensionRequest,
	type ExtensionResponse,
	type PublicState,
	type SubscriptionRecord,
	emptyCacheState,
} from "../lib/messages";

type ChromeIdentity = {
	identity?: {
		getAuthToken: (
			details: { interactive?: boolean },
			callback: (result?: string | { token?: string }) => void
		) => void;
		removeCachedAuthToken?: (
			details: { token: string },
			callback?: () => void
		) => void;
		clearAllCachedAuthTokens?: (callback?: () => void) => void;
	};
	runtime?: {
		lastError?: { message?: string };
	};
};

type YouTubeSubscriptionListResponse = {
	nextPageToken?: string;
	items?: Array<{
		id?: string;
		snippet?: {
			publishedAt?: string;
			title?: string;
			resourceId?: {
				channelId?: string;
			};
		};
	}>;
};

const REFRESH_ALARM = "ss-refresh-subscriptions";
const REFRESH_PERIOD_MINUTES = 6 * 60;
const YOUTUBE_SUBSCRIPTIONS_URL =
	"https://www.googleapis.com/youtube/v3/subscriptions";

let refreshPromise: Promise<CacheState> | undefined;
let visibleChangeRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export default defineBackground(() => {
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
		(message: ExtensionRequest): Promise<ExtensionResponse> => {
			return handleMessage(message);
		}
	);
});

async function handleMessage(
	message: ExtensionRequest
): Promise<ExtensionResponse> {
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
					lastError: state.lastError,
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
			error: getErrorMessage(error),
		};
	}
}

async function ensureRefreshAlarm() {
	await browser.alarms.create(REFRESH_ALARM, {
		periodInMinutes: REFRESH_PERIOD_MINUTES,
	});
}

async function getFreshEnoughState(channelId: string) {
	const state = await getState();
	if (state.authStatus !== "signed_in") {
		return state;
	}

	if (!state.lastFullSyncAt) {
		return refreshAllSubscriptions(false);
	}

	const lastSync = new Date(state.lastFullSyncAt).getTime();
	const isStale = Number.isNaN(lastSync)
		? true
		: Date.now() - lastSync > REFRESH_PERIOD_MINUTES * 60 * 1000;

	if (!isStale || state.subscriptionsByChannelId[channelId]) {
		return state;
	}

	refreshAllSubscriptions(false).catch(() => undefined);
	return state;
}

async function refreshAllSubscriptions(interactive: boolean) {
	if (refreshPromise) {
		return refreshPromise;
	}

	refreshPromise = doRefreshAllSubscriptions(interactive).finally(() => {
		refreshPromise = undefined;
	});

	return refreshPromise;
}

async function doRefreshAllSubscriptions(interactive: boolean) {
	const token = await getAuthToken(interactive);
	const fetchedAt = new Date().toISOString();
	const subscriptionsByChannelId: Record<string, SubscriptionRecord> = {};
	let pageToken: string | undefined;

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
				Authorization: `Bearer ${token}`,
			},
		});

		if (response.status === 401) {
			await removeCachedToken(token);
			throw new Error("Google authorization expired. Please sign in again.");
		}

		if (!response.ok) {
			throw new Error(`YouTube API request failed (${response.status}).`);
		}

		const data = (await response.json()) as YouTubeSubscriptionListResponse;
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
				fetchedAt,
			};
		}

		pageToken = data.nextPageToken;
	} while (pageToken);

	return saveState({
		authStatus: "signed_in",
		lastFullSyncAt: fetchedAt,
		subscriptionsByChannelId,
	});
}

async function getState(): Promise<CacheState> {
	const result = await browser.storage.local.get(CACHE_STORAGE_KEY);
	return {
		...emptyCacheState(),
		...(result[CACHE_STORAGE_KEY] as Partial<CacheState> | undefined),
	};
}

async function saveState(state: CacheState): Promise<CacheState> {
	await browser.storage.local.set({ [CACHE_STORAGE_KEY]: state });
	return state;
}

async function setError(error: unknown): Promise<CacheState> {
	const state = await getState();
	return saveState({
		...state,
		authStatus: state.authStatus === "signed_in" ? "error" : "signed_out",
		lastError: getErrorMessage(error),
	});
}

function toPublicState(state: CacheState): PublicState {
	return {
		authStatus: state.authStatus,
		lastFullSyncAt: state.lastFullSyncAt,
		lastError: state.lastError,
		subscriptionCount: Object.keys(state.subscriptionsByChannelId).length,
	};
}

function scheduleVisibleChangeRefresh() {
	if (visibleChangeRefreshTimer) {
		clearTimeout(visibleChangeRefreshTimer);
	}

	visibleChangeRefreshTimer = setTimeout(() => {
		void refreshAllSubscriptions(false);
	}, 3000);
}

async function signOut() {
	const token = await getAuthToken(false).catch(() => undefined);
	if (token) {
		await removeCachedToken(token);
	}

	const chromeApi = getChromeApi();
	await new Promise<void>((resolve) => {
		chromeApi.identity?.clearAllCachedAuthTokens?.(() => resolve());
		if (!chromeApi.identity?.clearAllCachedAuthTokens) {
			resolve();
		}
	});
}

async function getAuthToken(interactive: boolean): Promise<string> {
	const chromeApi = getChromeApi();
	if (!chromeApi.identity?.getAuthToken) {
		throw new Error("Chrome identity API is unavailable.");
	}

	return new Promise((resolve, reject) => {
		chromeApi.identity?.getAuthToken({ interactive }, (result) => {
			const runtimeError = chromeApi.runtime?.lastError?.message;
			if (runtimeError) {
				reject(new Error(runtimeError));
				return;
			}

			const token = typeof result === "string" ? result : result?.token;
			if (!token) {
				reject(new Error("No Google auth token was returned."));
				return;
			}

			resolve(token);
		});
	});
}

async function removeCachedToken(token: string) {
	const chromeApi = getChromeApi();
	await new Promise<void>((resolve) => {
		chromeApi.identity?.removeCachedAuthToken?.({ token }, () => resolve());
		if (!chromeApi.identity?.removeCachedAuthToken) {
			resolve();
		}
	});
}

function getChromeApi(): ChromeIdentity {
	return (globalThis as unknown as { chrome?: ChromeIdentity }).chrome ?? {};
}

function getErrorMessage(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
