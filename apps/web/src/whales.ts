/**
 * Pure HTML renderer for the public /whales directory page.
 *
 * Style + nav + footer mirror the landing page so the surface feels like
 * one product. Whale cards are statically rendered from a {@link WhaleSnapshot}
 * built at deploy time (good for SEO + first paint), then a small client
 * script makes the volatile numbers genuinely live: it pulls each whale's
 * `clearinghouseState` straight from Hyperliquid's CORS-open `/info`
 * endpoint every 30s, so open positions, unrealized PnL, account equity,
 * and the headline 30d PnL update per-visitor instead of going stale
 * between deploys.
 *
 * The renderer is pure (no I/O). Tests assert the embedded data + escaping.
 */
import { BUILDER_FEE_DEFAULT_TENTHS_BP } from '@whalepod/sdk';
import { escapeHtml } from './landing.js';
import { whaleSlug, type CuratedWhale, type WhaleSpecialty } from './whalesData.js';
import type { HlOpenPosition } from './hlFetch.js';

export interface WhaleSnapshot {
  readonly meta: CuratedWhale;
  readonly equityUsd: number | null;
  readonly positions: readonly HlOpenPosition[];
  readonly allTimeUsd: number | null;
  readonly thirtyDayUsd: number | null;
  readonly sevenDayUsd: number | null;
  readonly fillCount: number | null;
  /** Unix ms — when this whale's HL data was fetched at build time. */
  readonly fetchedAt: number;
  /** True if the HL fetch failed for this whale; card renders with em-dashes. */
  readonly stale: boolean;
}

export interface WhalesPageEnv {
  readonly botUrl: string;
  readonly snapshots: readonly WhaleSnapshot[];
  /** Unix ms when this page was generated. Drives "Updated 23s ago" client-side. */
  readonly generatedAt: number;
}

const X_URL = 'https://x.com/whalepodapp';
const TG_CHANNEL = 'https://t.me/whalepod_news';
const TG_GROUP = 'https://t.me/whalepod_chat';
const APP_URL = 'https://app.whalepod.trade';
const GH_URL = 'https://github.com/Tonyflam/U';
const HYPURRSCAN_BASE = 'https://hypurrscan.io/address';

const SPECIALTY_COLOR: Readonly<Record<WhaleSpecialty, string>> = {
  HYPE: '#3bd5b5',
  BTC: '#f7931a',
  ETH: '#8b9eff',
  BNB: '#f3ba2f',
  Spot: '#a78bfa',
  Multi: '#6366f1',
  Diversified: '#06b6d4',
};

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
html,body{margin:0;padding:0;background:#070910;color:#e6edf3;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
:root{--bg:#070910;--fg:#e6edf3;--accent:#3bd5b5;--accent2:#6366f1;--muted:#8b949e;--card:rgba(22,27,34,.6);--card-border:#1e2530;--good:#3bd5b5;--bad:#ef4444}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.mono{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-variant-numeric:tabular-nums}

.cursor-glow{position:fixed;top:0;left:0;width:600px;height:600px;border-radius:50%;background:radial-gradient(closest-side,rgba(59,213,181,.14),transparent);transform:translate(-50%,-50%);pointer-events:none;z-index:0;transition:opacity .3s;mix-blend-mode:screen;will-change:transform}
@media(hover:none){.cursor-glow{display:none}}

/* ── nav ── */
.nav{position:sticky;top:0;z-index:50;backdrop-filter:blur(14px);background:rgba(7,9,16,.6);border-bottom:1px solid rgba(255,255,255,.04)}
.nav-inner{max-width:1200px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.01em;font-size:17px}
.brand img{width:32px;height:32px;border-radius:8px;display:block}
.nav-links{display:flex;gap:24px;align-items:center;font-size:14px;color:var(--muted)}
.nav-links a{transition:color .15s}
.nav-links a:hover{color:var(--fg)}
.nav-links a.active{color:var(--fg)}
.btn{display:inline-block;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;border:none;transition:transform .08s,filter .2s,box-shadow .2s;text-align:center}
.btn-primary{background:linear-gradient(180deg,var(--accent),#2bb89a);color:#04201a;box-shadow:0 8px 20px -8px rgba(59,213,181,.5)}
.btn-primary:hover{transform:translateY(-1px);filter:brightness(1.05)}
.btn-ghost{background:rgba(255,255,255,.04);color:var(--fg);border:1px solid rgba(255,255,255,.08)}
.btn-ghost:hover{background:rgba(255,255,255,.07)}
.btn-sm{padding:8px 14px;font-size:13px}

/* ── header ── */
.page-head{position:relative;max-width:1200px;margin:0 auto;padding:64px 20px 32px;text-align:center;overflow:hidden}
.page-head::before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(60% 50% at 50% 0%,rgba(59,213,181,.1),transparent 70%),radial-gradient(40% 50% at 100% 100%,rgba(99,102,241,.08),transparent 70%)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(59,213,181,.08);border:1px solid rgba(59,213,181,.2);border-radius:999px;color:var(--accent);font-size:13px;font-weight:500;margin-bottom:20px;animation:fadeUp .5s ease-out both}
.eyebrow .live{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);animation:livePulse 1.5s ease-in-out infinite}
@keyframes livePulse{0%,100%{opacity:1;box-shadow:0 0 6px var(--accent)}50%{opacity:.5;box-shadow:0 0 12px var(--accent)}}
h1{font-size:clamp(36px,5.5vw,56px);line-height:1.05;letter-spacing:-.03em;margin:0 auto 16px;max-width:880px;font-weight:700;animation:fadeUp .6s ease-out both}
.grad{background:linear-gradient(90deg,#3bd5b5 0%,#6366f1 50%,#3bd5b5 100%);background-size:200% auto;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 6s linear infinite}
@keyframes shimmer{to{background-position:200% center}}
.lede{font-size:clamp(15px,2vw,18px);color:var(--muted);max-width:640px;margin:0 auto 24px;animation:fadeUp .7s ease-out both}
.refresh-row{display:inline-flex;align-items:center;gap:12px;padding:8px 16px;background:rgba(15,18,24,.7);border:1px solid var(--card-border);border-radius:999px;font-size:13px;color:var(--muted);animation:fadeUp .8s ease-out both}
.refresh-row .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);animation:livePulse 1.5s ease-in-out infinite}
.refresh-row .spin{display:inline-block;width:11px;height:11px;border:1.5px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px}
.refresh-row.refreshing .dot{display:none}
.refresh-row.refreshing .spin{display:inline-block}
.refresh-row .spin{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}

/* ── filter bar ── */
.filter-bar{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;padding:24px 20px 0;max-width:1200px;margin:0 auto}
.filter-pill{padding:7px 14px;font-size:13px;font-weight:500;border-radius:999px;border:1px solid var(--card-border);background:var(--card);color:var(--muted);cursor:pointer;transition:color .15s,border-color .15s,background .15s,transform .08s;font-family:inherit}
.filter-pill:hover{color:var(--fg);border-color:rgba(59,213,181,.3)}
.filter-pill.active{color:#04201a;background:linear-gradient(180deg,var(--accent),#2bb89a);border-color:transparent;box-shadow:0 4px 12px -4px rgba(59,213,181,.5)}

/* ── grid ── */
.grid-wrap{max-width:1200px;margin:0 auto;padding:32px 20px 96px}
.whale-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:20px}
.empty{padding:64px 20px;text-align:center;color:var(--muted);font-size:15px}

/* ── whale card ── */
.wcard{position:relative;display:flex;flex-direction:column;padding:24px;background:linear-gradient(180deg,rgba(22,27,34,.8),rgba(15,18,24,.8));border:1px solid var(--card-border);border-radius:16px;overflow:hidden;transition:transform .25s,border-color .25s,box-shadow .25s}
.wcard::before{content:"";position:absolute;inset:0;background:radial-gradient(400px circle at var(--mx,50%) var(--my,50%),rgba(59,213,181,.06),transparent 40%);opacity:0;transition:opacity .3s;pointer-events:none;border-radius:inherit}
.wcard:hover::before{opacity:1}
.wcard:hover{transform:translateY(-3px);border-color:rgba(59,213,181,.25);box-shadow:0 20px 40px -20px rgba(0,0,0,.5)}
.wcard.hidden{display:none}
.wcard-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:6px}
.wcard-alias{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;letter-spacing:-.01em}
.wcard-alias .badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid currentColor;opacity:.95}
.wcard-stale{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:3px 8px;border-radius:6px;background:rgba(139,148,158,.1);border:1px solid rgba(139,148,158,.2)}
.wcard-tagline{font-size:13px;color:var(--muted);line-height:1.55;margin:0 0 16px;min-height:36px}
.wcard-addr{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:18px}
.wcard-addr .addr-text{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;letter-spacing:-.01em}
.wcard-addr a{color:var(--muted);transition:color .15s}
.wcard-addr a:hover{color:var(--accent)}
.wcard-addr svg{width:11px;height:11px;display:inline-block;vertical-align:-1px;margin-left:2px}

.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--card-border);border-radius:10px;overflow:hidden;margin-bottom:18px}
.stat-cell{padding:12px 10px;background:rgba(15,18,24,.7);text-align:center}
.stat-cell .sv{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em;line-height:1.2}
.stat-cell .sv.good{color:var(--good)}
.stat-cell .sv.bad{color:var(--bad)}
.stat-cell .sl{font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:4px}

.pos-section{margin-bottom:18px}
.pos-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.pos-head .live-pulse{width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 4px var(--accent);animation:livePulse 1.5s ease-in-out infinite;display:inline-block;margin-right:6px;vertical-align:1px}
.pos-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}
.pos-row{display:flex;justify-content:space-between;align-items:center;padding:9px 11px;background:rgba(7,9,16,.5);border:1px solid var(--card-border);border-radius:8px;font-size:13px}
.pos-left{display:flex;align-items:center;gap:8px;min-width:0}
.pos-coin{font-weight:700;letter-spacing:-.01em}
.pos-side{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:.04em}
.pos-side.long{color:var(--good);background:rgba(59,213,181,.1);border:1px solid rgba(59,213,181,.25)}
.pos-side.short{color:var(--bad);background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25)}
.pos-size{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-size:12px;color:var(--muted)}
.pos-pnl{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-size:12px;font-weight:600;text-align:right;min-width:70px}
.pos-pnl.good{color:var(--good)}
.pos-pnl.bad{color:var(--bad)}
.pos-empty{padding:12px;text-align:center;font-size:12px;color:var(--muted);background:rgba(7,9,16,.4);border:1px dashed var(--card-border);border-radius:8px;font-style:italic}
.pos-more{font-size:11px;color:var(--muted);text-align:center;padding:6px}

.wcard-cta{margin-top:auto;display:flex;gap:8px;align-items:stretch}
.wcard-cta .btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px}

/* ── footer cta ── */
.foot-cta{max-width:1200px;margin:0 auto 64px;padding:48px 32px;background:linear-gradient(135deg,rgba(59,213,181,.06),rgba(99,102,241,.08));border:1px solid rgba(59,213,181,.2);border-radius:20px;text-align:center}
.foot-cta h2{font-size:clamp(24px,3.6vw,36px);line-height:1.15;letter-spacing:-.02em;margin:0 0 12px;font-weight:700}
.foot-cta p{color:var(--muted);font-size:16px;margin:0 auto 28px;max-width:520px}
.foot-cta .cta-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}

footer{padding:48px 20px 32px;border-top:1px solid rgba(255,255,255,.05);font-size:13px;color:var(--muted)}
.foot-inner{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;justify-content:space-between;gap:24px;align-items:center}
.socials{display:flex;gap:14px}
.socials a{width:38px;height:38px;border-radius:10px;background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center;transition:background .2s,color .2s,transform .15s;color:var(--muted)}
.socials a:hover{background:rgba(59,213,181,.12);color:var(--accent);transform:translateY(-2px)}
.socials svg{width:16px;height:16px}

@media(max-width:640px){
.nav-links a:not(.btn){display:none}
.page-head{padding:48px 20px 24px}
.grid-wrap{padding:24px 16px 64px}
.whale-grid{grid-template-columns:1fr;gap:14px}
.wcard{padding:20px}
.foot-cta{padding:32px 20px;margin:0 16px 48px}
.stat-grid{grid-template-columns:repeat(3,1fr)}
.stat-cell{padding:10px 6px}
.stat-cell .sv{font-size:13px}
}
`;

const JS = `
(function(){
  var glow=document.querySelector('.cursor-glow');
  if(glow&&window.matchMedia('(hover:hover)').matches){
    var rx=0,ry=0,cx=0,cy=0;
    document.addEventListener('mousemove',function(e){rx=e.clientX;ry=e.clientY});
    function loop(){cx+=(rx-cx)*0.12;cy+=(ry-cy)*0.12;glow.style.transform='translate('+cx+'px,'+cy+'px) translate(-50%,-50%)';requestAnimationFrame(loop)}
    loop();
  }
  document.querySelectorAll('.wcard').forEach(function(c){
    c.addEventListener('mousemove',function(e){
      var r=c.getBoundingClientRect();
      c.style.setProperty('--mx',(e.clientX-r.left)+'px');
      c.style.setProperty('--my',(e.clientY-r.top)+'px');
    });
  });

  // ── filter pills ──────────────────────────────────────────────
  var pills=document.querySelectorAll('.filter-pill');
  var cards=document.querySelectorAll('.wcard');
  pills.forEach(function(p){
    p.addEventListener('click',function(){
      pills.forEach(function(x){x.classList.remove('active')});
      p.classList.add('active');
      var f=p.getAttribute('data-filter')||'all';
      cards.forEach(function(c){
        if(f==='all'||c.getAttribute('data-specialty')===f){c.classList.remove('hidden')}
        else{c.classList.add('hidden')}
      });
    });
  });

  // ── "Updated Xs ago" ticker + live data refresh ───────────────
  var stamp=document.getElementById('refresh-stamp');
  var bar=document.getElementById('refresh-row');
  var dataAt=Number(document.body.getAttribute('data-generated-at'))||Date.now();

  function fmtAgo(ms){
    var s=Math.floor(ms/1000);
    if(s<5)return 'just now';
    if(s<60)return s+'s ago';
    var m=Math.floor(s/60);
    if(m<60)return m+'m ago';
    var h=Math.floor(m/60);
    return h+'h ago';
  }
  function tick(){if(stamp)stamp.textContent=fmtAgo(Date.now()-dataAt)}
  setInterval(tick,1000);tick();

  function fmtUsd(n){
    if(n===null||n===undefined||!isFinite(n))return '—';
    var abs=Math.abs(n);
    var sign=n<0?'−':'';
    if(abs>=1e6)return sign+'$'+(abs/1e6).toFixed(2)+'M';
    if(abs>=1e3)return sign+'$'+(abs/1e3).toFixed(1)+'K';
    return sign+'$'+abs.toFixed(0);
  }
  function pnlClass(n){if(n===null||n===undefined||!isFinite(n)||n===0)return '';return n>0?'good':'bad'}
  function fmtPnlSigned(n){
    if(n===null||n===undefined||!isFinite(n))return '—';
    if(n===0)return '$0';
    var s=n>0?'+':'−';
    var abs=Math.abs(n);
    if(abs>=1e6)return s+'$'+(abs/1e6).toFixed(2)+'M';
    if(abs>=1e3)return s+'$'+(abs/1e3).toFixed(1)+'K';
    return s+'$'+abs.toFixed(0);
  }

  function renderPositions(positions){
    if(!positions||positions.length===0){
      return '<div class="pos-empty">Flat right now</div>';
    }
    var top=positions.slice(0,3);
    var rest=positions.length-top.length;
    var html='<ul class="pos-list">';
    top.forEach(function(p){
      var pnlC=pnlClass(p.unrealizedPnlUsd);
      html+='<li class="pos-row">'
        +'<div class="pos-left">'
        +'<span class="pos-coin">'+escapeText(p.coin)+'</span>'
        +'<span class="pos-side '+p.side+'">'+(p.side==='long'?'LONG':'SHORT')+'</span>'
        +'<span class="pos-size">'+fmtUsd(p.sizeUsd)+'</span>'
        +'</div>'
        +'<div class="pos-pnl '+pnlC+'">'+fmtPnlSigned(p.unrealizedPnlUsd)+'</div>'
        +'</li>';
    });
    html+='</ul>';
    if(rest>0)html+='<div class="pos-more">+ '+rest+' more position'+(rest===1?'':'s')+'</div>';
    return html;
  }
  function escapeText(s){var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}

  // ── live refresh, straight from Hyperliquid's public /info ──────
  // HL's endpoint is CORS-open, so the browser pulls each whale's
  // clearinghouseState directly. Every volatile number on the card is
  // genuinely live per visitor instead of frozen at the last deploy:
  // open positions, unrealized PnL, account equity, AND the headline
  // 30d PnL. The realized 30d base is carried in data-r30; we add live
  // unrealized to it (total = realized + unrealized) so the headline
  // moves with the market.
  var HL_INFO='https://api.hyperliquid.xyz/info';
  function hlInfo(body){
    return fetch(HL_INFO,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){
      if(!r.ok)throw new Error('hl '+r.status);return r.json();
    });
  }
  function num(v){var n=typeof v==='number'?v:parseFloat(v);return isFinite(n)?n:0}
  function parseState(raw){
    var equity=num(raw&&raw.marginSummary&&raw.marginSummary.accountValue);
    var positions=[];
    var aps=(raw&&raw.assetPositions)||[];
    for(var i=0;i<aps.length;i++){
      var p=aps[i]&&aps[i].position;if(!p||!p.coin)continue;
      var szi=num(p.szi);if(szi===0)continue;
      var entry=num(p.entryPx);
      var sz=num(p.positionValue)||Math.abs(szi)*entry;
      positions.push({coin:String(p.coin).toUpperCase(),side:szi>0?'long':'short',sizeUsd:sz,entryPx:entry,unrealizedPnlUsd:num(p.unrealizedPnl)});
    }
    positions.sort(function(a,b){return b.sizeUsd-a.sizeUsd});
    return {equityUsd:equity,positions:positions};
  }
  function cardAddrs(){
    var out=[];
    document.querySelectorAll('.wcard').forEach(function(c){var a=c.getAttribute('data-address');if(a)out.push(a)});
    return out;
  }
  function refresh(){
    var addrs=cardAddrs();
    if(addrs.length===0)return;
    if(bar)bar.classList.add('refreshing');
    Promise.all(addrs.map(function(a){
      return hlInfo({type:'clearinghouseState',user:a}).then(function(raw){return {address:a,state:parseState(raw)}}).catch(function(){return null});
    })).then(function(results){
      var ok=0;
      results.forEach(function(res){
        if(!res)return;ok++;
        var card=document.querySelector('.wcard[data-address="'+res.address.toLowerCase()+'"]');
        if(!card)return;
        var staleEl=card.querySelector('.wcard-stale');if(staleEl)staleEl.style.display='none';
        var cells=card.querySelectorAll('.stat-cell .sv');
        var unreal=0;res.state.positions.forEach(function(p){unreal+=p.unrealizedPnlUsd});
        var r30=parseFloat(card.getAttribute('data-r30')||'0');if(!isFinite(r30))r30=0;
        var total=r30+unreal;
        if(cells[0]){cells[0].textContent=fmtPnlSigned(total);cells[0].className='sv '+pnlClass(total)}
        if(cells[1]){cells[1].textContent=fmtPnlSigned(unreal);cells[1].className='sv '+pnlClass(unreal)}
        if(cells[2]){cells[2].textContent=fmtUsd(res.state.equityUsd);cells[2].className='sv'}
        var posWrap=card.querySelector('.pos-content');
        if(posWrap)posWrap.innerHTML=renderPositions(res.state.positions);
        var posCount=card.querySelector('.pos-count');
        if(posCount)posCount.textContent=res.state.positions.length?String(res.state.positions.length)+' open':'flat';
      });
      if(ok>0){dataAt=Date.now();document.body.setAttribute('data-generated-at',String(dataAt))}
    }).catch(function(){}).finally(function(){
      setTimeout(function(){bar&&bar.classList.remove('refreshing')},400);
    });
  }
  refresh();
  setInterval(refresh,30000);
  // Also refresh when tab regains focus after >30s
  var lastFocus=Date.now();
  document.addEventListener('visibilitychange',function(){
    if(!document.hidden && Date.now()-lastFocus>30000){refresh();lastFocus=Date.now()}
  });
})();
`;

export function buildWhalesHtml(env: WhalesPageEnv): string {
  const botUrl = escapeHtml(env.botUrl);
  const defaultFee = (BUILDER_FEE_DEFAULT_TENTHS_BP / 10).toFixed(1);
  const total = env.snapshots.length;
  const liveCount = env.snapshots.filter((s) => !s.stale).length;
  const cards = env.snapshots.map((s) => renderCard(s, botUrl)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#070910">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<title>Whales worth mirroring — WhalePod</title>
<meta name="description" content="Live directory of ${String(total)} verified-profitable Hyperliquid whales. Real positions, real PnL. Mirror any of them in 60 seconds from Telegram.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://www.whalepod.trade/whales/">
<meta property="og:title" content="Whales worth mirroring — WhalePod">
<meta property="og:description" content="Live directory of ${String(total)} verified-profitable Hyperliquid whales. Real positions, real PnL.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://www.whalepod.trade/whales/">
<meta property="og:image" content="https://www.whalepod.trade/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@whalepodapp">
<meta name="twitter:image" content="https://www.whalepod.trade/og-card.png">
<style>${CSS}</style>
</head>
<body data-generated-at="${String(env.generatedAt)}">
<div class="cursor-glow" aria-hidden="true"></div>

<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="brand"><img src="/logo.png" alt="WhalePod" width="32" height="32"><span>WhalePod</span></a>
    <div class="nav-links">
      <a href="/#how">How it works</a>
      <a href="/#fees">Fees</a>
      <a href="/whales/" class="active">Whales</a>
      <a class="btn btn-primary" href="${botUrl}" rel="noopener">Launch app</a>
    </div>
  </div>
</nav>

<header class="page-head">
  <div class="eyebrow"><span class="live"></span> ${String(liveCount)} of ${String(total)} live · Hyperliquid mainnet</div>
  <h1>Whales worth <span class="grad">mirroring</span>.</h1>
  <p class="lede">Hand-picked from the Hyperliquid leaderboard, auto-filtered for current profitability. Real positions. Real PnL. Mirror any of them in 60 seconds, non-custodially, for ${defaultFee} bps.</p>
  <div id="refresh-row" class="refresh-row">
    <span class="dot"></span><span class="spin"></span>
    <span>Live data · updated <span id="refresh-stamp">just now</span></span>
  </div>
</header>

<div class="filter-bar" role="tablist" aria-label="Filter whales by specialty">
  <button class="filter-pill active" data-filter="all" type="button">All</button>
  ${renderFilterPills(env.snapshots)}
</div>

<main class="grid-wrap">
  ${
    total === 0
      ? '<div class="empty">No whales yet. Check back soon.</div>'
      : `<div class="whale-grid">${cards}</div>`
  }
</main>

<section class="foot-cta">
  <h2>Ready to mirror one?</h2>
  <p>Open the bot, browse the same list, and tap <strong>/follow</strong> on any whale to start mirroring. Set a per-trade cap so a bad call can't blow up your account.</p>
  <div class="cta-row">
    <a class="btn btn-primary" href="${botUrl}" rel="noopener">Launch in Telegram →</a>
    <a class="btn btn-ghost" href="${APP_URL}" rel="noopener">Open mini-app</a>
  </div>
</section>

<footer>
  <div class="foot-inner">
    <div>
      <div class="brand" style="margin-bottom:6px"><img src="/logo.png" alt="WhalePod" width="28" height="28" style="width:28px;height:28px"><span>WhalePod</span></div>
      <div>Copy-trade Hyperliquid perps from Telegram. Non-custodial.</div>
      <div style="margin-top:8px;font-size:12px">Trading derivatives carries risk of loss. Past whale performance is not indicative of future results.</div>
    </div>
    <div class="socials" aria-label="Social links">
      <a href="${X_URL}" rel="noopener" aria-label="X / Twitter" title="X / Twitter"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
      <a href="${TG_CHANNEL}" rel="noopener" aria-label="Telegram channel" title="Telegram announcements"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.05 2.555 1.95 10.39c-1.366.535-1.358 1.27-.25 1.61l5.156 1.61L18.78 6.087c.564-.343 1.078-.158.656.218l-9.668 8.728-.371 5.51c.534 0 .77-.245 1.07-.535l2.572-2.498 5.34 3.943c.984.543 1.69.264 1.935-.913l3.502-16.5c.36-1.444-.547-2.098-1.766-1.485z"/></svg></a>
      <a href="${TG_GROUP}" rel="noopener" aria-label="Telegram group" title="Telegram chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></a>
      <a href="${GH_URL}" rel="noopener" aria-label="GitHub" title="GitHub"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.7.5.7 5.5.7 11.8c0 5 3.3 9.3 7.8 10.8.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.7 2.7 1.2 3.4.9.1-.7.4-1.2.7-1.5-2.5-.3-5.2-1.3-5.2-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.2 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.3 5.5 18.3.5 12 .5z"/></svg></a>
    </div>
  </div>
  <div style="max-width:1200px;margin:24px auto 0;text-align:center;font-size:12px;color:var(--muted)">© ${String(new Date(env.generatedAt).getFullYear())} WhalePod · Open source under AGPL-3.0</div>
</footer>

<script>${JS}</script>
</body>
</html>
`;
}

function renderFilterPills(snapshots: readonly WhaleSnapshot[]): string {
  const seen = new Set<WhaleSpecialty>();
  for (const s of snapshots) seen.add(s.meta.specialty);
  return Array.from(seen)
    .map(
      (sp) =>
        `<button class="filter-pill" data-filter="${escapeHtml(sp)}" type="button">${escapeHtml(sp)}</button>`,
    )
    .join('');
}

function renderCard(s: WhaleSnapshot, botUrl: string): string {
  const addr = s.meta.address;
  const addrShort = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const alias = escapeHtml(s.meta.alias);
  const tagline = escapeHtml(s.meta.tagline);
  const specialty = escapeHtml(s.meta.specialty);
  const badgeColor = SPECIALTY_COLOR[s.meta.specialty];
  // Deep-link the bot with `src_whale_<slug>` so we can attribute taps
  // to specific whale cards in the bot_start audit log AND so handleStart
  // can resolve the slug back to this whale and pre-fill /follow.
  const startUrl = `${botUrl}?start=src_whale_${escapeHtml(whaleSlug(s.meta.alias))}`;
  const hypurrUrl = `${HYPURRSCAN_BASE}/${addr}`;

  const unrealizedUsd = s.stale
    ? null
    : s.positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
  const total30dUsd = s.thirtyDayUsd === null ? null : s.thirtyDayUsd + (unrealizedUsd ?? 0);
  const total30d = renderPnlCell(total30dUsd);
  const unrealized = renderPnlCell(unrealizedUsd);
  const equity = renderEquityCell(s.equityUsd);

  const posCount = s.positions.length;
  const posBadge = posCount > 0 ? `${String(posCount)} open` : 'flat';
  const positionsHtml = renderPositions(s.positions);

  return `<article class="wcard" data-address="${escapeHtml(addr)}" data-specialty="${specialty}" data-r30="${String(s.thirtyDayUsd ?? 0)}">
  <div class="wcard-head">
    <div class="wcard-alias">
      <span>${alias}</span>
      <span class="badge" style="color:${badgeColor}">${specialty}</span>
    </div>
    <span class="wcard-stale" style="${s.stale ? '' : 'display:none'}">data stale</span>
  </div>
  <p class="wcard-tagline">${tagline}</p>
  <div class="wcard-addr">
    <span class="addr-text">${addrShort}</span>
    <span>·</span>
    <a href="${hypurrUrl}" rel="noopener" target="_blank">HypurrScan<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></a>
  </div>

  <div class="stat-grid">
    <div class="stat-cell"><div class="sv ${total30d.cls}">${total30d.text}</div><div class="sl">30d PnL</div></div>
    <div class="stat-cell"><div class="sv ${unrealized.cls}">${unrealized.text}</div><div class="sl">unrealized</div></div>
    <div class="stat-cell"><div class="sv">${equity}</div><div class="sl">live equity</div></div>
  </div>

  <div class="pos-section">
    <div class="pos-head"><span><span class="live-pulse"></span>Current positions</span><span class="pos-count">${posBadge}</span></div>
    <div class="pos-content">${positionsHtml}</div>
  </div>

  <div class="wcard-cta">
    <a class="btn btn-primary btn-sm" href="${startUrl}" rel="noopener">Mirror this whale →</a>
  </div>
</article>`;
}

function renderPositions(positions: readonly HlOpenPosition[]): string {
  if (positions.length === 0) {
    return '<div class="pos-empty">Flat right now</div>';
  }
  const top = positions.slice(0, 3);
  const rest = positions.length - top.length;
  const rows = top
    .map((p) => {
      const pnl = renderPnlCell(p.unrealizedPnlUsd);
      const sideText = p.side === 'long' ? 'LONG' : 'SHORT';
      return `<li class="pos-row"><div class="pos-left"><span class="pos-coin">${escapeHtml(p.coin)}</span><span class="pos-side ${p.side}">${sideText}</span><span class="pos-size">${fmtUsd(p.sizeUsd)}</span></div><div class="pos-pnl ${pnl.cls}">${pnl.text}</div></li>`;
    })
    .join('');
  const moreLine =
    rest > 0
      ? `<div class="pos-more">+ ${String(rest)} more position${rest === 1 ? '' : 's'}</div>`
      : '';
  return `<ul class="pos-list">${rows}</ul>${moreLine}`;
}

function renderPnlCell(n: number | null): { text: string; cls: string } {
  if (n === null) return { text: '—', cls: '' };
  if (n === 0) return { text: '$0', cls: '' };
  const sign = n > 0 ? '+' : '−';
  const abs = Math.abs(n);
  let body: string;
  if (abs >= 1e6) body = `$${(abs / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) body = `$${(abs / 1e3).toFixed(1)}K`;
  else body = `$${abs.toFixed(0)}`;
  return { text: `${sign}${body}`, cls: n > 0 ? 'good' : 'bad' };
}

function renderEquityCell(n: number | null): string {
  if (n === null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Public JSON shape — what `/api/whales.json` exposes for client-side refresh.
 * Keep stable; the page JS depends on these field names.
 */
export interface WhalesJsonPayload {
  readonly generatedAt: number;
  readonly whales: readonly {
    readonly address: string;
    readonly alias: string;
    readonly specialty: WhaleSpecialty;
    readonly stale: boolean;
    readonly equityUsd: number | null;
    readonly thirtyDayUsd: number | null;
    readonly allTimeUsd: number | null;
    readonly sevenDayUsd: number | null;
    readonly fillCount: number | null;
    readonly positions: readonly HlOpenPosition[];
  }[];
}

export function buildWhalesJson(env: WhalesPageEnv): WhalesJsonPayload {
  return {
    generatedAt: env.generatedAt,
    whales: env.snapshots.map((s) => ({
      address: s.meta.address,
      alias: s.meta.alias,
      specialty: s.meta.specialty,
      stale: s.stale,
      equityUsd: s.equityUsd,
      thirtyDayUsd: s.thirtyDayUsd,
      allTimeUsd: s.allTimeUsd,
      sevenDayUsd: s.sevenDayUsd,
      fillCount: s.fillCount,
      positions: s.positions,
    })),
  };
}
