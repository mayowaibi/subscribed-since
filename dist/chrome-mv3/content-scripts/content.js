var content=(function(){"use strict";function _e(e){return e}const y=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,z="ss-cache-state",d="ss-subscribed-since",k="ss-subscribed-since-style",j=/UC[\w-]{20,}/,Q=350,O="ss-subscribed-since",J="SS_GET_PAGE_CONTEXT_CHANNEL_ID",Z="SS_PAGE_CONTEXT_CHANNEL_ID",F="ss-page-context-channel-reader",ee=1e4,te=500,ne=650,re=5e3,ae=1440*60*1e3,se={matches:["*://*.youtube.com/*"],main(){let e="",t="",n,r=0,a,c,f,g,w,D,E,R,P,$,W=0,l=!0;be(),b(!1),Ee(),ve(),we(),Te(),S();function ve(){let s=location.href;const i=o=>{l&&location.href!==s&&(s=location.href,b(o),S())};document.addEventListener("yt-navigate-start",()=>{b(!0)}),document.addEventListener("yt-navigate-finish",()=>{s=location.href,b(!0),S()}),document.addEventListener("yt-page-data-updated",()=>{b(!1)}),window.addEventListener("popstate",()=>{b(!0)}),window.addEventListener("focus",()=>{b(!1)}),document.addEventListener("visibilitychange",()=>{document.visibilityState==="visible"&&b(!1)}),P=new MutationObserver(()=>{i(!0)}),P.observe(document,{subtree:!0,childList:!0})}function we(){$=new MutationObserver(()=>{l&&_()&&(f&&clearTimeout(f),f=setTimeout(()=>{const s=document.getElementById(d),i=G();(!s||!i||s.dataset.ssChannelId!==i||s.dataset.ssHref!==location.href||!N(!1))&&h()},Q))}),$.observe(document,{subtree:!0,childList:!0})}function Ee(){let s=location.href;R=setInterval(()=>{if(!l)return;if(location.href!==s){s=location.href,b(!0),S();return}if(document.visibilityState==="hidden"||!_())return;const i=document.getElementById(d);!Se()&&(!i||i.dataset.ssHref!==location.href||!N(!1))&&h()},re)}function Se(){return t.startsWith(`${location.href}|`)}function Te(){y.storage.onChanged.addListener((s,i)=>{i==="local"&&z in s&&(e="",t="",n=void 0,h())})}function S(){if(!l)return;a?.disconnect();const s=A();if(!s){w&&clearTimeout(w),w=setTimeout(S,1e3);return}let i=q();a=new MutationObserver(()=>{if(!l)return;const o=q();o!==i&&(i=o,e="",t="",n=void 0,K({type:"SS_VISIBLE_SUBSCRIPTION_CHANGED"}),D=setTimeout(h,3500))}),a.observe(s,{subtree:!0,childList:!0,characterData:!0,attributes:!0,attributeFilter:["aria-label","title"]})}function h(s=250){if(!l)return;c&&clearTimeout(c);const i=Math.max(0,W-Date.now());c=setTimeout(()=>{Ie()},Math.max(s,i))}function b(s){if(!l)return;e="",t="",n=void 0,s&&(W=Date.now()+ne,ue()),g&&clearInterval(g);const i=Date.now()+ee;h(),g=setInterval(()=>{if(Date.now()>i){g&&(clearInterval(g),g=void 0);return}h()},te)}async function Ie(){if(l)try{const s=++r,i=await ie(),o=`${location.href}|${i??"none"}`;if(!l)return;if(!_()){e=o,v();return}const p=document.getElementById(d);if(!i){e=o,p?.dataset.ssHref!==location.href&&v();return}if(e===o&&p?.dataset.ssPageKey===o&&p.dataset.ssHref===location.href)return;if(e=o,n?.pageKey===o){V({channelId:i,tenure:n.tenure,dateText:n.dateText,pageKey:o});return}if(t===o)return;const u=await K({type:"SS_GET_STATUS",channelId:i});if(!u||s!==r||!l)return;if(!he(u)||!u.ok||!u.subscription){t=o,n=void 0,v();return}t="",n={pageKey:o,tenure:fe(u.subscription.subscribedAt),dateText:ge(u.subscription.subscribedAt)},V({channelId:i,tenure:n.tenure,dateText:n.dateText,pageKey:o})}catch(s){X(s)}}function V({channelId:s,tenure:i,dateText:o,pageKey:p}){if(!l)return;const u=N();if(!u){E&&clearTimeout(E),E=setTimeout(h,500);return}const m=document.getElementById(d);if(m?.parentElement===u){m.dataset.ssChannelId=s,m.dataset.ssHref=location.href,m.dataset.ssPageKey=p,m.setAttribute("aria-label",`Subscribed since ${o}, ${U(i)}`),m.querySelector("[data-ss-tenure]").textContent=Y(i),m.querySelector("[data-ss-date]").textContent=o;return}v(),u.appendChild(le({channelId:s,tenure:i,dateText:o,pageKey:p}))}async function K(s){if(l)try{return await y.runtime.sendMessage(s)}catch(i){X(i)}}function X(s){de(s)&&Ce()}function Ce(){l&&(l=!1,r+=1,a?.disconnect(),P?.disconnect(),$?.disconnect(),xe(),v())}function xe(){c&&clearTimeout(c),f&&clearTimeout(f),w&&clearTimeout(w),D&&clearTimeout(D),E&&clearTimeout(E),g&&clearInterval(g),R&&clearInterval(R)}}};function _(){return B()}function B(e=location.pathname){return e.startsWith("/@")||e.startsWith("/channel/")||e.startsWith("/c/")||e.startsWith("/user/")}async function ie(){const e=location.pathname,t=T(e);if(t)return t;if(B(e))return await oe()??G()}function G(){const e=["ytd-browse[page-subtype='channels'] meta[itemprop='channelId']","ytd-browse[page-subtype='channels'] ytd-page-header-renderer a[href*='/channel/']","ytd-browse[page-subtype='channels'] yt-page-header-view-model a[href*='/channel/']","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer a[href*='/channel/']","ytd-browse[page-subtype='channels'] #channel-header a[href*='/channel/']","ytd-browse[page-subtype='channels'] #page-header a[href*='/channel/']","meta[itemprop='channelId']","link[rel='canonical']","link[itemprop='url']"];for(const r of e){const a=document.querySelector(r),c=a?.getAttribute("content")??a?.getAttribute("href")??a?.textContent,f=T(c);if(f)return f}const t=document.querySelector("ytd-browse[page-subtype='channels']"),n=T(t?.querySelector("ytd-page-header-renderer, yt-page-header-view-model, ytd-c4-tabbed-header-renderer, #channel-header, #page-header")?.innerHTML);if(n)return n}function T(e){return e?.match(j)?.[0]}function oe(){const e=crypto.randomUUID();return new Promise(t=>{ce();const n=setTimeout(()=>{window.removeEventListener("message",r),t(void 0)},300);function r(a){if(a.source!==window)return;const c=a.data;c?.source!==O||c.type!==Z||c.requestId!==e||(clearTimeout(n),window.removeEventListener("message",r),t(T(c.channelId)))}window.addEventListener("message",r),window.postMessage({source:O,type:J,requestId:e},window.location.origin)})}function ce(){if(document.getElementById(F))return;const e=document.createElement("script");e.id=F,e.src=y.runtime.getURL("/page-context-channel.js"),document.documentElement.appendChild(e)}function de(e){return(e instanceof Error?e.message:String(e)).toLowerCase().includes("extension context invalidated")}function N(e=!0){const t=["ytd-browse[page-subtype='channels'] ytd-page-header-renderer #buttons","ytd-browse[page-subtype='channels'] ytd-page-header-renderer yt-flexible-actions-view-model","ytd-browse[page-subtype='channels'] yt-page-header-view-model yt-flexible-actions-view-model","ytd-browse[page-subtype='channels'] yt-page-header-view-model #buttons","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer #buttons","ytd-browse[page-subtype='channels'] #channel-header #buttons","ytd-browse[page-subtype='channels'] #page-header #buttons"];for(const a of t){const c=document.querySelector(a);if(c instanceof HTMLElement)return e&&c.classList.add("ss-badge-host"),c}const n=A(),r=n?.closest("yt-flexible-actions-view-model, #buttons, #subscribe-button")??n?.parentElement??void 0;return r&&e&&r.classList.add("ss-badge-host"),r}function le({channelId:e,tenure:t,dateText:n,pageKey:r}){const a=document.createElement("div");return a.id=d,a.dataset.ssChannelId=e,a.dataset.ssHref=location.href,a.dataset.ssPageKey=r,a.setAttribute("aria-label",`Subscribed since ${n}, ${U(t)}`),a.innerHTML=`
		<span class="ss-badge-mark" aria-hidden="true">
			<span class="ss-badge-tenure" data-ss-tenure>${Y(t)}</span>
		</span>
		<span class="ss-badge-copy">
			<span class="ss-badge-title">SUBSCRIBED SINCE</span>
			<span class="ss-badge-date" data-ss-date>${n}</span>
		</span>
	`,a}function v(){document.getElementById(d)?.remove()}function ue(){const e=document.getElementById(d);!e||e.dataset.ssHref===location.href||e.remove()}function be(){if(document.getElementById(k))return;const e=document.createElement("style");e.id=k,e.textContent=`
		.ss-badge-host {
			display: inline-flex !important;
			align-items: center !important;
			gap: 12px !important;
			flex-wrap: wrap !important;
		}

		#${d} {
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

		#${d} .ss-badge-mark {
			display: inline-grid;
			place-items: center;
			width: 24px;
			height: 24px;
			border-radius: 50%;
			background: var(--ss-badge-mark-bg);
			color: var(--ss-badge-mark-fg);
		}

		#${d} .ss-badge-tenure {
			font-size: 11px;
			font-weight: 800;
			line-height: 1;
			font-variant-numeric: tabular-nums;
		}

		#${d} .ss-badge-copy {
			display: flex;
			flex-direction: column;
			align-items: flex-start;
		}

		#${d} .ss-badge-title {
			font-size: 9px;
			font-weight: 700;
			letter-spacing: 0;
			opacity: 1;
		}

		#${d} .ss-badge-date {
			font-size: 11px;
			font-weight: 700;
			opacity: 1;
		}

		html[dark] #${d},
		[dark] #${d} {
			--ss-badge-bg: #282828;
			--ss-badge-fg: var(--yt-spec-text-primary, #fff);
			--ss-badge-mark-bg: #cf1a19;
			--ss-badge-mark-fg: #fff;
		}

		html[dark] #${d} .ss-badge-mark,
		[dark] #${d} .ss-badge-mark {
			background: var(--ss-badge-mark-bg);
			color: var(--ss-badge-mark-fg);
		}

		@media (max-width: 700px) {
			#${d} {
				margin-top: 8px;
			}
		}
	`,document.documentElement.appendChild(e)}function fe(e){const t=new Date(e);if(Number.isNaN(t.getTime()))return{value:0,unit:"D"};const n=new Date;let r=n.getFullYear()-t.getFullYear();if(n<H(t,r,"year")&&(r-=1),r>=1)return{value:r,unit:"Y"};let a=(n.getFullYear()-t.getFullYear())*12+n.getMonth()-t.getMonth();return n<H(t,a,"month")&&(a-=1),a>=1?{value:a,unit:"M"}:{value:Math.max(0,Math.floor((n.getTime()-t.getTime())/ae)),unit:"D"}}function H(e,t,n){const r=new Date(e);return n==="year"?r.setFullYear(e.getFullYear()+t):r.setMonth(e.getMonth()+t),r}function Y(e){return`${e.value}${e.unit}`}function U(e){const t=e.unit==="Y"?"year":e.unit==="M"?"month":"day";return`${e.value} ${t}${e.value===1?"":"s"}`}function ge(e){const t=new Date(e);return Number.isNaN(t.getTime())?e:new Intl.DateTimeFormat(void 0,{month:"long",day:"numeric",year:"numeric"}).format(t)}function q(){const e=A();return[e?.textContent,e?.getAttribute("aria-label"),e?.getAttribute("title")].filter(Boolean).join(" ").trim()}function A(){const e=["ytd-browse[page-subtype='channels'] ytd-page-header-renderer ytd-subscribe-button-renderer","ytd-browse[page-subtype='channels'] ytd-page-header-renderer button[aria-label*='Subscribe']","ytd-browse[page-subtype='channels'] ytd-page-header-renderer button[aria-label*='Subscribed']","ytd-browse[page-subtype='channels'] yt-page-header-view-model ytd-subscribe-button-renderer","ytd-browse[page-subtype='channels'] yt-page-header-view-model button[aria-label*='Subscribe']","ytd-browse[page-subtype='channels'] yt-page-header-view-model button[aria-label*='Subscribed']","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer ytd-subscribe-button-renderer","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribe']","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribed']"];for(const t of e){const n=document.querySelector(t);if(n instanceof HTMLElement)return n}}function he(e){return"authStatus"in e}function I(e,...t){}const me={debug:(...e)=>I(console.debug,...e),log:(...e)=>I(console.log,...e),warn:(...e)=>I(console.warn,...e),error:(...e)=>I(console.error,...e)};class M extends Event{constructor(t,n){super(M.EVENT_NAME,{}),this.newUrl=t,this.oldUrl=n}static EVENT_NAME=L("wxt:locationchange")}function L(e){return`${y?.runtime?.id}:content:${e}`}function pe(e){let t,n;return{run(){t==null&&(n=new URL(location.href),t=e.setInterval(()=>{let r=new URL(location.href);r.href!==n.href&&(window.dispatchEvent(new M(r,n)),n=r)},1e3))}}}class C{constructor(t,n){this.contentScriptName=t,this.options=n,this.abortController=new AbortController,this.isTopFrame?(this.listenForNewerScripts({ignoreFirstEvent:!0}),this.stopOldScripts()):this.listenForNewerScripts()}static SCRIPT_STARTED_MESSAGE_TYPE=L("wxt:content-script-started");isTopFrame=window.self===window.top;abortController;locationWatcher=pe(this);receivedMessageIds=new Set;get signal(){return this.abortController.signal}abort(t){return this.abortController.abort(t)}get isInvalid(){return y.runtime.id==null&&this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(t){return this.signal.addEventListener("abort",t),()=>this.signal.removeEventListener("abort",t)}block(){return new Promise(()=>{})}setInterval(t,n){const r=setInterval(()=>{this.isValid&&t()},n);return this.onInvalidated(()=>clearInterval(r)),r}setTimeout(t,n){const r=setTimeout(()=>{this.isValid&&t()},n);return this.onInvalidated(()=>clearTimeout(r)),r}requestAnimationFrame(t){const n=requestAnimationFrame((...r)=>{this.isValid&&t(...r)});return this.onInvalidated(()=>cancelAnimationFrame(n)),n}requestIdleCallback(t,n){const r=requestIdleCallback((...a)=>{this.signal.aborted||t(...a)},n);return this.onInvalidated(()=>cancelIdleCallback(r)),r}addEventListener(t,n,r,a){n==="wxt:locationchange"&&this.isValid&&this.locationWatcher.run(),t.addEventListener?.(n.startsWith("wxt:")?L(n):n,r,{...a,signal:this.signal})}notifyInvalidated(){this.abort("Content script context invalidated"),me.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){window.postMessage({type:C.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:Math.random().toString(36).slice(2)},"*")}verifyScriptStartedEvent(t){const n=t.data?.type===C.SCRIPT_STARTED_MESSAGE_TYPE,r=t.data?.contentScriptName===this.contentScriptName,a=!this.receivedMessageIds.has(t.data?.messageId);return n&&r&&a}listenForNewerScripts(t){let n=!0;const r=a=>{if(this.verifyScriptStartedEvent(a)){this.receivedMessageIds.add(a.data.messageId);const c=n;if(n=!1,c&&t?.ignoreFirstEvent)return;this.notifyInvalidated()}};addEventListener("message",r),this.onInvalidated(()=>removeEventListener("message",r))}}function Ae(){}function x(e,...t){}const ye={debug:(...e)=>x(console.debug,...e),log:(...e)=>x(console.log,...e),warn:(...e)=>x(console.warn,...e),error:(...e)=>x(console.error,...e)};return(async()=>{try{const{main:e,...t}=se,n=new C("content",t);return await e(n)}catch(e){throw ye.error('The content script "content" crashed on startup!',e),e}})()})();
content;