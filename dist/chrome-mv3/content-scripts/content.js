var content=(function(){"use strict";function we(e){return e}const m=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,K="ss-cache-state",d="ss-subscribed-since",D="ss-subscribed-since-style",X=/UC[\w-]{20,}/,z=350,$="ss-subscribed-since",j="SS_GET_PAGE_CONTEXT_CHANNEL_ID",Q="SS_PAGE_CONTEXT_CHANNEL_ID",P="ss-page-context-channel-reader",J=1e4,Z=500,ee=1440*60*1e3,te={matches:["*://*.youtube.com/*"],main(){let e="",t="",n,r=0,a,o,b,g,_,A,M,R,L,l=!0;oe(),p(!1),fe(),he(),pe(),I();function fe(){let s=location.href;const i=c=>{l&&location.href!==s&&(s=location.href,p(c),I())};document.addEventListener("yt-navigate-start",()=>{p(!0)}),document.addEventListener("yt-navigate-finish",()=>{s=location.href,p(!0),I()}),document.addEventListener("yt-page-data-updated",()=>{p(!1)}),window.addEventListener("popstate",()=>{p(!0)}),R=new MutationObserver(()=>{i(!0)}),R.observe(document,{subtree:!0,childList:!0})}function he(){L=new MutationObserver(()=>{l&&k()&&(b&&clearTimeout(b),b=setTimeout(()=>{const s=document.getElementById(d),i=O();(!s||!i||s.dataset.ssChannelId!==i||s.dataset.ssHref!==location.href||!B(!1))&&h()},z))}),L.observe(document,{subtree:!0,childList:!0})}function pe(){m.storage.onChanged.addListener((s,i)=>{i==="local"&&K in s&&(e="",t="",n=void 0,h())})}function I(){if(!l)return;a?.disconnect();const s=C();if(!s){_=setTimeout(I,1e3);return}let i=q();a=new MutationObserver(()=>{if(!l)return;const c=q();c!==i&&(i=c,e="",t="",n=void 0,V({type:"SS_VISIBLE_SUBSCRIPTION_CHANGED"}),A=setTimeout(h,3500))}),a.observe(s,{subtree:!0,childList:!0,characterData:!0,attributes:!0,attributeFilter:["aria-label","title"]})}function h(){l&&(o&&clearTimeout(o),o=setTimeout(()=>{me()},250))}function p(s){if(!l)return;e="",t="",n=void 0,s&&y(),g&&clearInterval(g);const i=Date.now()+J;h(),g=setInterval(()=>{if(Date.now()>i){g&&(clearInterval(g),g=void 0);return}h()},Z)}async function me(){if(l)try{const s=++r,i=await ne(),c=`${location.href}|${i??"none"}`;if(!l)return;if(!k()||!i){e=c,y();return}const v=document.getElementById(d);if(e===c&&v?.dataset.ssPageKey===c&&v.dataset.ssHref===location.href)return;if(e=c,n?.pageKey===c){H({channelId:i,tenure:n.tenure,dateText:n.dateText,pageKey:c});return}if(t===c)return;const u=await V({type:"SS_GET_STATUS",channelId:i});if(!u||s!==r||!l)return;if(!le(u)||!u.ok||!u.subscription){t=c,n=void 0,y();return}t="",n={pageKey:c,tenure:ce(u.subscription.subscribedAt),dateText:de(u.subscription.subscribedAt)},H({channelId:i,tenure:n.tenure,dateText:n.dateText,pageKey:c})}catch(s){W(s)}}function H({channelId:s,tenure:i,dateText:c,pageKey:v}){if(!l)return;const u=B();if(!u){M=setTimeout(h,500);return}const f=document.getElementById(d);if(f?.parentElement===u){f.dataset.ssChannelId=s,f.dataset.ssHref=location.href,f.dataset.ssPageKey=v,f.setAttribute("aria-label",`Subscribed since ${c}, ${U(i)}`),f.querySelector("[data-ss-tenure]").textContent=G(i),f.querySelector("[data-ss-date]").textContent=c;return}y(),u.appendChild(ie({channelId:s,tenure:i,dateText:c,pageKey:v}))}async function V(s){if(l)try{return await m.runtime.sendMessage(s)}catch(i){W(i)}}function W(s){se(s)&&ye()}function ye(){l&&(l=!1,r+=1,a?.disconnect(),R?.disconnect(),L?.disconnect(),ve(),y())}function ve(){o&&clearTimeout(o),b&&clearTimeout(b),_&&clearTimeout(_),A&&clearTimeout(A),M&&clearTimeout(M),g&&clearInterval(g)}}};function k(){return F()}function F(e=location.pathname){return e.startsWith("/@")||e.startsWith("/channel/")||e.startsWith("/c/")||e.startsWith("/user/")}async function ne(){const e=location.pathname,t=w(e);if(t)return t;if(F(e))return await re()??O()}function O(){const e=["ytd-browse[page-subtype='channels'] meta[itemprop='channelId']","ytd-browse[page-subtype='channels'] ytd-page-header-renderer a[href*='/channel/']","ytd-browse[page-subtype='channels'] yt-page-header-view-model a[href*='/channel/']","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer a[href*='/channel/']","ytd-browse[page-subtype='channels'] #channel-header a[href*='/channel/']","ytd-browse[page-subtype='channels'] #page-header a[href*='/channel/']","meta[itemprop='channelId']","link[rel='canonical']","link[itemprop='url']"];for(const r of e){const a=document.querySelector(r),o=a?.getAttribute("content")??a?.getAttribute("href")??a?.textContent,b=w(o);if(b)return b}const t=document.querySelector("ytd-browse[page-subtype='channels']"),n=w(t?.querySelector("ytd-page-header-renderer, yt-page-header-view-model, ytd-c4-tabbed-header-renderer, #channel-header, #page-header")?.innerHTML);if(n)return n}function w(e){return e?.match(X)?.[0]}function re(){const e=crypto.randomUUID();return new Promise(t=>{ae();const n=setTimeout(()=>{window.removeEventListener("message",r),t(void 0)},300);function r(a){if(a.source!==window)return;const o=a.data;o?.source!==$||o.type!==Q||o.requestId!==e||(clearTimeout(n),window.removeEventListener("message",r),t(w(o.channelId)))}window.addEventListener("message",r),window.postMessage({source:$,type:j,requestId:e},window.location.origin)})}function ae(){if(document.getElementById(P))return;const e=document.createElement("script");e.id=P,e.src=m.runtime.getURL("/page-context-channel.js"),document.documentElement.appendChild(e)}function se(e){return(e instanceof Error?e.message:String(e)).toLowerCase().includes("extension context invalidated")}function B(e=!0){const t=["ytd-browse[page-subtype='channels'] ytd-page-header-renderer #buttons","ytd-browse[page-subtype='channels'] ytd-page-header-renderer yt-flexible-actions-view-model","ytd-browse[page-subtype='channels'] yt-page-header-view-model yt-flexible-actions-view-model","ytd-browse[page-subtype='channels'] yt-page-header-view-model #buttons","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer #buttons","ytd-browse[page-subtype='channels'] #channel-header #buttons","ytd-browse[page-subtype='channels'] #page-header #buttons"];for(const a of t){const o=document.querySelector(a);if(o instanceof HTMLElement)return e&&o.classList.add("ss-badge-host"),o}const n=C(),r=n?.closest("yt-flexible-actions-view-model, #buttons, #subscribe-button")??n?.parentElement??void 0;return r&&e&&r.classList.add("ss-badge-host"),r}function ie({channelId:e,tenure:t,dateText:n,pageKey:r}){const a=document.createElement("div");return a.id=d,a.dataset.ssChannelId=e,a.dataset.ssHref=location.href,a.dataset.ssPageKey=r,a.setAttribute("aria-label",`Subscribed since ${n}, ${U(t)}`),a.innerHTML=`
		<span class="ss-badge-mark" aria-hidden="true">
			<span class="ss-badge-tenure" data-ss-tenure>${G(t)}</span>
		</span>
		<span class="ss-badge-copy">
			<span class="ss-badge-title">SUBSCRIBED SINCE</span>
			<span class="ss-badge-date" data-ss-date>${n}</span>
		</span>
	`,a}function y(){document.getElementById(d)?.remove()}function oe(){if(document.getElementById(D))return;const e=document.createElement("style");e.id=D,e.textContent=`
		.ss-badge-host {
			display: inline-flex !important;
			align-items: center !important;
			gap: 12px !important;
			flex-wrap: wrap !important;
		}

		#${d} {
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
			--ss-badge-mark-bg: var(--yt-spec-text-primary, #fff);
			--ss-badge-mark-fg: var(--yt-spec-base-background, #0f0f0f);
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
	`,document.documentElement.appendChild(e)}function ce(e){const t=new Date(e);if(Number.isNaN(t.getTime()))return{value:0,unit:"D"};const n=new Date;let r=n.getFullYear()-t.getFullYear();if(n<Y(t,r,"year")&&(r-=1),r>=1)return{value:r,unit:"Y"};let a=(n.getFullYear()-t.getFullYear())*12+n.getMonth()-t.getMonth();return n<Y(t,a,"month")&&(a-=1),a>=1?{value:a,unit:"M"}:{value:Math.max(0,Math.floor((n.getTime()-t.getTime())/ee)),unit:"D"}}function Y(e,t,n){const r=new Date(e);return n==="year"?r.setFullYear(e.getFullYear()+t):r.setMonth(e.getMonth()+t),r}function G(e){return`${e.value}${e.unit}`}function U(e){const t=e.unit==="Y"?"year":e.unit==="M"?"month":"day";return`${e.value} ${t}${e.value===1?"":"s"}`}function de(e){const t=new Date(e);return Number.isNaN(t.getTime())?e:new Intl.DateTimeFormat(void 0,{month:"long",day:"numeric",year:"numeric"}).format(t)}function q(){const e=C();return[e?.textContent,e?.getAttribute("aria-label"),e?.getAttribute("title")].filter(Boolean).join(" ").trim()}function C(){const e=["ytd-browse[page-subtype='channels'] ytd-page-header-renderer ytd-subscribe-button-renderer","ytd-browse[page-subtype='channels'] ytd-page-header-renderer button[aria-label*='Subscribe']","ytd-browse[page-subtype='channels'] ytd-page-header-renderer button[aria-label*='Subscribed']","ytd-browse[page-subtype='channels'] yt-page-header-view-model ytd-subscribe-button-renderer","ytd-browse[page-subtype='channels'] yt-page-header-view-model button[aria-label*='Subscribe']","ytd-browse[page-subtype='channels'] yt-page-header-view-model button[aria-label*='Subscribed']","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer ytd-subscribe-button-renderer","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribe']","ytd-browse[page-subtype='channels'] ytd-c4-tabbed-header-renderer button[aria-label*='Subscribed']"];for(const t of e){const n=document.querySelector(t);if(n instanceof HTMLElement)return n}}function le(e){return"authStatus"in e}function E(e,...t){}const ue={debug:(...e)=>E(console.debug,...e),log:(...e)=>E(console.log,...e),warn:(...e)=>E(console.warn,...e),error:(...e)=>E(console.error,...e)};class x extends Event{constructor(t,n){super(x.EVENT_NAME,{}),this.newUrl=t,this.oldUrl=n}static EVENT_NAME=N("wxt:locationchange")}function N(e){return`${m?.runtime?.id}:content:${e}`}function be(e){let t,n;return{run(){t==null&&(n=new URL(location.href),t=e.setInterval(()=>{let r=new URL(location.href);r.href!==n.href&&(window.dispatchEvent(new x(r,n)),n=r)},1e3))}}}class S{constructor(t,n){this.contentScriptName=t,this.options=n,this.abortController=new AbortController,this.isTopFrame?(this.listenForNewerScripts({ignoreFirstEvent:!0}),this.stopOldScripts()):this.listenForNewerScripts()}static SCRIPT_STARTED_MESSAGE_TYPE=N("wxt:content-script-started");isTopFrame=window.self===window.top;abortController;locationWatcher=be(this);receivedMessageIds=new Set;get signal(){return this.abortController.signal}abort(t){return this.abortController.abort(t)}get isInvalid(){return m.runtime.id==null&&this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(t){return this.signal.addEventListener("abort",t),()=>this.signal.removeEventListener("abort",t)}block(){return new Promise(()=>{})}setInterval(t,n){const r=setInterval(()=>{this.isValid&&t()},n);return this.onInvalidated(()=>clearInterval(r)),r}setTimeout(t,n){const r=setTimeout(()=>{this.isValid&&t()},n);return this.onInvalidated(()=>clearTimeout(r)),r}requestAnimationFrame(t){const n=requestAnimationFrame((...r)=>{this.isValid&&t(...r)});return this.onInvalidated(()=>cancelAnimationFrame(n)),n}requestIdleCallback(t,n){const r=requestIdleCallback((...a)=>{this.signal.aborted||t(...a)},n);return this.onInvalidated(()=>cancelIdleCallback(r)),r}addEventListener(t,n,r,a){n==="wxt:locationchange"&&this.isValid&&this.locationWatcher.run(),t.addEventListener?.(n.startsWith("wxt:")?N(n):n,r,{...a,signal:this.signal})}notifyInvalidated(){this.abort("Content script context invalidated"),ue.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){window.postMessage({type:S.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:Math.random().toString(36).slice(2)},"*")}verifyScriptStartedEvent(t){const n=t.data?.type===S.SCRIPT_STARTED_MESSAGE_TYPE,r=t.data?.contentScriptName===this.contentScriptName,a=!this.receivedMessageIds.has(t.data?.messageId);return n&&r&&a}listenForNewerScripts(t){let n=!0;const r=a=>{if(this.verifyScriptStartedEvent(a)){this.receivedMessageIds.add(a.data.messageId);const o=n;if(n=!1,o&&t?.ignoreFirstEvent)return;this.notifyInvalidated()}};addEventListener("message",r),this.onInvalidated(()=>removeEventListener("message",r))}}function Se(){}function T(e,...t){}const ge={debug:(...e)=>T(console.debug,...e),log:(...e)=>T(console.log,...e),warn:(...e)=>T(console.warn,...e),error:(...e)=>T(console.error,...e)};return(async()=>{try{const{main:e,...t}=te,n=new S("content",t);return await e(n)}catch(e){throw ge.error('The content script "content" crashed on startup!',e),e}})()})();
content;