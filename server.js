const NodeMediaServer = require('node-media-server');
const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');
const fs = require('fs');
const { execSync } = require('child_process');

const HTTP_PORT = process.env.PORT || 8000;
const STREAM_KEY = process.env.STREAM_KEY || 'live';
const NMS_HTTP_PORT = 8888;
const NMS_RTMP_PORT = 1935;

// Find ffmpeg
let FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
try {
  FFMPEG_PATH = execSync('which ffmpeg').toString().trim();
  console.log('[ffmpeg] Found at:', FFMPEG_PATH);
} catch {
  console.log('[ffmpeg] Using default path: ffmpeg');
}

// ── Node Media Server ─────────────────────────────────────────────────────────
const nms = new NodeMediaServer({
  rtmp: {
    port: NMS_RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: NMS_HTTP_PORT,
    mediaroot: '/tmp',
    allow_origin: '*'
  },
  trans: {
    ffmpeg: FFMPEG_PATH,
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=1:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepDays: 0,
        dash: false
      }
    ]
  }
});

nms.run();

nms.on('prePublish', (id, streamPath) => console.log('[RTMP] Stream started:', streamPath));
nms.on('donePublish', (id, streamPath) => console.log('[RTMP] Stream ended:', streamPath));

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
const proxy = httpProxy.createProxyServer({});

// Proxy /live/* to NMS internal HTTP
app.use('/live', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  proxy.web(req, res, { target: `http://127.0.0.1:${NMS_HTTP_PORT}` });
});

app.get('/status', (req, res) => {
  const hlsDir = `/tmp/live/${STREAM_KEY}`;
  const streaming = fs.existsSync(hlsDir) &&
    fs.readdirSync(hlsDir).some(f => f.endsWith('.m3u8'));
  res.json({ streaming, hlsUrl: `/live/${STREAM_KEY}/index.m3u8` });
});

app.get('/', (req, res) => res.send(VIEWER_HTML));

const server = http.createServer(app);

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

let piClient = null;
const browserClients = new Set();

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'identify' && msg.role === 'pi') {
      piClient = ws;
      console.log('[WS] Pi registered');
      ws.send(JSON.stringify({ type: 'ready' }));
      browserClients.forEach(c => {
        if (c.readyState === WebSocket.OPEN)
          c.send(JSON.stringify({ type: 'pi_connected' }));
      });
      return;
    }

    if (msg.type === 'identify' && msg.role === 'browser') {
      browserClients.add(ws);
      ws.send(JSON.stringify({ type: 'pi_status', connected: !!(piClient && piClient.readyState === WebSocket.OPEN) }));
      return;
    }

    if (msg.type === 'control' && piClient && piClient.readyState === WebSocket.OPEN) {
      piClient.send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => {
    if (ws === piClient) {
      piClient = null;
      console.log('[WS] Pi disconnected');
      browserClients.forEach(c => {
        if (c.readyState === WebSocket.OPEN)
          c.send(JSON.stringify({ type: 'pi_disconnected' }));
      });
    }
    browserClients.delete(ws);
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Viewer on port ${HTTP_PORT}`);
  console.log(`[RTMP] Ingest on port ${NMS_RTMP_PORT}`);
  console.log(`[HLS]  Stream at /live/${STREAM_KEY}/index.m3u8`);
});

// ── Viewer HTML ───────────────────────────────────────────────────────────────
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>chevrondesigns.one — live</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500&family=Geist:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #080808; --surface: #111111; --border: #222222;
    --accent: #e8ff47; --text: #f0f0f0; --muted: #666;
    --danger: #ff4747; --online: #47ff8a;
  }
  html, body { background: var(--bg); color: var(--text); font-family: 'Geist', sans-serif; font-size: 14px; }
  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 100;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
  }
  .layout { display: grid; grid-template-columns: 1fr 280px; grid-template-rows: auto 1fr; min-height: 100vh; max-width: 1400px; margin: 0 auto; padding: 24px; gap: 16px; }
  header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  .logo { font-family: 'Geist Mono', monospace; font-size: 13px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  .logo span { color: var(--accent); }
  .status-pill { display: flex; align-items: center; gap: 8px; font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--muted); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); transition: background 0.4s; }
  .dot.live { background: var(--danger); animation: pulse 1.4s ease-in-out infinite; }
  .dot.online { background: var(--online); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .video-wrap { position: relative; background: #000; border: 1px solid var(--border); aspect-ratio: 16/9; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .video-overlay { position: absolute; top: 12px; left: 12px; font-family: 'Geist Mono', monospace; font-size: 10px; color: rgba(255,255,255,0.5); pointer-events: none; line-height: 1.8; }
  .offline-screen { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: #000; font-family: 'Geist Mono', monospace; color: var(--muted); font-size: 12px; letter-spacing: 0.05em; }
  .controls { display: flex; flex-direction: column; gap: 4px; }
  .panel { background: var(--surface); border: 1px solid var(--border); padding: 20px; }
  .panel-title { font-family: 'Geist Mono', monospace; font-size: 10px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 20px; }
  .control-row { margin-bottom: 20px; }
  .control-row:last-child { margin-bottom: 0; }
  .control-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 12px; }
  .control-label span:first-child { color: var(--text); font-weight: 500; }
  .control-value { font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--accent); min-width: 36px; text-align: right; }
  input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 2px; outline: none; cursor: pointer; background: linear-gradient(to right, var(--accent) var(--pct,50%), var(--border) var(--pct,50%)); }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; background: var(--accent); border-radius: 0; cursor: pointer; transition: transform 0.1s; }
  input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.3); }
  .reset-btn { width: 100%; padding: 10px; background: transparent; border: 1px solid var(--border); color: var(--muted); font-family: 'Geist Mono', monospace; font-size: 11px; letter-spacing: 0.05em; cursor: pointer; margin-top: 16px; transition: all 0.2s; text-transform: uppercase; }
  .reset-btn:hover { border-color: var(--accent); color: var(--accent); }
  .pi-status { display: flex; align-items: center; gap: 8px; font-family: 'Geist Mono', monospace; font-size: 10px; color: var(--muted); margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
  .note { font-size: 10px; color: var(--muted); line-height: 1.6; font-family: 'Geist Mono', monospace; margin-top: 8px; }
  @media (max-width: 768px) { .layout { grid-template-columns: 1fr; padding: 12px; } }
</style>
</head>
<body>
<div class="layout">
  <header>
    <div class="logo">chevron<span>designs</span>.one — cam</div>
    <div style="display:flex;gap:16px;align-items:center">
      <div class="status-pill"><div class="dot" id="stream-dot"></div><span id="stream-label">WAITING</span></div>
      <div class="status-pill"><div class="dot" id="pi-dot"></div><span id="pi-label">PI OFFLINE</span></div>
    </div>
  </header>
  <div class="video-wrap">
    <video id="video" playsinline muted autoplay></video>
    <div class="video-overlay" id="vid-info"></div>
    <div class="offline-screen" id="offline">
      <div style="font-size:32px;opacity:0.15">◈</div>
      <div>NO SIGNAL</div>
      <div style="font-size:10px">waiting for stream</div>
    </div>
  </div>
  <div class="controls">
    <div class="panel">
      <div class="panel-title">Image — client side</div>
      <div class="control-row">
        <div class="control-label"><span>Brightness</span><span class="control-value" id="bright-val">100%</span></div>
        <input type="range" id="brightness" min="50" max="200" value="100" oninput="updateFilter(this,'brightness','bright-val','%')">
      </div>
      <div class="control-row">
        <div class="control-label"><span>Contrast</span><span class="control-value" id="cont-val">100%</span></div>
        <input type="range" id="contrast" min="50" max="200" value="100" oninput="updateFilter(this,'contrast','cont-val','%')">
      </div>
      <div class="control-row">
        <div class="control-label"><span>Saturation</span><span class="control-value" id="sat-val">100%</span></div>
        <input type="range" id="saturation" min="0" max="200" value="100" oninput="updateFilter(this,'saturation','sat-val','%')">
      </div>
      <button class="reset-btn" onclick="resetFilters()">Reset filters</button>
    </div>
    <div class="panel">
      <div class="panel-title">Camera — sent to Pi</div>
      <div class="control-row">
        <div class="control-label"><span>Exposure</span><span class="control-value" id="exp-val">0</span></div>
        <input type="range" id="exposure" min="-8" max="8" value="0" step="0.5" oninput="updateCam(this,'exposure','exp-val',1)">
      </div>
      <div class="control-row">
        <div class="control-label"><span>Sharpness</span><span class="control-value" id="sharp-val">1.0</span></div>
        <input type="range" id="sharpness" min="0" max="2" value="1" step="0.1" oninput="updateCam(this,'sharpness','sharp-val',1)">
      </div>
      <div class="pi-status"><div class="dot" id="ws-dot"></div><span id="ws-label">Pi not connected</span></div>
      <div class="note">Camera controls require Pi stream client running.</div>
    </div>
  </div>
</div>
<script>
const HLS_URL = '/live/live/index.m3u8';
const WS_URL = (location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
const video = document.getElementById('video');
const offline = document.getElementById('offline');
let filterState = { brightness:1, contrast:1, saturation:1 };
let ws, piConnected = false;
let camControls = { exposure:0, sharpness:1.0 };
let sendTimer = null;

function startHLS() {
  if (Hls.isSupported()) {
    const hls = new Hls({ lowLatencyMode:true, liveSyncDurationCount:2, liveMaxLatencyDurationCount:4, maxLiveSyncPlaybackRate:1.5 });
    hls.loadSource(HLS_URL);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play(); offline.style.display='none'; setStreamStatus(true); });
    hls.on(Hls.Events.ERROR, (e,d) => { if(d.fatal){ setStreamStatus(false); setTimeout(startHLS,4000); } });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src=HLS_URL; video.play(); offline.style.display='none'; setStreamStatus(true);
  }
}

function setStreamStatus(live) {
  document.getElementById('stream-dot').className='dot'+(live?' live':'');
  document.getElementById('stream-label').textContent=live?'LIVE':'WAITING';
  offline.style.display=live?'none':'flex';
}

async function waitForStream() {
  try { const d=await (await fetch('/status')).json(); if(d.streaming){startHLS();return;} } catch {}
  setTimeout(waitForStream,3000);
}
waitForStream();

setInterval(()=>{ if(video.readyState>=2) document.getElementById('vid-info').textContent=video.videoWidth+'×'+video.videoHeight; },2000);

function updateFilter(el,prop,labelId,unit) {
  filterState[prop]=parseFloat(el.value)/100;
  video.style.filter='brightness('+filterState.brightness+') contrast('+filterState.contrast+') saturate('+filterState.saturation+')';
  document.getElementById(labelId).textContent=el.value+unit;
  updateTrack(el);
}

function resetFilters() {
  ['brightness','contrast','saturation'].forEach(p=>{
    const el=document.getElementById(p); el.value=100; filterState[p]=1; updateTrack(el);
    document.getElementById(p==='brightness'?'bright-val':p==='contrast'?'cont-val':'sat-val').textContent='100%';
  });
  video.style.filter='';
}

function updateTrack(el) {
  el.style.setProperty('--pct',((parseFloat(el.value)-parseFloat(el.min))/(parseFloat(el.max)-parseFloat(el.min))*100).toFixed(1)+'%');
}

document.querySelectorAll('input[type=range]').forEach(updateTrack);

function updateCam(el,prop,labelId,dec) {
  const v=parseFloat(el.value); camControls[prop]=v;
  document.getElementById(labelId).textContent=v.toFixed(dec);
  updateTrack(el);
  clearTimeout(sendTimer);
  sendTimer=setTimeout(()=>{ if(ws&&ws.readyState===WebSocket.OPEN&&piConnected) ws.send(JSON.stringify({type:'control',...camControls})); },120);
}

function connectWS() {
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>ws.send(JSON.stringify({type:'identify',role:'browser'}));
  ws.onmessage=(e)=>{
    const msg=JSON.parse(e.data);
    const on=msg.type==='pi_connected'||(msg.type==='pi_status'&&msg.connected);
    const off=msg.type==='pi_disconnected'||(msg.type==='pi_status'&&!msg.connected);
    if(on){piConnected=true;document.getElementById('ws-dot').className='dot online';document.getElementById('ws-label').textContent='Pi connected';document.getElementById('pi-dot').className='dot online';document.getElementById('pi-label').textContent='PI ONLINE';}
    if(off){piConnected=false;document.getElementById('ws-dot').className='dot';document.getElementById('ws-label').textContent='Pi not connected';document.getElementById('pi-dot').className='dot';document.getElementById('pi-label').textContent='PI OFFLINE';}
  };
  ws.onclose=()=>setTimeout(connectWS,3000);
}
connectWS();
</script>
</body>
</html>`;
