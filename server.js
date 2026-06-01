const NodeMediaServer = require('node-media-server');
const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');
const fs = require('fs');
const HTTP_PORT = process.env.PORT || 8000;
const STREAM_KEY = process.env.STREAM_KEY || 'live';
const NMS_HTTP_PORT = 8889;
const NMS_RTMP_PORT = 1935;

const FFMPEG_PATH = require('ffmpeg-static');
console.log('[ffmpeg] Path:', FFMPEG_PATH);
console.log('[ffmpeg] Exists:', fs.existsSync(FFMPEG_PATH));

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

proxy.on('error', (err, req, res) => {
  res.writeHead(502);
  res.end('Stream not ready');
});

app.use('/live', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  req.url = '/live' + req.url;
  proxy.web(req, res, { target: `http://127.0.0.1:${NMS_HTTP_PORT}` });
});

app.get('/status', (req, res) => {
  const hlsDir = `/tmp/live/${STREAM_KEY}`;
  let streaming = false;
  try {
    streaming = fs.existsSync(hlsDir) && fs.readdirSync(hlsDir).some(f => f.endsWith('.m3u8'));
  } catch {}
  res.json({ streaming, hlsUrl: `/live/${STREAM_KEY}/index.m3u8` });
});

app.get('/', (req, res) => res.send(VIEWER_HTML));

const server = http.createServer(app);

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

let piClient = null;
const browserClients = new Set();

// Queue last control state so Pi gets it immediately on connect
let lastCamState = null;

function broadcastToBrowsers(msg) {
  const str = JSON.stringify(msg);
  browserClients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  });
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // ── Pi registration ───────────────────────────────────────────────────────
    if (msg.type === 'identify' && msg.role === 'pi') {
      piClient = ws;
      console.log('[WS] Pi registered');
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.send(JSON.stringify({ type: 'start_temp' }));
      // Replay last known camera state so Pi is in sync immediately
      if (lastCamState) {
        ws.send(JSON.stringify({ type: 'control', ...lastCamState }));
        console.log('[WS] Replayed cam state to Pi:', lastCamState);
      }
      broadcastToBrowsers({ type: 'pi_connected' });
      return;
    }

    // ── Browser registration ──────────────────────────────────────────────────
    if (msg.type === 'identify' && msg.role === 'browser') {
      browserClients.add(ws);
      ws.send(JSON.stringify({
        type: 'pi_status',
        connected: !!(piClient && piClient.readyState === WebSocket.OPEN)
      }));
      // Send last known cam state to browser so sliders are in sync
      if (lastCamState) {
        ws.send(JSON.stringify({ type: 'cam_state', ...lastCamState }));
      }
      return;
    }

    // ── Camera control from browser → Pi ─────────────────────────────────────
    if (msg.type === 'control') {
      // Save state regardless of Pi connection status
      lastCamState = {
        exposure: msg.exposure ?? 0,
        sharpness: msg.sharpness ?? 1.0,
        iso: msg.iso ?? 0,
        awb: msg.awb ?? 'auto',
        contrast: msg.contrast ?? 1.0,
        denoise: msg.denoise ?? 1.0
      };
      if (piClient && piClient.readyState === WebSocket.OPEN) {
        piClient.send(JSON.stringify({ type: 'control', ...lastCamState }));
      } else {
        console.log('[WS] Control queued (Pi offline):', lastCamState);
      }
      return;
    }

    // ── Temperature from Pi → browsers ───────────────────────────────────────
    if (msg.type === 'temp') {
      broadcastToBrowsers(msg);
      return;
    }

    // ── Generic relay Pi → browsers ──────────────────────────────────────────
    if (msg.type === 'cam_info') {
      broadcastToBrowsers(msg);
      return;
    }
  });

  ws.on('close', () => {
    if (ws === piClient) {
      piClient = null;
      console.log('[WS] Pi disconnected');
      broadcastToBrowsers({ type: 'pi_disconnected' });
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
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js"><\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500&family=IBM+Plex+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #060606;
  --bg1: #0d0d0d;
  --bg2: #141414;
  --bg3: #1c1c1c;
  --border: #252525;
  --border2: #303030;
  --accent: #c8ff00;
  --text: #e8e8e8;
  --text2: #888;
  --text3: #555;
  --danger: #ff3f3f;
  --warn: #ffaa00;
  --online: #00e87a;
  --mono: 'IBM Plex Mono', monospace;
  --sans: 'IBM Plex Sans', sans-serif;
}
html, body { background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 13px; line-height: 1.5; }

.root { display: grid; grid-template-columns: 1fr 300px; grid-template-rows: 48px 1fr; min-height: 100vh; max-width: 1480px; margin: 0 auto; }

header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--bg1); }
.wordmark { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; color: var(--text3); text-transform: uppercase; }
.wordmark em { color: var(--accent); font-style: normal; }
.badges { display: flex; align-items: center; gap: 12px; }
.badge { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; color: var(--text3); text-transform: uppercase; }
.pip { width: 6px; height: 6px; border-radius: 50%; background: var(--text3); flex-shrink: 0; }
.pip.live { background: var(--danger); animation: blink 1.6s ease-in-out infinite; }
.pip.on { background: var(--online); }
.pip.warn { background: var(--warn); }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }

.video-col { display: flex; flex-direction: column; background: #000; border-right: 1px solid var(--border); }
.video-wrap { position: relative; flex: 1; background: #000; overflow: hidden; }
video { width: 100%; height: 100%; object-fit: contain; display: block; }
#edge-filter { position: absolute; width: 0; height: 0; }

.offline-screen { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: #000; font-family: var(--mono); color: var(--text3); font-size: 11px; letter-spacing: 0.1em; }
.offline-screen .icon { font-size: 36px; opacity: 0.1; font-family: sans-serif; }

.vid-meta { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--bg1); font-family: var(--mono); font-size: 10px; color: var(--text3); flex-shrink: 0; }
.vid-meta span { color: var(--text2); }

.sidebar { display: flex; flex-direction: column; overflow-y: auto; background: var(--bg1); }
.sidebar::-webkit-scrollbar { width: 3px; }
.sidebar::-webkit-scrollbar-thumb { background: var(--border2); }

.section { border-bottom: 1px solid var(--border); padding: 16px; }
.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.section-title { font-family: var(--mono); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text3); }
.section-tag { font-family: var(--mono); font-size: 9px; color: var(--text3); background: var(--bg3); border: 1px solid var(--border); padding: 2px 6px; letter-spacing: 0.04em; }

.ctrl { margin-bottom: 12px; }
.ctrl:last-child { margin-bottom: 0; }
.ctrl-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ctrl-name { font-size: 12px; color: var(--text2); font-weight: 400; }
.ctrl-val { font-family: var(--mono); font-size: 11px; color: var(--accent); min-width: 40px; text-align: right; }

input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 2px; border-radius: 0; outline: none; cursor: pointer; background: linear-gradient(to right, var(--accent) var(--pct,50%), var(--border2) var(--pct,50%)); }
input[type=range].pi-ctrl { background: linear-gradient(to right, #5599ff var(--pct,50%), var(--border2) var(--pct,50%)); }
input[type=range].pi-ctrl::-webkit-slider-thumb { background: #5599ff; }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 0; background: var(--accent); cursor: pointer; transition: transform 0.1s; }
input[type=range]::-webkit-slider-thumb:active { transform: scale(1.4); }

select { width: 100%; background: var(--bg3); border: 1px solid var(--border2); color: var(--text); font-family: var(--mono); font-size: 11px; padding: 5px 8px; outline: none; cursor: pointer; -webkit-appearance: none; appearance: none; border-radius: 0; }

.pi-badge { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 10px; color: var(--text3); margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }

.btn-row { display: flex; gap: 6px; margin-top: 10px; }
.btn { flex: 1; padding: 7px 0; background: transparent; border: 1px solid var(--border2); color: var(--text3); font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.blue:hover { border-color: #5599ff; color: #5599ff; }

.temp-display { font-family: var(--mono); font-size: 24px; font-weight: 300; color: var(--text2); letter-spacing: -0.02em; margin: 4px 0; }
.temp-bar { height: 2px; background: var(--border); margin-top: 8px; position: relative; }
.temp-fill { height: 100%; background: var(--online); transition: width 0.4s ease, background 0.4s ease; width: 0%; }

@media (max-width: 860px) {
  .root { grid-template-columns: 1fr; grid-template-rows: 48px auto auto; }
  .video-col { border-right: none; border-bottom: 1px solid var(--border); min-height: 56vw; }
}
</style>
</head>
<body>
<svg id="edge-filter" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="sharpen-filter" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feConvolveMatrix id="sharpen-matrix" order="3" divisor="1"
        kernelMatrix="0 -0.5 0  -0.5 3 -0.5  0 -0.5 0"
        preserveAlpha="true"/>
    </filter>
    <filter id="edge-overlay" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="0.8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="arithmetic" k1="0" k2="2" k3="-1" k4="0"/>
    </filter>
  </defs>
</svg>

<div class="root">
  <header>
    <div class="wordmark">chevron<em>designs</em>.one — <em>cam</em></div>
    <div class="badges">
      <div class="badge"><div class="pip" id="stream-dot"></div><span id="stream-label">waiting</span></div>
      <div class="badge" id="temp-badge" style="display:none">
        <div class="pip on" id="temp-dot"></div>
        <span id="temp-badge-val">--°C</span>
      </div>
      <div class="badge"><div class="pip" id="pi-dot"></div><span id="pi-label">pi offline</span></div>
    </div>
  </header>

  <div class="video-col">
    <div class="video-wrap">
      <video id="video" playsinline muted autoplay></video>
      <div class="offline-screen" id="offline">
        <div class="icon">⬡</div>
        <div>NO SIGNAL</div>
        <div style="font-size:9px;margin-top:4px">waiting for stream</div>
      </div>
    </div>
    <div class="vid-meta">
      <div>res <span id="res-out">—</span></div>
      <div>filter <span id="filter-out">off</span></div>
    </div>
  </div>

  <div class="sidebar">
    <div class="section">
      <div class="section-header">
        <div class="section-title">Image processing</div>
        <div class="section-tag">client</div>
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Brightness</span><span class="ctrl-val" id="bright-val">100%</span></div>
        <input type="range" id="brightness" min="0" max="300" value="100" oninput="updateFilter()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Contrast</span><span class="ctrl-val" id="cont-val">100%</span></div>
        <input type="range" id="contrast" min="0" max="300" value="100" oninput="updateFilter()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Saturation</span><span class="ctrl-val" id="sat-val">100%</span></div>
        <input type="range" id="saturation" min="0" max="300" value="100" oninput="updateFilter()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Gamma</span><span class="ctrl-val" id="gamma-val">1.0</span></div>
        <input type="range" id="gamma" min="20" max="280" value="100" step="5" oninput="updateFilter()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Hue rotate</span><span class="ctrl-val" id="hue-val">0°</span></div>
        <input type="range" id="hue" min="-180" max="180" value="0" oninput="updateFilter()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Sharpen (CSS)</span><span class="ctrl-val" id="csharpen-val">0.0</span></div>
        <input type="range" id="csharpen" min="0" max="10" value="0" step="0.5" oninput="updateFilter()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Edge enhance</span><span class="ctrl-val" id="edge-val">0%</span></div>
        <input type="range" id="edgeboost" min="0" max="100" value="0" oninput="updateFilter()">
      </div>
      <div class="btn-row">
        <button class="btn" onclick="resetFilters()">Reset</button>
        <button class="btn" id="preset-btn" onclick="cyclePreset()">Preset ↻</button>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">Camera</div>
        <div class="section-tag">→ pi</div>
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Exposure (EV)</span><span class="ctrl-val" id="exp-val">0.0</span></div>
        <input type="range" class="pi-ctrl" id="exposure" min="-8" max="8" value="0" step="0.5" oninput="updateCam()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">ISO</span><span class="ctrl-val" id="iso-val">auto</span></div>
        <input type="range" class="pi-ctrl" id="iso" min="0" max="1600" value="0" step="100" oninput="updateCam()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Sharpness</span><span class="ctrl-val" id="sharp-val">1.0</span></div>
        <input type="range" class="pi-ctrl" id="sharpness" min="0" max="16" value="1" step="0.5" oninput="updateCam()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Contrast (cam)</span><span class="ctrl-val" id="camcont-val">1.0</span></div>
        <input type="range" class="pi-ctrl" id="camcontrast" min="0" max="32" value="1" step="0.5" oninput="updateCam()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row"><span class="ctrl-name">Denoise</span><span class="ctrl-val" id="denoise-val">1.00</span></div>
        <input type="range" class="pi-ctrl" id="denoise" min="0" max="4" value="1" step="0.25" oninput="updateCam()">
      </div>
      <div class="ctrl">
        <div class="ctrl-row" style="margin-bottom:8px"><span class="ctrl-name">White balance</span></div>
        <select id="awb" onchange="updateCam()">
          <option value="auto">Auto</option>
          <option value="incandescent">Incandescent</option>
          <option value="tungsten">Tungsten</option>
          <option value="fluorescent">Fluorescent</option>
          <option value="indoor">Indoor</option>
          <option value="daylight">Daylight</option>
          <option value="cloudy">Cloudy</option>
          <option value="custom">Manual</option>
        </select>
      </div>
      <div class="pi-badge">
        <div class="pip" id="ws-dot"></div>
        <span id="ws-label">Pi not connected — controls queued</span>
      </div>
      <div class="btn-row">
        <button class="btn blue" onclick="resetCam()">Reset</button>
        <button class="btn blue" onclick="sendCam()">Send now</button>
      </div>
    </div>

    <div class="section" id="temp-section">
      <div class="section-header">
        <div class="section-title">Temperature</div>
        <div class="section-tag">pi</div>
      </div>
      <div class="temp-display" id="temp-display">—</div>
      <div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:2px">CPU °C</div>
      <div class="temp-bar"><div class="temp-fill" id="temp-fill"></div></div>
    </div>
  </div>
</div>

<script>
const HLS_URL = '/live/live/index.m3u8';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
const video = document.getElementById('video');
const offline = document.getElementById('offline');

const F = { brightness: 100, contrast: 100, saturation: 100, gamma: 100, hue: 0, csharpen: 0, edgeboost: 0 };
const C = { exposure: 0, iso: 0, sharpness: 1, contrast: 1, denoise: 1, awb: 'auto' };
let piConnected = false;
let ws, sendTimer = null;

function startHLS() {
  if (Hls.isSupported()) {
    const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 4, maxLiveSyncPlaybackRate: 1.5 });
    hls.loadSource(HLS_URL); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play(); setStream(true); });
    hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) { setStream(false); setTimeout(startHLS, 4000); } });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = HLS_URL; video.play(); setStream(true);
  }
}

function setStream(live) {
  document.getElementById('stream-dot').className = 'pip' + (live ? ' live' : '');
  document.getElementById('stream-label').textContent = live ? 'live' : 'waiting';
  offline.style.display = live ? 'none' : 'flex';
}

async function waitForStream() {
  try { const d = await (await fetch('/status')).json(); if (d.streaming) { startHLS(); return; } } catch {}
  setTimeout(waitForStream, 3000);
}
waitForStream();

setInterval(() => {
  if (video.readyState >= 2) document.getElementById('res-out').textContent = video.videoWidth + '×' + video.videoHeight;
}, 2000);

function buildFilter() {
  const b = F.brightness, co = F.contrast, sa = F.saturation, hue = F.hue;
  const edge = F.edgeboost / 100, csharpen = F.csharpen, gamma = F.gamma;

  // Gamma approximation via brightness/contrast nudge
  const gVal = gamma / 100;
  let finalB = b, finalC = co;
  if (gVal < 1.0) { finalB = b + (1 - gVal) * 60; finalC = co - (1 - gVal) * 20; }
  else if (gVal > 1.0) { finalB = b - (gVal - 1) * 40; finalC = co + (gVal - 1) * 15; }
  finalB = Math.max(0, finalB); finalC = Math.max(0, finalC);

  if (csharpen > 0) {
    const k = csharpen * 0.12, c = 1 + 8 * k, m = -k;
    document.getElementById('sharpen-matrix').setAttribute('kernelMatrix',
      m+' '+m+' '+m+'  '+m+' '+c+' '+m+'  '+m+' '+m+' '+m);
    video.style.filter = 'brightness('+finalB+'%) contrast('+finalC+'%) saturate('+sa+'%) hue-rotate('+hue+'deg) url(#sharpen-filter)';
  } else if (edge > 0) {
    const blurAmt = Math.max(0.4, 1.6 - edge * 0.8);
    const edgeK = 1 + edge * 2.5;
    document.querySelector('#edge-overlay feGaussianBlur').setAttribute('stdDeviation', blurAmt.toFixed(2));
    document.querySelector('#edge-overlay feComposite').setAttribute('k2', edgeK.toFixed(2));
    video.style.filter = 'brightness('+finalB+'%) contrast('+finalC+'%) saturate('+sa+'%) hue-rotate('+hue+'deg) url(#edge-overlay)';
  } else {
    video.style.filter = 'brightness('+finalB+'%) contrast('+finalC+'%) saturate('+sa+'%) hue-rotate('+hue+'deg)';
  }

  const active = [];
  if (b !== 100 || co !== 100 || sa !== 100) active.push('color');
  if (hue !== 0) active.push('hue');
  if (csharpen > 0) active.push('sharpen');
  if (edge > 0) active.push('edges');
  if (gamma !== 100) active.push('gamma');
  document.getElementById('filter-out').textContent = active.length ? active.join(' ') : 'off';
}

function updateFilter() {
  F.brightness = parseInt(document.getElementById('brightness').value);
  F.contrast = parseInt(document.getElementById('contrast').value);
  F.saturation = parseInt(document.getElementById('saturation').value);
  F.gamma = parseInt(document.getElementById('gamma').value);
  F.hue = parseInt(document.getElementById('hue').value);
  F.csharpen = parseFloat(document.getElementById('csharpen').value);
  F.edgeboost = parseInt(document.getElementById('edgeboost').value);

  document.getElementById('bright-val').textContent = F.brightness + '%';
  document.getElementById('cont-val').textContent = F.contrast + '%';
  document.getElementById('sat-val').textContent = F.saturation + '%';
  document.getElementById('gamma-val').textContent = (F.gamma / 100).toFixed(1);
  document.getElementById('hue-val').textContent = F.hue + '°';
  document.getElementById('csharpen-val').textContent = F.csharpen.toFixed(1);
  document.getElementById('edge-val').textContent = F.edgeboost + '%';

  ['brightness','contrast','saturation','hue','csharpen','edgeboost'].forEach(id => updateTrack(document.getElementById(id)));
  updateTrack(document.getElementById('gamma'), 20, 280);
  buildFilter();
}

function resetFilters() {
  ['brightness','contrast','saturation'].forEach(id => document.getElementById(id).value = 100);
  document.getElementById('gamma').value = 100;
  document.getElementById('hue').value = 0;
  document.getElementById('csharpen').value = 0;
  document.getElementById('edgeboost').value = 0;
  updateFilter();
}

const PRESETS = [
  { name:'vivid',  brightness:110, contrast:130, saturation:140, gamma:90,  hue:0, csharpen:2, edgeboost:0  },
  { name:'flat',   brightness:90,  contrast:80,  saturation:70,  gamma:120, hue:0, csharpen:0, edgeboost:0  },
  { name:'night',  brightness:130, contrast:115, saturation:60,  gamma:80,  hue:0, csharpen:0, edgeboost:0  },
  { name:'detail', brightness:100, contrast:120, saturation:100, gamma:100, hue:0, csharpen:5, edgeboost:50 },
  { name:'↻',      brightness:100, contrast:100, saturation:100, gamma:100, hue:0, csharpen:0, edgeboost:0  },
];
let presetIdx = 4;
function cyclePreset() {
  presetIdx = (presetIdx + 1) % PRESETS.length;
  const p = PRESETS[presetIdx];
  Object.keys(p).forEach(k => { if (k !== 'name') document.getElementById(k === 'brightness' ? 'brightness' : k === 'contrast' ? 'contrast' : k === 'saturation' ? 'saturation' : k === 'gamma' ? 'gamma' : k === 'hue' ? 'hue' : k === 'csharpen' ? 'csharpen' : 'edgeboost').value = p[k]; });
  document.getElementById('brightness').value = p.brightness;
  document.getElementById('contrast').value = p.contrast;
  document.getElementById('saturation').value = p.saturation;
  document.getElementById('gamma').value = p.gamma;
  document.getElementById('hue').value = p.hue;
  document.getElementById('csharpen').value = p.csharpen;
  document.getElementById('edgeboost').value = p.edgeboost;
  updateFilter();
  document.getElementById('preset-btn').textContent = p.name + ' ↻';
}

function updateCam() {
  C.exposure = parseFloat(document.getElementById('exposure').value);
  C.iso = parseInt(document.getElementById('iso').value);
  C.sharpness = parseFloat(document.getElementById('sharpness').value);
  C.contrast = parseFloat(document.getElementById('camcontrast').value);
  C.denoise = parseFloat(document.getElementById('denoise').value);
  C.awb = document.getElementById('awb').value;

  document.getElementById('exp-val').textContent = (C.exposure >= 0 ? '+' : '') + C.exposure.toFixed(1);
  document.getElementById('iso-val').textContent = C.iso === 0 ? 'auto' : C.iso.toString();
  document.getElementById('sharp-val').textContent = C.sharpness.toFixed(1);
  document.getElementById('camcont-val').textContent = C.contrast.toFixed(1);
  document.getElementById('denoise-val').textContent = C.denoise.toFixed(2);

  updateTrack(document.getElementById('exposure'), -8, 8);
  updateTrack(document.getElementById('iso'), 0, 1600);
  updateTrack(document.getElementById('sharpness'), 0, 16);
  updateTrack(document.getElementById('camcontrast'), 0, 32);
  updateTrack(document.getElementById('denoise'), 0, 4);

  clearTimeout(sendTimer);
  sendTimer = setTimeout(sendCam, 150);
}

function sendCam() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'control', ...C }));
}

function resetCam() {
  document.getElementById('exposure').value = 0;
  document.getElementById('iso').value = 0;
  document.getElementById('sharpness').value = 1;
  document.getElementById('camcontrast').value = 1;
  document.getElementById('denoise').value = 1;
  document.getElementById('awb').value = 'auto';
  updateCam();
}

function updateTrack(el, min, max) {
  const mn = min !== undefined ? min : parseFloat(el.min);
  const mx = max !== undefined ? max : parseFloat(el.max);
  el.style.setProperty('--pct', ((parseFloat(el.value) - mn) / (mx - mn) * 100).toFixed(1) + '%');
}

document.querySelectorAll('input[type=range]').forEach(el => updateTrack(el));

function setPiStatus(on) {
  piConnected = on;
  document.getElementById('ws-dot').className = on ? 'pip on' : 'pip';
  document.getElementById('ws-label').textContent = on ? 'Pi connected' : 'Pi not connected — controls queued';
  document.getElementById('pi-dot').className = on ? 'pip on' : 'pip';
  document.getElementById('pi-label').textContent = on ? 'pi online' : 'pi offline';
  document.getElementById('temp-badge').style.display = on ? 'flex' : 'none';
}

function setTemp(val) {
  const t = parseFloat(val);
  const color = t >= 80 ? 'var(--danger)' : t >= 65 ? 'var(--warn)' : 'var(--text2)';
  document.getElementById('temp-display').textContent = t.toFixed(1) + '°';
  document.getElementById('temp-display').style.color = color;
  document.getElementById('temp-badge-val').textContent = t.toFixed(1) + '°C';
  document.getElementById('temp-dot').className = t >= 65 ? 'pip warn' : 'pip on';
  const fill = document.getElementById('temp-fill');
  fill.style.width = Math.min(100, t) + '%';
  fill.style.background = t >= 80 ? 'var(--danger)' : t >= 65 ? 'var(--warn)' : 'var(--online)';
}

function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'identify', role: 'browser' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'pi_connected' || (msg.type === 'pi_status' && msg.connected)) setPiStatus(true);
    if (msg.type === 'pi_disconnected' || (msg.type === 'pi_status' && !msg.connected)) setPiStatus(false);
    if (msg.type === 'temp') setTemp(msg.value);
    if (msg.type === 'cam_state') {
      if (msg.exposure !== undefined) document.getElementById('exposure').value = msg.exposure;
      if (msg.iso !== undefined) document.getElementById('iso').value = msg.iso;
      if (msg.sharpness !== undefined) document.getElementById('sharpness').value = msg.sharpness;
      if (msg.contrast !== undefined) document.getElementById('camcontrast').value = msg.contrast;
      if (msg.denoise !== undefined) document.getElementById('denoise').value = msg.denoise;
      if (msg.awb !== undefined) document.getElementById('awb').value = msg.awb;
      updateCam();
    }
  };
  ws.onclose = () => { setPiStatus(false); setTimeout(connectWS, 3000); };
}
connectWS();
<\/script>
</body>
</html>\`;
