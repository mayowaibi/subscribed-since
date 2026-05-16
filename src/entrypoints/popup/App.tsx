import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { ExtensionResponse, PublicState, StateResponse } from "../../lib/messages";

const initialState: PublicState = {
	authStatus: "signed_out",
	subscriptionCount: 0,
};

function App() {
	const [state, setState] = useState<PublicState>(initialState);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	useEffect(() => {
		void loadState();
	}, []);

	async function loadState() {
		const response = (await browser.runtime.sendMessage({
			type: "SS_GET_STATE",
		})) as ExtensionResponse;
		applyStateResponse(response);
	}

	async function signIn() {
		await runAction("Signing in...", {
			type: "SS_SIGN_IN",
		});
	}

	async function refresh() {
		await runAction("Refreshing subscriptions...", {
			type: "SS_REFRESH_ALL",
			interactive: true,
		});
	}

	async function signOut() {
		await runAction("Signing out...", {
			type: "SS_SIGN_OUT",
		});
	}

	async function runAction(
		workingMessage: string,
		request: Record<string, unknown>
	) {
		setBusy(true);
		setMessage(workingMessage);
		try {
			const response = (await browser.runtime.sendMessage(
				request
			)) as ExtensionResponse;
			applyStateResponse(response);
			setMessage(response.ok ? "Done." : getResponseError(response));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	function applyStateResponse(response: ExtensionResponse) {
		if (isStateResponse(response)) {
			setState(response.state);
			if (!response.ok) {
				setMessage(response.error);
			}
		}
	}

	return (
		<main className="popup-shell">
			<header className="popup-header">
				<div className="app-mark">Y</div>
				<div>
					<h1>Subscribed Since</h1>
					<p>Shows your years subscribed beside YouTube channel controls.</p>
				</div>
			</header>

			<section className="status-panel" data-status={state.authStatus}>
				<div>
					<span className="eyebrow">Status</span>
					<strong>{getStatusLabel(state.authStatus)}</strong>
				</div>
				<div>
					<span className="eyebrow">Cached channels</span>
					<strong>{state.subscriptionCount.toLocaleString()}</strong>
				</div>
			</section>

			{state.lastFullSyncAt ? (
				<p className="sync-copy">Last synced {formatSyncDate(state.lastFullSyncAt)}</p>
			) : (
				<p className="sync-copy">Sign in to sync your YouTube subscriptions.</p>
			)}

			{state.lastError ? <p className="error-copy">{state.lastError}</p> : null}
			{message ? <p className="message-copy">{message}</p> : null}

			<div className="actions">
				{state.authStatus === "signed_in" || state.authStatus === "error" ? (
					<>
						<button className="primary" disabled={busy} onClick={refresh}>
							{busy ? "Working..." : "Refresh"}
						</button>
						<button disabled={busy} onClick={signOut}>
							Sign out
						</button>
					</>
				) : (
					<button className="primary" disabled={busy} onClick={signIn}>
						{busy ? "Opening Google..." : "Sign in with Google"}
					</button>
				)}
			</div>

			<p className="permission-copy">
				Uses read-only YouTube access and stores subscription dates locally in
				Chrome.
			</p>
		</main>
	);
}

function isStateResponse(response: ExtensionResponse): response is StateResponse {
	return "state" in response;
}

function getResponseError(response: ExtensionResponse) {
	if ("error" in response) {
		return response.error;
	}

	return "Something went wrong.";
}

function getStatusLabel(status: PublicState["authStatus"]) {
	if (status === "signed_in") {
		return "Signed in";
	}

	if (status === "error") {
		return "Needs attention";
	}

	return "Signed out";
}

function formatSyncDate(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

export default App;
