/* ═══════════════════════════════════════════════════════
   NetPulse script.js v5
   FIXED: GPS display · Table rendering (object-based rows)
   NEW: Signal velocity · Trend detection · Particle FX
        Connection status bar · Better map no-GPS handling
        Automate app guide in GPS status
   Backend now returns OBJECTS: {id,signal,network,operator,time,lat,lng,device_id}
═══════════════════════════════════════════════════════ */
'use strict';

/* ── CONFIG ──────────────────────────────────────── */
let ALERT_THRESHOLD = 30;
let REFRESH_MS      = 2000;
let SOUND_ON        = false;
let MAX_ROWS        = 50;
let refreshTimer    = null;

/* ── STATE ───────────────────────────────────────── */
let lineChart = null, barChart = null, donutChart = null, histChart = null;
let mapInst   = null, mapMarkers = [];
let chartRange = 'all';
let allData    = [];
let filtered   = [];
let alertLog   = [], alertCount = 0, lastAlertSignal = null;
let isDark     = true;
let deviceFilter = 'all';
let dateFrom   = null, dateTo = null;
let knownDevices = new Set();
let prevSignal = null;

/* ══ CLOCK ══════════════════════════════════════════ */
function tickClock() {
  const n = new Date();
  setText('clock-time', n.toLocaleTimeString('en-GB', {hour12:false}));
  setText('clock-date', n.toLocaleDateString('en-GB', {weekday:'short',day:'2-digit',month:'short',year:'numeric'}));
}
tickClock(); setInterval(tickClock, 1000);

/* ══ PARTICLES ══════════════════════════════════════ */
(function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);
  for (let i = 0; i < 60; i++) {
    particles.push({
      x: Math.random()*1920, y: Math.random()*1080,
      vx: (Math.random()-.5)*0.3, vy: (Math.random()-.5)*0.3,
      r: Math.random()*1.5+0.3, a: Math.random()*0.4+0.05
    });
  }
  function draw() {
    ctx.clearRect(0,0,W,H);
    const accent = isDark ? '0,229,255' : '0,100,200';
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = `rgba(${accent},${p.a})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

/* ══ THEME ══════════════════════════════════════════ */
function applyTheme(dark) {
  isDark = dark;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  setText('theme-icon', dark ? '☀' : '🌙');
  setText('theme-label-big', dark ? '🌙 Dark' : '☀ Light');
  if (filtered.length) rebuildCharts();
}
document.getElementById('theme-toggle')?.addEventListener('click', () => applyTheme(!isDark));
document.getElementById('theme-toggle-big')?.addEventListener('click', () => applyTheme(!isDark));

/* ══ MODALS ═════════════════════════════════════════ */
const openModal  = id => document.getElementById(id)?.classList.add('open');
const closeModal = id => document.getElementById(id)?.classList.remove('open');

document.getElementById('nav-analytics')?.addEventListener('click',  () => { openModal('analytics-backdrop'); updateAnalytics(); });
document.getElementById('analytics-close')?.addEventListener('click', () => closeModal('analytics-backdrop'));
document.getElementById('analytics-backdrop')?.addEventListener('click', e => { if(e.target.id==='analytics-backdrop') closeModal('analytics-backdrop'); });

document.getElementById('nav-settings')?.addEventListener('click',  () => openModal('settings-backdrop'));
document.getElementById('settings-close')?.addEventListener('click', () => closeModal('settings-backdrop'));
document.getElementById('settings-backdrop')?.addEventListener('click', e => { if(e.target.id==='settings-backdrop') closeModal('settings-backdrop'); });

/* ── Save Settings ── */
document.getElementById('btn-save-settings')?.addEventListener('click', () => {
  const thr = parseInt(document.getElementById('setting-threshold').value);
  const ref = parseInt(document.getElementById('setting-refresh').value);
  const rows= parseInt(document.getElementById('setting-rows').value);
  SOUND_ON = document.getElementById('setting-sound').checked;

  if (!isNaN(thr) && thr >= 0 && thr <= 100) {
    ALERT_THRESHOLD = thr;
    setText('stat-drops-cap', `Below ${thr}%`);
  }
  if (!isNaN(ref)) {
    REFRESH_MS = ref;
    clearInterval(refreshTimer);
    refreshTimer = setInterval(loadData, REFRESH_MS);
    setText('footer-interval', (ref/1000)+'s');
  }
  if (!isNaN(rows)) MAX_ROWS = rows;
  closeModal('settings-backdrop');
  flashToast('Settings saved ✓', 'success');
});

/* ══ ANALYTICS MODAL ════════════════════════════════ */
function updateAnalytics() {
  if (!filtered.length) return;
  const vals = filtered.map(r => r.signal);
  const sorted = [...vals].sort((a,b) => a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  const mean   = vals.reduce((a,b)=>a+b,0)/vals.length;
  const stddev = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length);

  const buckets = Array.from({length:24},()=>[]);
  filtered.forEach(r => {
    const t = parseTime(r.time);
    if (!isNaN(t)) buckets[t.getHours()].push(r.signal);
  });
  const hourAvgs = buckets.map((b,h) => b.length ? {h,avg:b.reduce((a,c)=>a+c,0)/b.length} : null).filter(Boolean);
  const bestH  = hourAvgs.length ? hourAvgs.reduce((a,b) => b.avg>a.avg?b:a) : null;
  const worstH = hourAvgs.length ? hourAvgs.reduce((a,b) => b.avg<a.avg?b:a) : null;

  setText('an-best-hour',  bestH  ? `${String(bestH.h).padStart(2,'0')}:00 · ${bestH.avg.toFixed(1)}%`  : '—');
  setText('an-worst-hour', worstH ? `${String(worstH.h).padStart(2,'0')}:00 · ${worstH.avg.toFixed(1)}%` : '—');
  setText('an-stddev',   stddev.toFixed(2) + ' σ');
  setText('an-median',   median.toFixed(1) + '%');
  setText('an-excellent', vals.filter(v=>v>75).length);
  setText('an-poor',      vals.filter(v=>v<=30).length);
  buildHistogram(vals);
}

function buildHistogram(vals) {
  const ctx = document.getElementById('histogram-chart');
  if (!ctx) return;
  if (histChart) { histChart.destroy(); histChart = null; }
  const bins   = Array(10).fill(0);
  const labels = ['0–10','10–20','20–30','30–40','40–50','50–60','60–70','70–80','80–90','90–100'];
  vals.forEach(v => bins[Math.min(Math.floor(v/10),9)]++);
  const colors = labels.map((_,i) => getGrade(i*10+5).hex+'cc');
  histChart = new Chart(ctx, {
    type:'bar',
    data:{labels,datasets:[{data:bins,backgroundColor:colors,borderRadius:5,borderWidth:0}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:400},
      plugins:{legend:{display:false},tooltip:tooltipOpts({callbacks:{label:c=>` ${c.parsed.y} readings`}})},
      scales:{
        x:{grid:{display:false},ticks:{color:'#344e6e',font:{family:'Space Mono',size:9}},border:{display:false}},
        y:{grid:{color:gridColor()},ticks:{color:'#344e6e',font:{family:'Space Mono',size:9},maxTicksLimit:5},border:{display:false}}
      }
    }
  });
}

/* ══ DATE FILTER ════════════════════════════════════ */
document.getElementById('btn-date-apply')?.addEventListener('click', () => {
  const fv = document.getElementById('date-from').value;
  const tv = document.getElementById('date-to').value;
  dateFrom = fv ? new Date(fv) : null;
  dateTo   = tv ? new Date(tv) : null;
  const filterBar = document.getElementById('filter-bar');
  if (dateFrom || dateTo) {
    filterBar.style.display = 'flex';
    const fs = dateFrom ? dateFrom.toLocaleString('en-GB',{hour12:false}) : '—';
    const ts = dateTo   ? dateTo.toLocaleString('en-GB',{hour12:false})   : 'Now';
    setText('filter-bar-text', `Filtered: ${fs} → ${ts}`);
    setText('filter-status', `✓ Applied · ${fs} → ${ts}`);
  } else {
    filterBar.style.display = 'none';
    setText('filter-status','');
  }
  applyFilters();
  closeModal('analytics-backdrop');
});
document.getElementById('btn-date-clear')?.addEventListener('click', clearDateFilter);
document.getElementById('filter-bar-clear')?.addEventListener('click', clearDateFilter);
function clearDateFilter() {
  document.getElementById('date-from').value = '';
  document.getElementById('date-to').value   = '';
  dateFrom = null; dateTo = null;
  document.getElementById('filter-bar').style.display = 'none';
  setText('filter-status','');
  applyFilters();
}

/* ══ TOAST ══════════════════════════════════════════ */
const toastEl = document.getElementById('alert-toast');
let toastTimer = null;

function flashToast(msg, type='error') {
  const isSuccess = type === 'success';
  const color = isSuccess ? 'var(--green)' : 'var(--red)';
  document.getElementById('alert-msg').textContent = msg;
  if (isSuccess) {
    document.querySelector('.toast-title').textContent = 'NOTIFICATION';
    toastEl.style.borderColor = color;
    document.querySelector('.toast-bar').style.background = color;
  } else {
    document.querySelector('.toast-title').textContent = 'SIGNAL ALERT';
    toastEl.style.borderColor = '';
    document.querySelector('.toast-bar').style.background = '';
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.style.borderColor = '';
    document.querySelector('.toast-bar').style.background = '';
    document.querySelector('.toast-title').textContent = 'SIGNAL ALERT';
  }, isSuccess ? 2500 : 5500);
  if (!isSuccess && SOUND_ON) {
    try {
      const ac = new AudioContext(), osc = ac.createOscillator(), g = ac.createGain();
      osc.connect(g); g.connect(ac.destination);
      osc.frequency.value = 880; g.gain.value = 0.1;
      osc.start(); osc.stop(ac.currentTime + 0.25);
    } catch(e) {}
  }
}
document.getElementById('alert-close')?.addEventListener('click', () => toastEl.classList.remove('show'));

/* ══ ALERTS ═════════════════════════════════════════ */
function addAlertEntry(signal, time) {
  alertLog.unshift({signal, time}); alertCount++;
  const badge = document.getElementById('alert-badge');
  badge.textContent = alertCount; badge.style.display = 'inline';
  const list = document.getElementById('alert-list');
  list.querySelector('.alert-empty')?.remove();
  const li = document.createElement('li');
  li.className = 'alert-entry';
  li.innerHTML = `<div class="alert-entry-val">⚡ ${signal.toFixed(1)}% — Below ${ALERT_THRESHOLD}%</div><div class="alert-entry-time">${time}</div>`;
  list.prepend(li);
}
function checkAlert(signal, time) {
  if (signal < ALERT_THRESHOLD && (lastAlertSignal === null || lastAlertSignal >= ALERT_THRESHOLD)) {
    flashToast(`Signal at ${signal.toFixed(1)}% — below ${ALERT_THRESHOLD}%`);
    addAlertEntry(signal, time);
  }
  lastAlertSignal = signal;
}

document.getElementById('nav-alerts-btn')?.addEventListener('click', () => {
  document.getElementById('alert-drawer').classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('show');
  alertCount = 0;
  document.getElementById('alert-badge').style.display = 'none';
});
function closeDrawer() {
  document.getElementById('alert-drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('show');
}
document.getElementById('drawer-close')?.addEventListener('click', closeDrawer);
document.getElementById('drawer-backdrop')?.addEventListener('click', closeDrawer);
document.getElementById('btn-clear-alerts')?.addEventListener('click', () => {
  alertLog = []; alertCount = 0;
  document.getElementById('alert-list').innerHTML = '<li class="alert-empty">No alerts yet</li>';
  document.getElementById('alert-badge').style.display = 'none';
});

/* ══ DEVICE DROPDOWN ════════════════════════════════ */
function updateDeviceDropdown(data) {
  const sel = document.getElementById('device-select');
  const cur = sel.value;
  data.forEach(r => { if(r.device_id) knownDevices.add(r.device_id); });
  sel.innerHTML = '<option value="all">All Devices</option>';
  [...knownDevices].sort().forEach(d => {
    const o = document.createElement('option');
    o.value = d; o.textContent = d; sel.appendChild(o);
  });
  sel.value = knownDevices.has(cur) ? cur : 'all';
}
document.getElementById('device-select')?.addEventListener('change', e => {
  deviceFilter = e.target.value; applyFilters();
});

/* ══ FILTERS ════════════════════════════════════════ */
function applyFilters() {
  filtered = allData.filter(r => {
    if (deviceFilter !== 'all' && r.device_id !== deviceFilter) return false;
    if (dateFrom || dateTo) {
      const t = parseTime(r.time);
      if (dateFrom && t < dateFrom) return false;
      if (dateTo   && t > dateTo)   return false;
    }
    return true;
  });
  renderAll(filtered);
}

/* ══ GRADE HELPER ═══════════════════════════════════ */
function getGrade(val) {
  if (val > 75) return {label:'Excellent', color:'var(--green)',  hex:'#39ff87'};
  if (val > 50) return {label:'Good',      color:'var(--yellow)', hex:'#ffd740'};
  if (val > 30) return {label:'Weak',      color:'var(--orange)', hex:'#ff8c00'};
  return               {label:'Poor',      color:'var(--red)',    hex:'#ff2d55'};
}

/* ══ GAUGE ══════════════════════════════════════════ */
const GAUGE_LEN = 276;
function updateGauge(val) {
  const arc    = document.getElementById('gauge-arc');
  const pct    = document.getElementById('gauge-pct');
  const needle = document.getElementById('gauge-needle');
  if (!arc) return;
  arc.style.strokeDashoffset = GAUGE_LEN - (val/100)*GAUGE_LEN;
  pct.textContent = Math.round(val)+'%';
  needle.style.transform = `rotate(${-90+(val/100)*180}deg)`;
}

/* ══ SIGNAL BARS (5 bars) ══════════════════════════ */
function updateSigBars(val) {
  ['sb1','sb2','sb3','sb4','sb5'].forEach(id => document.getElementById(id)?.classList.remove('on'));
  if (val > 10) document.getElementById('sb1')?.classList.add('on');
  if (val > 30) document.getElementById('sb2')?.classList.add('on');
  if (val > 50) document.getElementById('sb3')?.classList.add('on');
  if (val > 70) document.getElementById('sb4')?.classList.add('on');
  if (val > 85) document.getElementById('sb5')?.classList.add('on');
}

/* ══ VELOCITY (NEW) ════════════════════════════════ */
function updateVelocity(data) {
  if (data.length < 2) return;
  const recent = data.slice(0,5).map(r=>r.signal);
  const changes = recent.slice(0,-1).map((v,i) => Math.abs(v - recent[i+1]));
  const avg = changes.length ? changes.reduce((a,b)=>a+b,0)/changes.length : 0;
  const capped = Math.min(avg, 30);

  const velEl = document.getElementById('vel-val');
  if (velEl) { velEl.textContent = avg.toFixed(1); velEl.classList.remove('flash'); void velEl.offsetWidth; velEl.classList.add('flash'); }
  const bar = document.getElementById('vel-bar');
  if (bar) bar.style.width = (capped/30*100).toFixed(1)+'%';

  // Trend: compare last 3 vs 3 before that
  const trend = document.getElementById('trend-val');
  if (trend && data.length >= 6) {
    const a = data.slice(0,3).reduce((s,r)=>s+r.signal,0)/3;
    const b = data.slice(3,6).reduce((s,r)=>s+r.signal,0)/3;
    const diff = a - b;
    if (diff > 3) {
      trend.textContent = '▲ Improving (+'+diff.toFixed(1)+'%)';
      trend.style.color = 'var(--green)';
    } else if (diff < -3) {
      trend.textContent = '▼ Declining ('+diff.toFixed(1)+'%)';
      trend.style.color = 'var(--red)';
    } else {
      trend.textContent = '→ Stable';
      trend.style.color = 'var(--accent)';
    }
  }
}

/* ══ UPTIME ═════════════════════════════════════════ */
function updateUptime(data) {
  const total = data.length;
  const above = data.filter(r => r.signal >= ALERT_THRESHOLD).length;
  const pct   = total > 0 ? (above/total)*100 : 0;
  setText('stat-uptime', pct.toFixed(1)+'%');
  setText('stat-uptime-cap', `${above}/${total} ≥ ${ALERT_THRESHOLD}%`);
  const arc = document.getElementById('uptime-arc');
  if (arc) {
    arc.setAttribute('stroke-dasharray', `${pct} 100`);
    arc.setAttribute('stroke', pct>70?'#39ff87':pct>40?'#ffd740':'#ff2d55');
  }
}

/* ══ STATS ══════════════════════════════════════════ */
function updateStats(data) {
  if (!data.length) return;
  const vals  = data.map(r => r.signal);
  const cur   = vals[0];
  const valid = vals.filter(v => v >= 0 && v <= 100);
  const peak  = Math.max(...valid);
  const avg   = valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : 0;
  const drops = vals.filter(v => v < ALERT_THRESHOLD).length;

  const el = document.getElementById('stat-current');
  if (el) { el.textContent = cur.toFixed(1)+'%'; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  setText('stat-peak',  peak.toFixed(1)+'%');
  setText('stat-avg',   avg.toFixed(1)+'%');
  setText('stat-drops', drops);
  setText('stat-total', data.length);
  setText('stat-quality-cap', getGrade(cur).label);

  const fill = document.getElementById('stat-bar-fill');
  if (fill) fill.style.width = Math.min(100,Math.max(0,cur)).toFixed(1)+'%';
  updateUptime(data);
}

/* ══ QUALITY CHIP ═══════════════════════════════════ */
function updateQualityChip(val) {
  const chip = document.getElementById('quality-chip');
  if (!chip) return;
  const g = getGrade(val);
  chip.textContent = '● '+g.label;
  chip.style.color = g.color;
}

/* ══ HERO ROW ═══════════════════════════════════════ */
function updateHero(row) {
  const sig = row.signal;
  setText('info-device',   row.device_id || 'Unknown');
  setText('info-network',  row.network   || 'N/A');
  setText('info-operator', row.operator  || 'N/A');
  setText('info-time',     row.time);

  // GPS — FIXED: uses .lat / .lng object fields
  const lat = row.lat, lng = row.lng;
  const hasGps = lat !== null && lat !== undefined && lng !== null && lng !== undefined;

  if (hasGps) {
    setText('info-location', `${parseFloat(lat).toFixed(4)}°N, ${parseFloat(lng).toFixed(4)}°E`);
    setText('info-coords',   `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`);
    const gpsStatus = document.getElementById('gps-status');
    if (gpsStatus) { gpsStatus.textContent = '✓ GPS Active'; gpsStatus.classList.add('active'); }
  } else {
    setText('info-location', 'No GPS signal');
    setText('info-coords',   'Enable location in Automate');
    const gpsStatus = document.getElementById('gps-status');
    if (gpsStatus) { gpsStatus.textContent = 'No GPS'; gpsStatus.classList.remove('active'); }
  }

  updateGauge(sig); updateSigBars(sig); updateQualityChip(sig); checkAlert(sig, row.time);
}

/* ══ HEATMAP ════════════════════════════════════════ */
function buildHeatmap(data) {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;
  const buckets = Array.from({length:24}, () => []);
  data.forEach(r => {
    const t = parseTime(r.time);
    if (!isNaN(t) && r.signal >= 0 && r.signal <= 100)
      buckets[t.getHours()].push(r.signal);
  });
  const hasAny = buckets.some(b=>b.length>0);
  document.getElementById('heatmap-no-data').style.display = hasAny ? 'none' : 'block';
  grid.innerHTML = '';
  buckets.forEach((b,h) => {
    const cell = document.createElement('div');
    cell.className = 'hm-cell';
    if (b.length) {
      const avg = b.reduce((a,c)=>a+c,0)/b.length;
      const g   = getGrade(avg);
      const op  = 0.25+(avg/100)*0.75;
      cell.style.background = g.hex + Math.round(op*255).toString(16).padStart(2,'0');
      cell.setAttribute('data-tip', `${String(h).padStart(2,'0')}:00  avg ${avg.toFixed(1)}%  (${b.length}×)`);
    } else {
      cell.setAttribute('data-tip', `${String(h).padStart(2,'0')}:00  no data`);
    }
    grid.appendChild(cell);
  });
}

/* ══ GPS MAP — FIXED ════════════════════════════════ */
/* ── Tile layer helper — clean CartoDB tiles, no dark distortion ── */
function makeTileLayer() {
  // CartoDB Positron (light, clean, loads fast)
  return L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    { attribution: '© OpenStreetMap · © CARTO', maxZoom: 19, subdomains: 'abcd' }
  );
}

function initMap() {
  if (mapInst) return;
  mapInst = L.map('signal-map', {
    zoomControl: true,
    scrollWheelZoom: true,
    preferCanvas: true     // faster rendering for many markers
  }).setView([13.0827, 80.2707], 12);   // default: Chennai
  makeTileLayer().addTo(mapInst);
  // Fix resize on any window change
  window.addEventListener('resize', () => {
    setTimeout(() => mapInst?.invalidateSize(), 100);
  });
}

function updateMap(data) {
  if (!mapInst) initMap();
  mapMarkers.forEach(m => m.remove()); mapMarkers = [];

  const gps = data.filter(r =>
    r.lat !== null && r.lat !== undefined &&
    r.lng !== null && r.lng !== undefined &&
    !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lng))
  );

  const mapNoGps = document.getElementById('map-no-gps');
  const mapBox   = document.getElementById('signal-map');
  setText('map-point-count', gps.length + ' points');

  if (!gps.length) {
    if (mapNoGps) { mapNoGps.style.display = 'flex'; mapNoGps.style.flexDirection = 'column'; }
    if (mapBox)   mapBox.style.opacity = '0.4';
    return;
  }
  if (mapNoGps) mapNoGps.style.display = 'none';
  if (mapBox)   mapBox.style.opacity = '1';

  const bounds = [];
  gps.forEach(row => {
    const lat = parseFloat(row.lat), lng = parseFloat(row.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    const val = row.signal, col = getGrade(val).hex;
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:${col};border:3px solid white;
        box-shadow:0 0 10px ${col},0 0 20px ${col}66;
        transition:transform 0.2s;cursor:pointer">
      </div>`,
      iconSize: [16,16], iconAnchor: [8,8]
    });
    const popup = `
      <div style="font-family:'Space Mono',monospace;font-size:11px;line-height:1.9;min-width:180px;padding:2px">
        <div style="font-size:14px;font-weight:700;color:${col};margin-bottom:4px">
          ${val.toFixed(1)}% — ${getGrade(val).label}
        </div>
        📱 <b>${row.device_id||'Unknown'}</b><br>
        🌐 ${row.network||'—'} / ${row.operator||'—'}<br>
        🕐 ${row.time}<br>
        📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}
      </div>`;
    const m = L.marker([lat,lng], {icon})
      .bindPopup(popup, {maxWidth:260})
      .addTo(mapInst);
    mapMarkers.push(m);
    bounds.push([lat,lng]);
  });

  if (bounds.length) {
    // Only auto-fit if we have new unique locations
    mapInst.fitBounds(bounds, {padding:[40,40], maxZoom:16});
    // Fix tile rendering after fitBounds
    setTimeout(() => mapInst.invalidateSize(), 250);
  }
}

/* ══ LINE CHART ═════════════════════════════════════ */
function buildLineChart(data) {
  const ctx = document.getElementById('chart'); if (!ctx) return;
  let slice = [...data].reverse();
  if (chartRange !== 'all') slice = slice.slice(-parseInt(chartRange));
  const labels = slice.map(r => r.time);
  const values = slice.map(r => r.signal);
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  const c2d = ctx.getContext('2d');
  const grad = c2d.createLinearGradient(0,0,0,190);
  grad.addColorStop(0,'rgba(0,229,255,0.22)'); grad.addColorStop(1,'rgba(0,229,255,0)');
  lineChart = new Chart(ctx, {
    type:'line',
    data:{labels, datasets:[
      {label:'Signal',data:values,borderColor:'#00e5ff',borderWidth:2.5,fill:true,backgroundColor:grad,pointRadius:0,pointHoverRadius:5,pointHoverBackgroundColor:'#00e5ff',tension:0.4},
      {label:'Alert',data:values.map(()=>ALERT_THRESHOLD),borderColor:'rgba(255,45,85,0.45)',borderWidth:1.5,borderDash:[6,4],fill:false,pointRadius:0,tension:0},
      {label:'Good',data:values.map(()=>75),borderColor:'rgba(57,255,135,0.2)',borderWidth:1,borderDash:[6,4],fill:false,pointRadius:0,tension:0}
    ]},
    options:{
      animation:{duration:600,easing:'easeInOutQuart'},
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:tooltipOpts({callbacks:{label:c=>c.datasetIndex===0?`  Signal: ${c.parsed.y.toFixed(1)}%`:null}})},
      scales:{
        x:{display:false},
        y:{min:0,max:100,grid:{color:gridColor()},ticks:{color:'#344e6e',font:{family:'Space Mono',size:10},maxTicksLimit:6,callback:v=>v+'%'},border:{display:false}}
      }
    }
  });
}

/* ══ BAR CHART ══════════════════════════════════════ */
function buildBarChart(data) {
  const ctx = document.getElementById('bar-chart'); if (!ctx) return;
  const slice = data.slice(0,10).reverse();
  const values = slice.map(r=>r.signal), colors = values.map(v=>getGrade(v).hex);
  if (barChart) { barChart.destroy(); barChart = null; }
  barChart = new Chart(ctx, {
    type:'bar',
    data:{labels:slice.map((_,i)=>'#'+(i+1)),datasets:[{data:values,backgroundColor:colors.map(c=>c+'99'),borderColor:colors,borderWidth:1.5,borderRadius:4}]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:500},
      plugins:{legend:{display:false},tooltip:tooltipOpts({callbacks:{label:c=>` ${c.parsed.y.toFixed(1)}%`}})},
      scales:{
        x:{grid:{display:false},ticks:{color:'#344e6e',font:{family:'Space Mono',size:9}},border:{display:false}},
        y:{min:0,max:100,grid:{color:gridColor()},ticks:{color:'#344e6e',font:{family:'Space Mono',size:9},callback:v=>v+'%',maxTicksLimit:5},border:{display:false}}
      }
    }
  });
}

/* ══ DONUT ══════════════════════════════════════════ */
function buildDonutChart(data) {
  const ctx = document.getElementById('donut-chart'); if (!ctx) return;
  const counts = {Excellent:0,Good:0,Weak:0,Poor:0};
  data.forEach(r => counts[getGrade(r.signal).label]++);
  const labels = Object.keys(counts), values = Object.values(counts);
  const colors = ['#39ff87','#ffd740','#ff8c00','#ff2d55'];
  if (donutChart) { donutChart.destroy(); donutChart = null; }
  donutChart = new Chart(ctx, {
    type:'doughnut',
    data:{labels,datasets:[{data:values,backgroundColor:colors.map(c=>c+'bb'),borderColor:colors,borderWidth:1.5,hoverOffset:6}]},
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'68%', animation:{duration:600},
      plugins:{legend:{display:false},tooltip:tooltipOpts({callbacks:{label:c=>` ${c.label}: ${c.parsed}`}})}
    }
  });
  const leg = document.getElementById('donut-legend');
  if (leg) leg.innerHTML = labels.map((l,i) => `<div class="leg-item"><span class="leg-dot" style="background:${colors[i]}"></span><span>${l} (${values[i]})</span></div>`).join('');
}

/* ══ TABLE — FIXED ══════════════════════════════════ */
// Now uses OBJECT fields (row.signal, row.lat etc.) not array indices
function buildTable(data) {
  const tbody = document.getElementById('table-body');
  const count = document.getElementById('row-count');
  const empty = document.getElementById('table-empty');
  if (!tbody) return;

  const slice = data.slice(0, MAX_ROWS);
  if (count) count.textContent = `${slice.length} of ${data.length} entries`;

  if (!slice.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = slice.map((row, i) => {
    const g   = getGrade(row.signal);
    // GPS cell
    const hasGps = row.lat !== null && row.lat !== undefined;
    const gpsCell = hasGps
      ? `<span class="gps-tag">📍 ${parseFloat(row.lat).toFixed(3)}, ${parseFloat(row.lng).toFixed(3)}</span>`
      : `<span class="no-gps-tag">—</span>`;

    return `<tr>
      <td>${i+1}</td>
      <td><span class="sig-num" style="color:${g.color}">${parseFloat(row.signal).toFixed(1)}%</span></td>
      <td><span class="grade-pill" style="color:${g.color}">${g.label}</span></td>
      <td>${row.device_id || '—'}</td>
      <td>${row.network   || '—'}</td>
      <td>${row.operator  || '—'}</td>
      <td>${gpsCell}</td>
      <td>${row.time}</td>
    </tr>`;
  }).join('');
}

/* ══ SCROLL TO TOP ══════════════════════════════════ */
document.getElementById('btn-scroll-top')?.addEventListener('click', () => {
  document.getElementById('table-scroll')?.scrollTo({top:0,behavior:'smooth'});
});

/* ══ CHART CONTROLS ═════════════════════════════════ */
document.getElementById('chart-controls')?.addEventListener('click', e => {
  const btn = e.target.closest('.cbtn'); if (!btn) return;
  document.querySelectorAll('.cbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  chartRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range);
  if (filtered.length) buildLineChart(filtered);
});

/* ══ CSV EXPORT ═════════════════════════════════════ */
document.getElementById('btn-export')?.addEventListener('click', () => {
  if (!filtered.length) return;
  const h = ['#','Signal (%)','Grade','Device','Network','Operator','Latitude','Longitude','Timestamp'];
  const rows = filtered.map((row,i) => {
    const g = getGrade(row.signal);
    return [i+1, parseFloat(row.signal).toFixed(1), g.label,
      row.device_id||'', row.network||'', row.operator||'',
      row.lat||'', row.lng||'', row.time];
  });
  const csv = [h,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  a.download = `netpulse_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
});

/* ══ REBUILD ALL CHARTS ═════════════════════════════ */
function rebuildCharts() {
  buildLineChart(filtered);
  buildBarChart(filtered);
  buildDonutChart(filtered);
}

/* ══ RENDER ALL ═════════════════════════════════════ */
function renderAll(data) {
  if (!data.length) {
    document.getElementById('table-empty').style.display = 'block';
    return;
  }
  updateHero(data[0]);
  updateStats(data);
  updateVelocity(data);
  rebuildCharts();
  buildHeatmap(data);
  updateMap(data);
  buildTable(data);
  setText('footer-status', 'Updated: '+new Date().toLocaleTimeString('en-GB',{hour12:false}));
}

/* ══ CONNECTION STATUS ══════════════════════════════ */
function setConnStatus(ok, detail='') {
  const bar  = document.getElementById('conn-bar');
  const icon = document.getElementById('conn-icon');
  const text = document.getElementById('conn-text');
  const dEl  = document.getElementById('conn-detail');
  if (!bar) return;
  if (ok) {
    bar.classList.remove('error');
    icon.textContent = '◉';
    text.textContent = 'Connected · Receiving data live';
    icon.style.color = 'var(--green)';
  } else {
    bar.classList.add('error');
    icon.textContent = '⊗';
    text.textContent = 'Connection error — retrying…';
    icon.style.color = 'var(--red)';
  }
  if (dEl) dEl.textContent = detail;
}

/* ══ MAIN FETCH ═════════════════════════════════════ */
function loadData() {
  fetch('/signals')
    .then(res => { if(!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
    .then(data => {
      if (!Array.isArray(data)) return;
      if (!data.length) {
        setConnStatus(true, 'No readings yet — POST data to /signal');
        document.getElementById('table-empty').style.display = 'block';
        return;
      }
      setConnStatus(true, `${data.length} readings`);
      allData = data;
      updateDeviceDropdown(data);
      applyFilters();
    })
    .catch(err => {
      console.warn('[NetPulse]', err);
      setConnStatus(false, err.message);
      setText('footer-status', '⚠ Error — '+new Date().toLocaleTimeString('en-GB',{hour12:false}));
    });
}

/* ══ HELPERS ════════════════════════════════════════ */
function setText(id, val) {
  const el = document.getElementById(id); if (el) el.textContent = val;
}
function parseTime(str) {
  return new Date(str && str.replace ? str.replace(' ','T') : str);
}
function gridColor() {
  return isDark ? 'rgba(21,35,64,0.8)' : 'rgba(190,210,230,0.5)';
}
function tooltipOpts(extra={}) {
  return {
    backgroundColor: isDark ? '#0a1628':'#fff',
    borderColor: isDark ? '#1e3356':'#c8d8f0',
    borderWidth: 1,
    titleColor: '#344e6e',
    bodyColor: isDark ? '#cfe2ff':'#0a1628',
    padding: 10,
    titleFont: {family:'Space Mono',size:10},
    bodyFont:  {family:'Space Mono',size:11},
    ...extra
  };
}

/* ══ INIT ═══════════════════════════════════════════ */
initMap();
loadData();
refreshTimer = setInterval(loadData, REFRESH_MS);

/* ══════════════════════════════════════════════════════
   NetPulse EXTRA FEATURES v3.0
   ML Prediction · Dead Zones · Quality Score · Network Summary
══════════════════════════════════════════════════════ */

/* ── ML PREDICTION ──────────────────────────────────── */
let mlChart = null;

document.getElementById('btn-predict')?.addEventListener('click', runPrediction);

async function runPrediction() {
  const btn = document.getElementById('btn-predict');
  const statusEl = document.getElementById('ml-status');
  btn.disabled = true;
  btn.textContent = '⟳ Running…';
  setText('ml-status', 'Running Polynomial Regression model…');

  try {
    const res  = await fetch('/predict?steps=15');
    const data = await res.json();
    if (data.error) {
      setText('ml-status', '⚠ ' + data.error);
      btn.disabled = false; btn.textContent = '▶ Predict';
      return;
    }

    // Meta
    const trendColor = data.trend==='improving' ? 'var(--green)' :
                       data.trend==='declining'  ? 'var(--red)'   : 'var(--accent)';
    const trendIcon  = data.trend==='improving' ? '▲' : data.trend==='declining' ? '▼' : '→';
    const tEl = document.getElementById('ml-trend');
    if (tEl) { tEl.textContent = trendIcon+' '+data.trend; tEl.style.color = trendColor; }
    setText('ml-r2',      (data.confidence_r2*100).toFixed(1)+'%');
    setText('ml-cur-avg', data.current_avg.toFixed(1)+'%');
    setText('ml-next',    data.predictions[0].toFixed(1)+'%');

    // Build chart: last 20 actual + 15 predicted
    const actualVals = filtered.slice(0,20).map(r=>r.signal).reverse();
    const labels     = [
      ...actualVals.map((_,i) => 'T-'+(actualVals.length-i)),
      ...data.predictions.map((_,i) => 'T+'+(i+1))
    ];
    const actualData = [...actualVals, ...new Array(data.predictions.length).fill(null)];
    const predData   = [...new Array(actualVals.length).fill(null), ...data.predictions];

    const ctx = document.getElementById('ml-chart');
    if (!ctx) return;
    if (mlChart) { mlChart.destroy(); mlChart = null; }

    const c2d   = ctx.getContext('2d');
    const grad1 = c2d.createLinearGradient(0,0,0,150);
    grad1.addColorStop(0,'rgba(0,229,255,0.18)');
    grad1.addColorStop(1,'rgba(0,229,255,0)');
    const grad2 = c2d.createLinearGradient(0,0,0,150);
    grad2.addColorStop(0,'rgba(191,90,242,0.18)');
    grad2.addColorStop(1,'rgba(191,90,242,0)');

    mlChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [
        { label:'Actual', data:actualData, borderColor:'#00e5ff', borderWidth:2,
          fill:true, backgroundColor:grad1, pointRadius:2, pointHoverRadius:5,
          tension:0.4, spanGaps:false },
        { label:'Predicted', data:predData, borderColor:'#bf5af2', borderWidth:2,
          borderDash:[5,4], fill:true, backgroundColor:grad2,
          pointRadius:3, pointHoverRadius:5, tension:0.4, spanGaps:false }
      ]},
      options:{
        responsive:true, maintainAspectRatio:false, animation:{duration:700},
        plugins:{
          legend:{
            display:true,
            labels:{color:isDark?'#7a96b8':'#4a6888',
              font:{family:'Space Mono',size:9},
              boxWidth:12, padding:12}
          },
          tooltip:tooltipOpts({callbacks:{label:c=>` ${c.dataset.label}: ${c.parsed.y?.toFixed(1)}%`}})
        },
        scales:{
          x:{display:false},
          y:{min:0,max:100,grid:{color:gridColor()},
            ticks:{color:'#344e6e',font:{family:'Space Mono',size:9},callback:v=>v+'%'},
            border:{display:false}}
        }
      }
    });

    setText('ml-status', `✓ Model trained on ${data.based_on} readings · R²=${data.confidence_r2}`);
  } catch(e) {
    setText('ml-status', '⚠ Prediction failed — need more data');
  }
  btn.disabled = false; btn.textContent = '▶ Predict';
}

/* ── QUALITY SCORE ──────────────────────────────────── */
async function loadQualityScore() {
  try {
    const res  = await fetch('/quality_score?limit=20');
    const data = await res.json();
    if (!data.history?.length) return;

    const avg   = data.avg_score;
    const arc   = document.getElementById('qs-arc');
    const valEl = document.getElementById('qs-val');
    const grEl  = document.getElementById('qs-grade');
    if (!arc) return;

    // Ring (circumference = 2π×50 = 314.16)
    const pct   = avg/100;
    const color = avg>75?'#39ff87':avg>55?'#ffd740':avg>35?'#ff8c00':'#ff2d55';
    arc.setAttribute('stroke-dasharray', `${pct*314} 314`);
    arc.setAttribute('stroke', color);
    if (valEl) { valEl.textContent = Math.round(avg); valEl.style.fill = color; }
    if (grEl)  grEl.textContent = data.grade.toUpperCase();

    // Breakdown bars from latest reading
    if (data.history?.length) {
      const last   = data.history[0];
      const sig    = last.signal || 0;
      const qs     = last.quality_score || 0;
      // Estimate stability as difference between qs and signal contribution
      const sigContrib  = sig * 0.6;
      const remaining   = Math.max(0, qs - sigContrib);
      const stabContrib = Math.min(remaining/0.3, 100);
      const upContrib   = 80; // approximate

      setBar('qs-signal-bar',  'qs-signal-pct',  sig,        sig.toFixed(1)+'%');
      setBar('qs-stab-bar',    'qs-stab-pct',    stabContrib, stabContrib.toFixed(1)+'%');
      setBar('qs-uptime-bar',  'qs-uptime-pct',  upContrib,   upContrib.toFixed(1)+'%');
    }
  } catch(e) {}
}

function setBar(barId, pctId, value, label) {
  const bar = document.getElementById(barId);
  const pct = document.getElementById(pctId);
  if (bar) bar.style.width = Math.min(100,Math.max(0,value)).toFixed(1)+'%';
  if (pct) pct.textContent = label;
}

/* ── DEAD ZONE MAP ──────────────────────────────────── */
let dzMap = null, dzLayers = [];

function initDzMap() {
  if (dzMap) return;
  dzMap = L.map("dz-map", {
    zoomControl: true, scrollWheelZoom: true, preferCanvas: true
  }).setView([13.0827, 80.2707], 13);
  makeTileLayer().addTo(dzMap);
  window.addEventListener("resize", () => { setTimeout(() => dzMap?.invalidateSize(), 100); });
}

document.getElementById('btn-dz')?.addEventListener('click', loadDeadZones);

async function loadDeadZones() {
  initDzMap();
  const btn = document.getElementById('btn-dz');
  btn.textContent = '⟳ Scanning…';

  try {
    const res  = await fetch('/deadzones?threshold=35');
    const data = await res.json();

    // Clear old layers
    dzLayers.forEach(l => l.remove()); dzLayers = [];

    setText('dz-dead',     data.dead_zone_count);
    setText('dz-good',     data.good_zones?.length || 0);
    setText('dz-coverage', (data.coverage_pct||0)+'%');
    setText('dz-points',   data.total_gps_points);
    setText('dz-count',    data.dead_zone_count+' dead zones');

    const bounds = [];

    // Plot dead zones — red circles
    (data.dead_zones||[]).forEach(z => {
      const color = z.severity==='critical' ? '#ff2d55' : '#ff8c00';
      const c = L.circle([z.lat, z.lng], {
        radius: 80, color, fillColor: color,
        fillOpacity: 0.4, weight: 2
      }).bindPopup(`
        <div style="font-family:'Space Mono',monospace;font-size:11px;line-height:1.8">
          <b style="color:${color}">☠ Dead Zone — ${z.severity?.toUpperCase()}</b><br>
          Avg Signal: ${z.avg_signal}%<br>
          Readings: ${z.readings}<br>
          Range: ${z.min_signal}% – ${z.max_signal}%
        </div>`).addTo(dzMap);
      dzLayers.push(c);
      bounds.push([z.lat, z.lng]);
    });

    // Plot good zones — green dots
    (data.good_zones||[]).forEach(z => {
      const c = L.circle([z.lat, z.lng], {
        radius: 40, color:'#39ff87', fillColor:'#39ff87',
        fillOpacity: 0.25, weight: 1
      }).bindPopup(`
        <div style="font-family:'Space Mono',monospace;font-size:11px;line-height:1.8">
          <b style="color:#39ff87">✓ Good Zone</b><br>
          Avg Signal: ${z.avg_signal}%<br>
          Readings: ${z.readings}
        </div>`).addTo(dzMap);
      dzLayers.push(c);
      bounds.push([z.lat, z.lng]);
    });

    if (bounds.length) {
      dzMap.fitBounds(bounds, {padding:[40,40], maxZoom:16});
      setTimeout(() => { dzMap.invalidateSize(); dzMap.invalidateSize(); }, 300);
    }
  } catch(e) {
    console.warn('Dead zone scan failed', e);
  }
  btn.textContent = '↻ Rescan';
}

/* ── NETWORK SUMMARY ────────────────────────────────── */
async function loadNetworkSummary() {
  try {
    const res  = await fetch('/network_summary');
    const data = await res.json();
    renderNsList('ns-operators', data.by_operator, 'avg_sig', 'avg_q');
    renderNsList('ns-networks',  data.by_network,  'avg_sig', null);
  } catch(e) {}
}

function renderNsList(containerId, items, sigKey, qualKey) {
  const el = document.getElementById(containerId);
  if (!el || !items?.length) {
    if (el) el.innerHTML = '<div style="font-family:var(--font-m);font-size:0.6rem;color:var(--muted);padding:8px">No data yet</div>';
    return;
  }
  const max = Math.max(...items.map(i=>i[sigKey]||0));
  el.innerHTML = items.slice(0,4).map((item,idx)=>{
    const sig   = item[sigKey] || 0;
    const g     = getGrade(sig);
    const name  = item.operator || item.network || 'Unknown';
    return `<div class="ns-item">
      <span class="ns-rank">${idx+1}</span>
      <span class="ns-name">${name}</span>
      <div class="ns-bar-wrap">
        <div class="ns-bar-bg">
          <div class="ns-bar-fill" style="width:${(sig/max*100).toFixed(1)}%"></div>
        </div>
      </div>
      <span class="ns-avg" style="color:${g.color}">${sig.toFixed(1)}%</span>
      <span class="ns-count">${item.count}×</span>
    </div>`;
  }).join('');
}

/* ── HOOK INTO MAIN RENDER ──────────────────────────── */
// Extend renderAll to also load new features
const _origRenderAll = renderAll;
// Override renderAll to include new panels
window.renderAll = function(data) {
  _origRenderAll(data);
  loadQualityScore();
  loadNetworkSummary();
};

// Auto-run prediction every 30s if data exists
setInterval(() => {
  if (filtered.length >= 5) runPrediction();
}, 30000);

// Init dead zone map
initDzMap();