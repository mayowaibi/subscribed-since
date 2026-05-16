export const CACHE_STORAGE_KEY = "ss-cache-state";

export type AuthStatus = "signed_out" | "signed_in" | "error";

export type SubscriptionRecord = {
	subscriptionId: string;
	channelId: string;
	channelTitle: string;
	subscribedAt: string;
	fetchedAt: string;
};

export type CacheState = {
	authStatus: AuthStatus;
	lastFullSyncAt?: string;
	lastError?: string;
	subscriptionsByChannelId: Record<string, SubscriptionRecord>;
};

export type PublicState = {
	authStatus: AuthStatus;
	lastFullSyncAt?: string;
	lastError?: string;
	subscriptionCount: number;
};

export type GetStatusRequest = {
	type: "SS_GET_STATUS";
	channelId: string;
};

export type RefreshAllRequest = {
	type: "SS_REFRESH_ALL";
	interactive?: boolean;
};

export type AuthRequest = {
	type: "SS_SIGN_IN" | "SS_SIGN_OUT" | "SS_GET_STATE";
};

export type VisibleSubscriptionChangedRequest = {
	type: "SS_VISIBLE_SUBSCRIPTION_CHANGED";
};

export type ExtensionRequest =
	| GetStatusRequest
	| RefreshAllRequest
	| AuthRequest
	| VisibleSubscriptionChangedRequest;

export type StatusResponse =
	| {
			ok: true;
			authStatus: AuthStatus;
			subscription?: SubscriptionRecord;
			lastFullSyncAt?: string;
			lastError?: string;
	  }
	| {
			ok: false;
			authStatus: AuthStatus;
			error: string;
			lastFullSyncAt?: string;
	  };

export type StateResponse =
	| {
			ok: true;
			state: PublicState;
	  }
	| {
			ok: false;
			state: PublicState;
			error: string;
	  };

export type ExtensionResponse = StatusResponse | StateResponse;

export function emptyCacheState(): CacheState {
	return {
		authStatus: "signed_out",
		subscriptionsByChannelId: {},
	};
}
