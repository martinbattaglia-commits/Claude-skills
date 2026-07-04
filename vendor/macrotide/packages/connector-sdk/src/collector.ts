// The collector that runs IN the broker tab (same-origin, with the user's
// cookies), and the userscript loader that delivers it (one-click install, posts
// straight to the authenticated ingest endpoint). Authored as placeholder strings
// so the emitted code is stable and the broker specifics are injected at run time,
// never hardcoded.
//
// The gather is SHAPE-DRIVEN: every field path it reads (account list, account
// id/name, history items + cursor, pending items, login label) comes from the
// connector's `shape.plan/history/pending`, fetched at run time and read via an
// emitted `getPath` helper — so a new broker is a manifest, not new code. Omitted
// shape parts fall back to the built-in defaults, so a manifest that only sets
// endpoints (no `shape`) keeps working.

import type { BrokerEndpoints, ConnectorShape } from "./types";

// Two version axes, two jobs (see § Versioning in the SDK README).
//
// COLLECTOR_PROTOCOL_VERSION — the gather-logic CONTRACT version. The loader
// fetches its broker config (endpoints + shape) from the app at run time, so
// endpoint/shape changes need no reinstall — but the gather ALGORITHM itself lives
// in the installed loader. Bump this ONLY when that algorithm changes in a way an
// installed loader must take on (a BREAKING change). The runtime endpoint reports
// it as `collectorVersion`; an installed loader that bakes a lower value shows the
// intrusive in-page "reinstall" nudge — the fallback for managers (e.g. Safari's
// Userscripts) that don't honor @updateURL.
export const COLLECTOR_PROTOCOL_VERSION = 4;

// SCRIPT_REVISION — the BAKED-SCRIPT content revision. Bump on ANY change to the
// installed script that ISN'T a protocol bump: badge/UI copy, a cosmetic tweak, a
// backward-compatible fix in the gather code. It moves the userscript `@version`
// (`1.<protocol>.<revision>`) so managers auto-update SILENTLY on their interval,
// WITHOUT firing the reinstall nudge (the nudge keys off protocol only). Reset to
// 0 whenever COLLECTOR_PROTOCOL_VERSION bumps. A test tripwire (sdk.test.ts) pins a
// hash of the generated script body, so editing the script without bumping one of
// these two fails CI — you can't ship a baked change unversioned.
export const SCRIPT_REVISION = 0;

// The collector-side default response shape (the reference broker the defaults
// were modeled on). The parser owns its own order/value defaults; these are only
// the bits the gather (client) reads.
const DEFAULT_COLLECTOR_SHAPE = {
  plan: {
    accountsPath: "data.accounts",
    accountCode: "agent_account_id",
    accountName: "plan_name",
    accountType: "plan_type",
    labelPaths: [
      "data.customer_name",
      "data.full_name",
      "data.name",
      "data.email",
      "data.customer.name",
      "data.customer.full_name",
      "data.customer.email",
    ],
  },
  history: {
    mode: "cursor",
    accountParam: "account_code",
    cursorParam: "current_cursor",
    itemsPath: "data",
    nextCursorPath: "pagination.next_cursor",
    hasNextPath: "pagination.has_next",
    maxPages: 200,
  },
  pending: { accountParam: "account_code", itemsPath: "data" },
  // Same-origin, cookie-authenticated (the reference broker). A connector
  // overrides these only to reach a cross-origin API or to use header auth.
  transport: { apiBase: "", credentials: "include", captureHeaders: [] as string[] },
};

/**
 * Merge the connector's transport/plan/history/pending over the built-in defaults
 * into the complete collector shape the loader reads at run time. Exported so the
 * app's `/runtime` endpoint can hand the loader a fully-resolved shape (no gaps).
 */
export function resolveCollectorShape(shape?: ConnectorShape) {
  return {
    transport: { ...DEFAULT_COLLECTOR_SHAPE.transport, ...shape?.transport },
    plan: { ...DEFAULT_COLLECTOR_SHAPE.plan, ...shape?.plan },
    history: { ...DEFAULT_COLLECTOR_SHAPE.history, ...shape?.history },
    pending: { ...DEFAULT_COLLECTOR_SHAPE.pending, ...shape?.pending },
  };
}

// Dot-path getter used by the gather to read shape-mapped fields off a response.
const COLLECTOR_GETPATH = `var GP=function(o,p){if(p==null)return undefined;var k=(""+p).split("."),i=0;for(;i<k.length&&o!=null;i++)o=o[k[i]];return o};`;

// Macrotide-branded notification cards shown ON the broker page — iOS/Android
// notification style: app icon, "Macrotide Connector" title, body below. Cards
// stack in one fixed, centered container so concurrent ones never overlap.
// `toast(m,bad)` auto-dismisses; `nudge(url)` is a persistent card with an Update
// (→ install URL) + Dismiss action. Message via textContent (no HTML injection);
// the mark mirrors components/BrandMark.tsx (ink square + teal wave).
const COLLECTOR_TOAST = `var MTMARK='<svg width="30" height="30" viewBox="0 0 22 22" style="display:block;flex-shrink:0"><rect width="22" height="22" rx="6" fill="#0a0a0b"></rect><path d="M 0 11 Q 5.5 5 11 11 T 22 11 L 22 16 A 6 6 0 0 1 16 22 L 6 22 A 6 6 0 0 1 0 16 Z" fill="#0aa694"></path></svg>';
  function card(sticky){var W=document.getElementById("__mt_toasts__");if(!W){W=document.createElement("div");W.id="__mt_toasts__";W.style.cssText="position:fixed;z-index:2147483647;left:50%;top:20px;transform:translateX(-50%);display:flex;flex-direction:column;gap:10px;align-items:center;max-width:92vw;pointer-events:none";document.body.appendChild(W)}var d=document.createElement("div");d.style.cssText="display:flex;gap:11px;align-items:flex-start;width:340px;max-width:92vw;box-sizing:border-box;padding:12px 14px;border-radius:16px;background:#fff;color:#0a0a0b;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.18);border:1px solid #e6e7ea";if(sticky)d.style.pointerEvents="auto";var ic=document.createElement("div");ic.style.cssText="flex-shrink:0;margin-top:4px";ic.innerHTML=MTMARK;var col=document.createElement("div");col.style.cssText="display:flex;flex-direction:column;gap:3px;min-width:0";var ti=document.createElement("div");ti.textContent="Macrotide Connector";ti.style.cssText="font-weight:700;font-size:13px;letter-spacing:-.01em";col.appendChild(ti);d.appendChild(ic);d.appendChild(col);W.appendChild(d);function close(){d.remove();if(!W.children.length)W.remove()}return{d:d,col:col,close:close}}
  function toast(m,bad){var k=card(false);var bo=document.createElement("div");bo.textContent=m;bo.style.cssText="font-size:12.5px;line-height:1.45;color:"+(bad?"#b00020":"#3a3d43");k.col.appendChild(bo);setTimeout(k.close,6000);return k.d}
  // A single sticky badge whose ONE line transitions across a sync: collecting →
  // (retrying) → success (auto-closes) or failure (stays, with Retry/Dismiss). So a
  // long sync never auto-vanishes, and a failure shows a clear state instead of a
  // stuck "Collecting…". set()=progress, ok()=success+auto-close, fail()=red+actions.
  function statusToast(m){var k=card(true);var bo=document.createElement("div");bo.textContent=m;bo.style.cssText="font-size:12.5px;line-height:1.45;color:#3a3d43";k.col.appendChild(bo);var act=null;function clr(){if(act){act.remove();act=null}}return{set:function(msg){clr();bo.style.color="#3a3d43";bo.textContent=msg},ok:function(msg){clr();bo.style.color="#3a3d43";bo.textContent=msg;setTimeout(k.close,5000)},fail:function(msg){clr();bo.style.color="#b00020";bo.textContent=msg;act=document.createElement("div");act.style.cssText="display:flex;gap:8px;margin-top:9px;align-items:center";var r=document.createElement("button");r.type="button";r.textContent="Retry";r.style.cssText="border:0;border-radius:6px;background:#0a0a0b;color:#f8f8f9;font:500 12.5px system-ui;padding:7px 12px;cursor:pointer";r.onclick=function(){try{location.reload()}catch(e){}};var x=document.createElement("button");x.type="button";x.textContent="Dismiss";x.style.cssText="border:0;border-radius:9px;background:transparent;color:#5f6368;font:600 12px system-ui;padding:7px 11px;cursor:pointer";x.onclick=k.close;act.appendChild(r);act.appendChild(x);k.col.appendChild(act)},remove:k.close}}
  function nudge(url){var k=card(true);var bo=document.createElement("div");bo.textContent="A newer version is available. Update it here, or from Settings → Connections.";bo.style.cssText="font-size:12.5px;line-height:1.45;color:#3a3d43";k.col.appendChild(bo);var ac=document.createElement("div");ac.style.cssText="display:flex;gap:8px;margin-top:9px;align-items:center";var u=document.createElement("button");u.type="button";u.textContent="Update";u.style.cssText="border:0;border-radius:6px;background:#0a0a0b;color:#f8f8f9;font:500 12.5px system-ui;padding:7px 12px;cursor:pointer";u.onclick=function(){try{window.open(url,"_blank")}catch(e){}};var x=document.createElement("button");x.type="button";x.textContent="Dismiss";x.style.cssText="border:0;border-radius:9px;background:transparent;color:#5f6368;font:600 12px system-ui;padding:7px 11px;cursor:pointer";x.onclick=k.close;ac.appendChild(u);ac.appendChild(x);k.col.appendChild(ac)}`;

// JSON GET via GM_xmlhttpRequest (the manager's privileged request) so the
// broker's cookies are sent reliably even where a content-script fetch wouldn't
// carry them (Safari/Userscripts isolates the userscript world). Default rides
// those cookies; a header-auth connector passes captured headers + cred "omit"
// (anonymous → no cookies). Needs the broker host in @connect.
const COLLECTOR_FETCH = `var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms)})};
  var J=function(u,hdrs,cred){return new Promise(function(res,rej){try{var o={method:"GET",url:u,headers:Object.assign({},hdrs||{}),onload:function(r){if(r.status>=200&&r.status<300){try{res(JSON.parse(r.responseText))}catch(e){rej(e)}}else rej(new Error("status "+r.status))},onerror:function(){rej(new Error("network"))},ontimeout:function(){rej(new Error("timeout"))}};if(cred==="omit")o.anonymous=true;GM_xmlhttpRequest(o)}catch(e){rej(e)}})};`;

// Header-capture (for brokers whose data API uses request-header auth the page
// holds only in memory). The auth headers live in the page's JS, NOT in any
// readable cookie/storage, so the gather has to record them off the app's OWN
// requests. The userscript runs in an isolated world whose `window.fetch` is NOT
// the page's, and Safari's Userscripts has no `unsafeWindow` to reach across — so
// instead we inject a `<script>` (page world, CSP-permitting) that wraps the page's
// REAL fetch/XHR and writes the named headers from `apiBase` calls onto a shared-DOM
// attribute. The isolated world reads that attribute back (the DOM is shared). This
// needs no `unsafeWindow`, so it works on every manager incl. Safari/Userscripts.
// `pageHook` is serialized via toString() and injected — keep it self-contained.
const COLLECTOR_CAPTURE = `var CAPH=null,HOOKED=false,CAPATTR="data-mt-caph";
  function readCap(){try{var v=document.documentElement.getAttribute(CAPATTR);if(!v)return null;var o=JSON.parse(v);for(var k in o){return o}return null}catch(e){return null}}
  function pageHook(AB,NS,AT){
    function pick(h){if(!h)return null;var o={},g=false;for(var i=0;i<NS.length;i++){var n=NS[i],v=null;if(typeof h.get==="function"){v=h.get(n)}else{for(var k in h){if((""+k).toLowerCase()===n){v=h[k];break}}}if(v!=null){o[n]=v;g=true}}return g?o:null}
    function stash(c){if(!c)return;var cur={};try{cur=JSON.parse(document.documentElement.getAttribute(AT)||"{}")}catch(e){}for(var k in c)cur[k]=c[k];document.documentElement.setAttribute(AT,JSON.stringify(cur))}
    try{var of=window.fetch;if(of)window.fetch=function(i,n){try{var u=(typeof i==="string")?i:(i&&i.url);if(u&&(""+u).indexOf(AB)===0){stash(pick(n&&n.headers));if(i&&i.headers)stash(pick(i.headers))}}catch(e){}return of.apply(this,arguments)}}catch(e){}
    try{var X=window.XMLHttpRequest,op=X&&X.prototype.open,sh=X&&X.prototype.setRequestHeader,sn=X&&X.prototype.send;if(X&&op&&sh&&sn){X.prototype.open=function(m,u){this.__u=u;this.__h={};return op.apply(this,arguments)};X.prototype.setRequestHeader=function(k,v){try{if(this.__h)this.__h[(""+k).toLowerCase()]=v}catch(e){}return sh.apply(this,arguments)};X.prototype.send=function(){try{if(this.__u&&(""+this.__u).indexOf(AB)===0)stash(pick(this.__h))}catch(e){}return sn.apply(this,arguments)}}}catch(e){}
  }
  function ensureHook(apiBase,names){
    if(HOOKED||!names||!names.length||!apiBase)return;HOOKED=true;
    var lower=names.map(function(s){return(""+s).toLowerCase()});
    try{var s=document.createElement("script");s.textContent="("+pageHook.toString()+")("+JSON.stringify(apiBase)+","+JSON.stringify(lower)+","+JSON.stringify(CAPATTR)+");";(document.head||document.documentElement||document).appendChild(s);if(s.parentNode)s.parentNode.removeChild(s)}catch(e){}
  }`;

// The gather: list portfolios, paginate every history + pending list, build the
// export object. Every broker-specific field path is read from SH (the injected
// shape) via GP. Assumes H/PLAN/HIST/PEND/SRC/SH, GP(), J() and the caller's `st`
// (the status badge) in scope. A thrown error (e.g. a broker 5xx) propagates to
// attempt()'s catch → "transient", leaving `st` for drive() to retry/fail.
const COLLECTOR_GATHER = `if(location.hostname!==H){st.fail("Log in to "+DN+" and open your portfolio or orders page to sync.");return "host"}
  var TR=SH.transport||{},APIBASE=TR.apiBase||"",CRED=TR.credentials||"include",CAPN=TR.captureHeaders||[];
  // GM_xmlhttpRequest needs ABSOLUTE urls; a same-origin (cookie) broker has no
  // apiBase, so anchor its relative paths to the page origin.
  var BASE=APIBASE||location.origin;
  if(CAPN.length){ensureHook(APIBASE,CAPN);var waited=0;while(!readCap()&&waited<15000){await sleep(250);waited+=250}CAPH=readCap();if(!CAPH){st.fail("Log in to "+DN+" and open your portfolio or orders page to sync.");return "noauth"}}
  st.set("Collecting your history…");
  var PL=SH.plan,HS=SH.history,PD=SH.pending;
  var plan=await J(BASE+PLAN,CAPH,CRED);
  var LABEL="";for(var li=0;li<PL.labelPaths.length;li++){var lv=GP(plan,PL.labelPaths[li]);if(lv){LABEL=""+lv;break}}
  var accts=(GP(plan,PL.accountsPath)||[]).map(function(a){return{account_code:GP(a,PL.accountCode),name:GP(a,PL.accountName),type:GP(a,PL.accountType)}});
  if(!accts.length){st.fail("Log in to "+DN+" and open your portfolio or orders page to sync.");return "noauth"}
  for(var i=0;i<accts.length;i++){
    var a=accts[i],hist=[];
    if(HS.mode==="dateRange"){
      var end=new Date().toISOString();
      var u=BASE+HIST+"?"+HS.accountParam+"="+encodeURIComponent(a.account_code)+"&"+HS.startParam+"="+encodeURIComponent(HS.startValue||"")+"&"+HS.endParam+"="+encodeURIComponent(end)+(HS.extraQuery?("&"+HS.extraQuery):"");
      var j=await J(u,CAPH,CRED);hist=GP(j,HS.itemsPath)||[];
    }else{
      var cur=null,g=0;
      do{var uu=BASE+HIST+"?"+HS.accountParam+"="+a.account_code+(cur?("&"+HS.cursorParam+"="+cur):"");var jj=await J(uu,CAPH,CRED);hist=hist.concat(GP(jj,HS.itemsPath)||[]);cur=GP(jj,HS.hasNextPath)?GP(jj,HS.nextCursorPath):null;g++}while(cur&&g<HS.maxPages);
    }
    if(PEND){var pj=await J(BASE+PEND+"?"+PD.accountParam+"="+a.account_code,CAPH,CRED);a.pending=GP(pj,PD.itemsPath)||[]}else{a.pending=[]}
    a.history=hist;
  }
  var n=accts.reduce(function(s,a){return s+a.history.length},0);
  var payload={source:SRC,exportedAt:new Date().toISOString(),accountLabel:LABEL,accounts:accts};`;

// Userscript wrapper — a THIN, SELF-UPDATING LOADER. Bakes only the app origin,
// the per-user token, and this loader's protocol version. On each broker page load
// it fetches the live broker config (endpoints + resolved shape + the current
// protocol version) from the app over GM_xmlhttpRequest (token in a header, never
// a URL), caching the last-good config so a brief app outage still syncs.
// Endpoint/shape changes apply with no reinstall; a bump of the gather ALGORITHM
// (COLLECTOR_PROTOCOL_VERSION) nudges a reinstall.
//
// Retries are OUTCOME-DRIVEN, so a failure never causes a long dead zone:
//   • The 5-min throttle is stamped ONLY after a successful sync — so a
//     not-logged-in attempt leaves no throttle, and the next page load (right
//     after you log in and get redirected) syncs immediately.
//   • Transient errors (broker API / app unreachable) retry in-page with jittered
//     exponential backoff, then stop and let the next page load try.
//   • A short attempt-dedupe collapses rapid in-site navigations (and the toast).
const USERSCRIPT_TEMPLATE = `(function(){
  ${COLLECTOR_GETPATH}
  var T=__TOKEN__,O=__ORIGIN__,LV=__LOADER_VERSION__,SKEY="__macrotide_last_sync__",AKEY="__macrotide_last_try__",NKEY="__macrotide_nag__",CFGKEY="__macrotide_cfg__",MIN=300000,DEDUPE=4000,NAGMIN=86400000;
  ${COLLECTOR_TOAST}
  ${COLLECTOR_FETCH}
  ${COLLECTOR_CAPTURE}
  function cfg(){return new Promise(function(res,rej){try{GM_xmlhttpRequest({method:"GET",url:O+"/api/import/broker/runtime?host="+encodeURIComponent(location.hostname),headers:{"X-Import-Token":T},onload:function(r){if(r.status>=200&&r.status<300){try{res(JSON.parse(r.responseText))}catch(e){rej(e)}}else rej(new Error("status "+r.status))},onerror:function(){rej(new Error("network"))},ontimeout:function(){rej(new Error("timeout"))}})}catch(e){rej(e)}})}
  function send(s){return new Promise(function(res){try{GM_xmlhttpRequest({method:"POST",url:O+"/api/import/broker/ingest",headers:{"Content-Type":"application/json","X-Import-Token":T},data:s,onload:function(r){res(r.status>=200&&r.status<300)},onerror:function(){res(false)},ontimeout:function(){res(false)}})}catch(e){res(false)}})}
  // One collection attempt against resolved config C, driving the status badge st.
  // Returns: ok | noauth (not logged in) | host (wrong page) | transient (retry).
  // Terminal states (noauth/host/ok) finalize st here; a transient leaves st
  // mid-flight for drive() to turn into a retry or a failure.
  async function attempt(C,st){
    try{
      var H=C.host,DN=C.displayName||C.host,PLAN=C.planPath,HIST=C.historyPath,PEND=C.pendingPath,SRC=C.source,SH=C.shape;
      ${COLLECTOR_GATHER}
      var ok=await send(JSON.stringify(payload));
      if(ok){st.ok(n?("Synced "+n+" orders ✓"):"You're up to date ✓");return "ok"}
      return "transient"
    }catch(e){
      return "transient"
    }
  }
  async function start(){
    var C;
    try{C=await cfg();try{localStorage.setItem(CFGKEY,JSON.stringify(C))}catch(e){}}
    catch(e){try{C=JSON.parse(localStorage.getItem(CFGKEY)||"null")}catch(e2){C=null}}
    if(!C){toast("Open Macrotide once to finish connecting your broker.",true);return}
    if(C.collectorVersion>LV){try{var ng=(localStorage.getItem(NKEY)||"").split("|");if(ng[0]!==(""+C.collectorVersion)||Date.now()-(+ng[1]||0)>NAGMIN){localStorage.setItem(NKEY,C.collectorVersion+"|"+Date.now());nudge(C.installUrl||O)}}catch(e){nudge(C.installUrl||O)}}
    // One badge for the whole run: it shows "Collecting…", survives retries, and
    // ends as a clear success or a sticky failure — never a vanished/stuck spinner.
    var st=statusToast("Collecting your history…");
    var DN=C.displayName||C.host;
    var BACKOFF=[3000,8000,20000];
    var drive=async function(i){
      var r=await attempt(C,st);
      if(r==="ok"){try{localStorage.setItem(SKEY,""+Date.now())}catch(e){}return}
      // noauth/host already left a clear failure on the badge.
      if(r!=="transient")return;
      if(i<BACKOFF.length){st.set("Couldn't sync. Retrying…");var d=Math.round(BACKOFF[i]*(0.8+0.4*Math.random()));setTimeout(function(){drive(i+1)},d);return}
      st.fail("Couldn't sync from "+DN+". It may be temporarily unavailable.");
    };
    drive(0);
  }
  // Install the capture hook synchronously from cached config — this loader runs
  // at document-start for capture brokers, so the page's first authed request is
  // seen. No-op for cookie brokers (captureHeaders empty / no cached config yet).
  try{var pc=JSON.parse(localStorage.getItem(CFGKEY)||"null");var pt=pc&&pc.shape&&pc.shape.transport;if(pt&&pt.captureHeaders&&pt.captureHeaders.length)ensureHook(pt.apiBase||"",pt.captureHeaders)}catch(e){}
  function boot(){
    try{
      var ls=+(localStorage.getItem(SKEY)||0);if(Date.now()-ls<MIN)return;
      var la=+(localStorage.getItem(AKEY)||0);if(Date.now()-la<DEDUPE)return;
      localStorage.setItem(AKEY,""+Date.now());
    }catch(e){}
    start();
  }
  // Toasts need document.body; defer the run until the DOM is ready (matters when
  // the loader runs at document-start for capture brokers).
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();`;

// The `@updateURL` (a `.meta.js` — metadata only, for the cheap version check) and
// `@downloadURL` (the full `.user.js`) a userscript manager re-fetches on its
// update interval. Both carry the per-user token in their path, so the manager's
// cookie-less background fetch authenticates (see the app's serving route). Pass
// them in — the app owns the install-URL shape, the SDK stays framework-free.
export interface UserscriptUpdateUrls {
  downloadUrl: string;
  updateUrl: string;
}

/**
 * The `// ==UserScript== … // ==/UserScript==` metadata block. Shared by the full
 * `.user.js` and the `.meta.js` (which is JUST this block, for the manager's
 * version check), so both always agree on `@version` and the rest.
 *
 * `@version` is `1.<COLLECTOR_PROTOCOL_VERSION>.<SCRIPT_REVISION>` — the protocol
 * in the minor slot, the baked-script revision in the patch slot. ANY bump of
 * either raises `@version`, so a manager that honors `@updateURL` pulls the new
 * script on its own; a `SCRIPT_REVISION`-only bump therefore propagates SILENTLY
 * (no reinstall nudge — that keys off the protocol alone). Endpoints + shape
 * resolve at run time and never move `@version`.
 */
export function buildUserscriptHeader(
  connectorOrList:
    | (BrokerEndpoints & { id?: string; shape?: ConnectorShape })
    | Array<BrokerEndpoints & { id?: string; shape?: ConnectorShape }>,
  macrotideOrigin: string,
  updateUrls?: UserscriptUpdateUrls,
): string {
  const connectors = Array.isArray(connectorOrList) ? connectorOrList : [connectorOrList];

  let originHost = macrotideOrigin;
  try {
    originHost = new URL(macrotideOrigin).hostname;
  } catch {
    // leave as-is if origin isn't a full URL (e.g. empty in tests)
  }

  // @connect = the app origin + every broker host + every broker's data-API host
  // (deduped). The gather reaches the broker over GM_xmlhttpRequest, so the broker's
  // own host must be connectable too — not just a cross-origin apiBase. A header-auth
  // broker reads a cross-origin API and captures the page's headers, so if ANY
  // connector does, the loader runs at document-start to inject the capture hook
  // before the app's first request.
  const connectHosts = new Set<string>([originHost]);
  let capture = false;
  for (const c of connectors) {
    connectHosts.add(c.host);
    const transport = c.shape?.transport;
    if (transport?.captureHeaders?.length) capture = true;
    if (transport?.apiBase) {
      try {
        connectHosts.add(new URL(transport.apiBase).hostname);
      } catch {
        // ignore malformed apiBase
      }
    }
  }

  return [
    "// ==UserScript==",
    "// @name         Macrotide Connector",
    "// @namespace    macrotide",
    `// @version      1.${COLLECTOR_PROTOCOL_VERSION}.${SCRIPT_REVISION}`,
    "// @description  Sync your broker order history into Macrotide automatically",
    ...connectors.map((c) => `// @match        https://${c.host}/*`),
    ...[...connectHosts].map((h) => `// @connect      ${h}`),
    "// @grant        GM_xmlhttpRequest",
    // Capture brokers run at document-start so the page-world header hook is in
    // place before the app's first authed request (it injects a <script>, no
    // unsafeWindow — that's what lets capture work on Safari's Userscripts).
    `// @run-at       ${capture ? "document-start" : "document-idle"}`,
    // Top frame only — never run the gather inside an embedded iframe on the
    // broker host (ad/widget/OAuth frames), which would sync redundantly.
    "// @noframes",
    ...(updateUrls
      ? [`// @downloadURL  ${updateUrls.downloadUrl}`, `// @updateURL    ${updateUrls.updateUrl}`]
      : []),
    "// ==/UserScript==",
    "",
  ].join("\n");
}

/**
 * Build the ONE global userscript (the `// ==UserScript==` text a manager
 * installs from a `.user.js` URL). A thin self-updating loader: only the app
 * `macrotideOrigin`, the per-user `token`, and this loader's protocol version are
 * baked in. It `@match`es every configured broker's host and, at run time,
 * resolves which connector applies from the page's hostname (`/runtime?host=`) —
 * so a single install covers all brokers and endpoint/shape changes need no
 * reinstall. Accepts one connector or the full list. Pass `updateUrls` to emit
 * `@downloadURL`/`@updateURL` so managers auto-update when `@version` moves (a
 * protocol or script-revision bump).
 */
export function buildUserscript(
  connectorOrList:
    | (BrokerEndpoints & { id?: string; shape?: ConnectorShape })
    | Array<BrokerEndpoints & { id?: string; shape?: ConnectorShape }>,
  macrotideOrigin: string,
  token: string,
  updateUrls?: UserscriptUpdateUrls,
): string {
  const body = USERSCRIPT_TEMPLATE.replace("__TOKEN__", JSON.stringify(token))
    .replace("__ORIGIN__", JSON.stringify(macrotideOrigin))
    .replace("__LOADER_VERSION__", JSON.stringify(COLLECTOR_PROTOCOL_VERSION));
  return buildUserscriptHeader(connectorOrList, macrotideOrigin, updateUrls) + body;
}
