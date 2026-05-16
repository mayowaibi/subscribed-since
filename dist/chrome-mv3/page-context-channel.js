(() => {
	const SOURCE = "ss-subscribed-since";
	const REQUEST_TYPE = "SS_GET_PAGE_CONTEXT_CHANNEL_ID";
	const RESPONSE_TYPE = "SS_PAGE_CONTEXT_CHANNEL_ID";
	const CHANNEL_ID_RE = /^UC[\w-]{20,}$/;

	function isChannelId(value) {
		return typeof value === "string" && CHANNEL_ID_RE.test(value);
	}

	function get(value, path) {
		return path.reduce((node, key) => node && node[key], value);
	}

	function firstValid(...values) {
		return values.find(isChannelId);
	}

	function findSpecificChannelId(value, depth = 0, seen = new Set()) {
		if (!value || depth > 7 || seen.has(value) || typeof value !== "object") {
			return undefined;
		}

		seen.add(value);

		const direct = firstValid(
			value.channelId,
			value.externalId,
			value.browseId,
			get(value, ["navigationEndpoint", "browseEndpoint", "browseId"]),
			get(value, ["browseEndpoint", "browseId"]),
			get(value, ["metadata", "channelMetadataRenderer", "externalId"]),
			get(value, ["channelMetadataRenderer", "externalId"]),
			get(value, ["c4TabbedHeaderRenderer", "channelId"]),
			get(value, ["pageHeaderRenderer", "metadata", "channelMetadataRenderer", "externalId"])
		);

		if (direct) {
			return direct;
		}

		for (const child of Object.values(value)) {
			const channelId = findSpecificChannelId(child, depth + 1, seen);
			if (channelId) {
				return channelId;
			}
		}
	}

	function getCurrentChannelId() {
		const browse = document.querySelector("ytd-browse");

		return firstValid(
			get(browse, ["data", "metadata", "channelMetadataRenderer", "externalId"]),
			get(window.ytInitialData, [
				"metadata",
				"channelMetadataRenderer",
				"externalId",
			]),
			get(window.ytInitialData, ["header", "c4TabbedHeaderRenderer", "channelId"]),
			get(window.ytInitialData, [
				"header",
				"pageHeaderRenderer",
				"metadata",
				"channelMetadataRenderer",
				"externalId",
			]),
			findSpecificChannelId(window.ytInitialData)
		);
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window) {
			return;
		}

		const data = event.data;
		if (data?.source !== SOURCE || data.type !== REQUEST_TYPE) {
			return;
		}

		window.postMessage(
			{
				source: SOURCE,
				type: RESPONSE_TYPE,
				requestId: data.requestId,
				channelId: getCurrentChannelId(),
			},
			window.location.origin
		);
	});
})();
