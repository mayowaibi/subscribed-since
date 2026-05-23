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

type FirefoxAuthToken = {
	accessToken: string;
	expiresAt: number;
};

type FirefoxIdentity = {
	getRedirectURL: () => string;
	launchWebAuthFlow: (details: {
		url: string;
		interactive: boolean;
	}) => Promise<string | undefined>;
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
const YOUTUBE_READONLY_SCOPE =
	"https://www.googleapis.com/auth/youtube.readonly";
const YOUTUBE_SUBSCRIPTIONS_URL =
	"https://www.googleapis.com/youtube/v3/subscriptions";
const FIREFOX_AUTH_TOKEN_STORAGE_KEY = "ss-firefox-google-auth-token";
const FIREFOX_AUTH_EXPIRY_BUFFER_MS = 60 * 1000;
const FIREFOX_GOOGLE_OAUTH_CLIENT_ID =
	import.meta.env.WXT_FIREFOX_GOOGLE_OAUTH_CLIENT_ID?.trim() ??
	"1082059658861-gjtntrgqnpaes4huds46rgrq4a7hm8df.apps.googleusercontent.com";

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

	await collectSubscriptionPages({
		token,
		fetchedAt,
		subscriptionsByChannelId,
	});

	return saveState({
		authStatus: "signed_in",
		lastFullSyncAt: fetchedAt,
		subscriptionsByChannelId,
	});
}

async function collectSubscriptionPages({
	token,
	fetchedAt,
	subscriptionsByChannelId,
	pageToken,
}: {
	token: string;
	fetchedAt: string;
	subscriptionsByChannelId: Record<string, SubscriptionRecord>;
	pageToken?: string;
}): Promise<void> {
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

	if (data.nextPageToken) {
		await collectSubscriptionPages({
			token,
			fetchedAt,
			subscriptionsByChannelId,
			pageToken: data.nextPageToken,
		});
	}
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
	if (import.meta.env.FIREFOX) {
		await browser.storage.local.remove(FIREFOX_AUTH_TOKEN_STORAGE_KEY);
		return;
	}

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
	if (import.meta.env.FIREFOX) {
		return getFirefoxAuthToken(interactive);
	}

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

async function getFirefoxAuthToken(interactive: boolean): Promise<string> {
	const storedToken = await getStoredFirefoxAuthToken();
	if (
		storedToken &&
		storedToken.expiresAt > Date.now() + FIREFOX_AUTH_EXPIRY_BUFFER_MS
	) {
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

	let redirectResponse: string | undefined;
	try {
		redirectResponse = await getFirefoxIdentity().launchWebAuthFlow({
			url: authorizationUrl.toString(),
			interactive,
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
	const expiresAt =
		Date.now() +
		(Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;
	await browser.storage.local.set({
		[FIREFOX_AUTH_TOKEN_STORAGE_KEY]: { accessToken, expiresAt },
	});

	return accessToken;
}

async function getStoredFirefoxAuthToken(): Promise<FirefoxAuthToken | undefined> {
	const result = await browser.storage.local.get(FIREFOX_AUTH_TOKEN_STORAGE_KEY);
	const token = result[FIREFOX_AUTH_TOKEN_STORAGE_KEY] as
		| Partial<FirefoxAuthToken>
		| undefined;
	if (
		typeof token?.accessToken !== "string" ||
		typeof token.expiresAt !== "number"
	) {
		return;
	}

	return {
		accessToken: token.accessToken,
		expiresAt: token.expiresAt,
	};
}

function getFirefoxOAuthRedirectUri() {
	const redirectUrl = new URL(getFirefoxIdentity().getRedirectURL());
	const redirectSubdomain = redirectUrl.hostname.split(".")[0];
	return `http://127.0.0.1/mozoauth2/${redirectSubdomain}`;
}

function getFirefoxIdentity() {
	return browser.identity as unknown as FirefoxIdentity;
}

async function removeCachedToken(token: string) {
	if (import.meta.env.FIREFOX) {
		const storedToken = await getStoredFirefoxAuthToken();
		if (storedToken?.accessToken === token) {
			await browser.storage.local.remove(FIREFOX_AUTH_TOKEN_STORAGE_KEY);
		}
		return;
	}

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
