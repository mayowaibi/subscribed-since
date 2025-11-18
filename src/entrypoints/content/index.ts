export default defineContentScript({
	matches: ["*://*.youtube.com/*"],
	main() {
		function isYouTubeVideoUrl(url: string) {
			try {
				const u = new URL(url);
				const host = u.hostname.toLowerCase();

				// Canonical YouTube video page: /watch?v=VIDEO_ID
				if (host.endsWith("youtube.com")) {
					return u.pathname === "/watch" && u.searchParams.has("v");
				}

				// Short youtu.be links: https://youtu.be/VIDEO_ID
				if (host === "youtu.be") {
					return u.pathname && u.pathname.length > 1; // '/VIDEO_ID'
				}

				return false;
			} catch (e) {
				return false;
			}
		}

		let lastLoggedVideoId: string = "";

		// ID used for the injected UI element. Hoisted so functions can reference it
		// even when they're called before the helper section is parsed/executed.
		const SUBSCRIBE_UI_ID = "ss-subscribed-since";

		function getVideoIdFromUrl(url: string) {
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
			// If we're on a video and it's a different video than before, inject the UI.
			if (videoId && videoId !== lastLoggedVideoId) {
				console.log(`[SS] New video detected: ${videoId}`);
				lastLoggedVideoId = videoId;
				// Insert the "Subscribed Since" UI next to the subscribe button. Retry a few
				// Insert the "Subscribed Since" UI under the owner element. Retry a few
				// times in case the owner element hasn't been rendered yet.
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

				// Try immediately, then a few times afterward.
				tryInsert();
				let retryInterval: any = 0;
				retryInterval = setInterval(tryInsert, 500);
			} else if (!videoId) {
				// Not a video page any more; remove the UI and reset state.
				if (lastLoggedVideoId)
					console.log(`[SS] navigating away from video ${lastLoggedVideoId}`);
				lastLoggedVideoId = "";
				removeSubscribedSince();
			}
		}

		// Initial check
		maybeLog();

		// YouTube is a single-page app; watch for URL changes and re-check.
		let lastHref = location.href;
		new MutationObserver(() => {
			if (location.href !== lastHref) {
				console.log(`[SS] URL changed: ${lastHref} -> ${location.href}`);
				lastHref = location.href;
				maybeLog();
			}
		}).observe(document, { subtree: true, childList: true });

		// --- UI insertion helpers ---

		function createSubscribedSinceElement(dateText: string) {
			const container = document.createElement("div");
			container.id = SUBSCRIBE_UI_ID;
			container.style.display = "flex";
			container.style.flexDirection = "row";
			container.style.alignItems = "center";
			container.style.marginTop = "12px";
			container.style.marginLeft = "-15px";
			container.style.color = "var(--yt-spec-text-primary, #000)";
			container.style.fontFamily = "Roboto, Arial, sans-serif";

			// Emoji column
			const emojiCol = document.createElement("div");
			emojiCol.style.display = "flex";
			emojiCol.style.flexDirection = "column";
			emojiCol.style.marginRight = "5px";
			emojiCol.style.fontSize = "28px";
			emojiCol.textContent = "📅";

			// Text column
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

		function insertSubscribedSince(dateText: string) {
			// Avoid duplicating
			removeSubscribedSince();

			// Find the owner element and insert right after it so the text appears
			// below the owner block (which typically contains channel name/avatar).
			const ownerEl = document.getElementById("owner");
			if (!ownerEl) {
				console.log("[SS] owner element not found");
				return false;
			}

			try {
				const el = createSubscribedSinceElement(dateText);
				ownerEl.insertAdjacentElement("afterend", el);
				console.log(
					`[SS] inserted subscribed-since element after #owner (tag=${
						ownerEl.tagName
					}, id=${ownerEl.id || "<none>"})`
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
	},
});
