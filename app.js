/* ═══════════════════════════════════════════════════════════════
   STATE + CONSTANTS
   ═══════════════════════════════════════════════════════════════ */
const SK = 'fp-meta-v1';
const TWEAKS_KEY = 'fp-tweaks-v1';
const PROV_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';

const COLORS = ['#c14638', '#d99320', '#5b8a37', '#2d8682', '#2a6582', '#7d4a8a', '#b03769', '#7a6b5a'];
const COLOR_NAMES = ['朱', '琥', '苔', '青', '靛', '紫', '茜', '骨'];

const TRANSPORTS = [
  { key: 'plane', label: '飞机', icon: '✈', dash: '10,6' },
  { key: 'train', label: '火车', icon: '🚄', dash: '' },
  { key: 'car',   label: '自驾', icon: '🚗', dash: '5,5' },
  { key: 'ship',  label: '船',   icon: '⛴', dash: '2,6' },
  { key: 'bus',   label: '大巴', icon: '🚌', dash: '7,4' },
  { key: 'walk',  label: '步行', icon: '🚶', dash: '2,4' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "survey",
  "dark": false,
  "lineStyle": "arc",
  "showProvinces": true,
  "markerStyle": "pin"
}/*EDITMODE-END*/;

let state = {
  trips: [],
  entries: [],
  ui: {
    listOpen: false,
    detailOpen: false,
    timelineOpen: false,
    tweaksOpen: false,
    currentEntryId: null,
    tempPhotos: [],
    tempLatLng: null,
    isDateRange: false,
    expandedTrips: new Set(),
    searchOpen: false,
    searchKbdIdx: 0,
    searchResults: [],
    tripSort: 'desc', // 'desc' newest first, 'asc' oldest first
  },
  tweaks: { ...TWEAK_DEFAULTS },
  photoCache: new Map(), // photoId -> objectURL
};

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const getTrip = (id) => state.trips.find(t => t.id === id);
const getTripEntries = (tid) => state.entries
  .filter(e => e.tripId === tid)
  .sort((a, b) => {
    const oa = a.order, ob = b.order;
    if (oa != null && ob != null) return oa - ob;
    if (oa != null) return -1;
    if (ob != null) return 1;
    return (a.date || '').localeCompare(b.date || '');
  });
const getTransport = (k) => TRANSPORTS.find(t => t.key === k) || TRANSPORTS[1];

/* ═══ GCJ-02 ↔ WGS-84 COORDINATE CONVERSION ═══ */
const GCJ = (() => {
  const PI = Math.PI, a = 6378245.0, ee = 0.00669342162296594323;
  function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function transformLat(x, y) {
    let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
    r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI)) * 2/3;
    r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30)) * 2/3;
    return r;
  }
  function transformLng(x, y) {
    let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
    r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
    r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI)) * 2/3;
    r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI)) * 2/3;
    return r;
  }
  return {
    wgs84ToGcj02(lat, lng) {
      if (outOfChina(lat, lng)) return [lat, lng];
      let dLat = transformLat(lng - 105, lat - 35);
      let dLng = transformLng(lng - 105, lat - 35);
      const radLat = lat / 180 * PI;
      let magic = Math.sin(radLat);
      magic = 1 - ee * magic * magic;
      const sqrtMagic = Math.sqrt(magic);
      dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
      dLng = (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * PI);
      return [lat + dLat, lng + dLng];
    },
    gcj02ToWgs84(lat, lng) {
      // Iterative inverse: apply forward, compute delta, subtract
      if (outOfChina(lat, lng)) return [lat, lng];
      let wLat = lat, wLng = lng;
      for (let i = 0; i < 3; i++) {
        const [gLat, gLng] = this.wgs84ToGcj02(wLat, wLng);
        wLat += lat - gLat;
        wLng += lng - gLng;
      }
      return [wLat, wLng];
    }
  };
})();

/** Convert [lat,lng] for current tile source. 高德=GCJ-02, OSM=WGS-84 */
function mapCoord(lat, lng) {
  if (lat == null || lng == null) return [lat, lng];
  if (mapLang === 'zh') return GCJ.wgs84ToGcj02(lat, lng);
  return [lat, lng];
}
function mapLL(lat, lng) {
  const [la, lo] = mapCoord(lat, lng);
  return L.latLng(la, lo);
}
/** Convert map-click latlng (tile coordinate system) back to WGS-84 for storage */
function toWgs84(lat, lng) {
  if (lat == null || lng == null) return { lat, lng };
  if (mapLang === 'zh') {
    const [wLat, wLng] = GCJ.gcj02ToWgs84(lat, lng);
    return { lat: wLat, lng: wLng };
  }
  return { lat, lng };
}
const fmtDate = (e) => {
  if (!e.date) return '';
  return e.dateEnd && e.dateEnd !== e.date ? `${e.date} — ${e.dateEnd}` : e.date;
};

function dateHeroHTML(e) {
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
    return `<div class="date-hero"><span class="empty">— 未填写日期 —</span></div>`;
  }
  const [y, m, d] = e.date.split('-');
  let dPart = d;
  if (e.dateEnd && e.dateEnd !== e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.dateEnd)) {
    const [y2, m2, d2] = e.dateEnd.split('-');
    if (y2 === y && m2 === m) dPart = `${d}<span class="dy-end">-${d2}</span>`;
    else dPart = `${d} <span class="dy-end">→ ${y2}.${m2}.${d2}</span>`;
  }
  return `<div class="date-hero">
    <span class="yr">${y}</span>
    <span class="mo">${m}</span>
    <span class="dy">${dPart}</span>
  </div>`;
}

/* Lightbox */
function openLightbox(src) {
  let lb = $('#lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `<button class="lightbox-close">×</button><img/>`;
    document.body.appendChild(lb);
    lb.addEventListener('click', () => lb.classList.remove('open'));
  }
  $('img', lb).src = src;
  lb.classList.add('open');
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), ms);
}

/* ═══════════════════════════════════════════════════════════════
   PHOTO STORAGE — IndexedDB
   ═══════════════════════════════════════════════════════════════ */
const PhotoDB = (() => {
  let dbP = null;
  function open() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      const req = indexedDB.open('fp-photos', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbP;
  }
  async function put(id, blob) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').put(blob, id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function get(id) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readonly');
      const req = tx.objectStore('photos').get(id);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function del(id) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function keys() {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readonly');
      const req = tx.objectStore('photos').getAllKeys();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  return { put, get, del, keys };
})();

async function getPhotoURL(id) {
  if (state.photoCache.has(id)) return state.photoCache.get(id);
  const blob = await PhotoDB.get(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  state.photoCache.set(id, url);
  return url;
}

function compressImageToBlob(file, maxDim = 1400, quality = 0.78) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = h / w * maxDim; w = maxDim; }
          else { w = w / h * maxDim; h = maxDim; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(b => b ? res(b) : rej(new Error('blob fail')), 'image/jpeg', quality);
      };
      img.onerror = rej;
      img.src = e.target.result;
    };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function blobToDataURL(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = (e) => res(e.target.result);
    r.readAsDataURL(blob);
  });
}

function dataURLToBlob(d) {
  const [meta, b64] = d.split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/* ═══════════════════════════════════════════════════════════════
   METADATA STORAGE — localStorage
   ═══════════════════════════════════════════════════════════════ */
function loadMeta() {
  try {
    const raw = localStorage.getItem(SK);
    if (raw) {
      const d = JSON.parse(raw);
      state.trips = d.trips || [];
      state.entries = d.entries || [];
    }
  } catch (e) { console.warn('load fail', e); }
  try {
    const t = localStorage.getItem(TWEAKS_KEY);
    if (t) state.tweaks = { ...TWEAK_DEFAULTS, ...JSON.parse(t) };
  } catch (e) {}
}
function saveMeta() {
  try { localStorage.setItem(SK, JSON.stringify({ trips: state.trips, entries: state.entries })); }
  catch (e) { toast('保存失败：存储空间不足'); }
}
function saveTweaks() {
  try { localStorage.setItem(TWEAKS_KEY, JSON.stringify(state.tweaks)); } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════
   ARC LINE MATH
   ═══════════════════════════════════════════════════════════════ */
function arcPoints(a, b, segments = 48, curvature = 0.16) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * curvature;
  const cy = my + dx * curvature;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = (1-t)*(1-t)*a[0] + 2*(1-t)*t*cx + t*t*b[0];
    const y = (1-t)*(1-t)*a[1] + 2*(1-t)*t*cy + t*t*b[1];
    pts.push([x, y]);
  }
  return pts;
}

function greatCirclePoints(a, b, segments = 64) {
  const toRad = (x) => x * Math.PI / 180;
  const toDeg = (x) => x * 180 / Math.PI;
  const lat1 = toRad(a[0]), lng1 = toRad(a[1]);
  const lat2 = toRad(b[0]), lng2 = toRad(b[1]);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
  ));
  if (d < 0.0001) return [a, b];
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return pts;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lineForTrip(t) {
  const pts = getTripEntries(t.id)
    .filter(e => e.lat != null && e.lng != null)
    .map(e => mapCoord(e.lat, e.lng));
  if (pts.length < 2) return [];
  const style = state.tweaks.lineStyle;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (style === 'straight') out.push([pts[i], pts[i+1]]);
    else if (style === 'great') out.push(greatCirclePoints(pts[i], pts[i+1], 48));
    else out.push(arcPoints(pts[i], pts[i+1], 36, 0.16));
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   MAP
   ═══════════════════════════════════════════════════════════════ */
let map, provinceLayer = null;
let markers = {}; // entryId -> marker
let lines = {};   // tripId -> [polylines]
let arcLabels = {}; // tripId -> [label markers]
let tileLayer = null;
let mapLang = 'zh'; // 'zh' or 'en'

const TILES = {
  zh: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
  en: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};
const TILE_SUBDOMAINS = '1234';
const TILE_ATTR = { zh: '© 高德地图', en: '© OpenStreetMap' };

function initMap() {
  map = L.map('map', {
    center: [33.5, 105],
    zoom: 4.2,
    zoomControl: false,
    minZoom: 3,
    worldCopyJump: true,
    attributionControl: true,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setTiles();
  map.on('click', (e) => {
    const wgs = toWgs84(e.latlng.lat, e.latlng.lng);
    openForm(wgs);
  });
  loadProvinces();
}

function setTiles() {
  if (tileLayer) map.removeLayer(tileLayer);
  const lang = mapLang || 'zh';
  const url = TILES[lang] || TILES.zh;
  const opts = {
    maxZoom: 18,
    attribution: TILE_ATTR[lang] || '© 高德地图',
  };
  if (lang === 'zh') opts.subdomains = TILE_SUBDOMAINS;
  tileLayer = L.tileLayer(url, opts).addTo(map);
  if (state.tweaks.dark && state.tweaks.mapFilter !== false) {
    map.getContainer().style.filter = 'var(--map-filter)';
  } else {
    map.getContainer().style.filter = 'none';
  }
}

/* Province GeoJSON */
let provincesData = null;
async function loadProvinces() {
  try {
    const r = await fetch(PROV_URL);
    if (!r.ok) throw new Error('http');
    provincesData = await r.json();
    drawProvinces();
  } catch (e) {
    console.warn('province load fail', e);
  }
}

function provinceVisitCount() {
  const m = {};
  state.entries.forEach(e => {
    if (e.province) m[e.province] = (m[e.province] || 0) + 1;
  });
  return m;
}

function provColor(count, maxC) {
  if (!count) return 'transparent';
  // Highlight in accent color, intensity by ratio
  const ratio = Math.min(1, count / Math.max(3, maxC));
  const t = state.tweaks.theme;
  // hex colors per theme
  const accents = {
    survey:  state.tweaks.dark ? '228,168,50'  : '201,139,26',
    journal: state.tweaks.dark ? '216,99,60'   : '164,67,36',
    atlas:   state.tweaks.dark ? '78,163,216'  : '14,74,122',
  };
  const rgb = accents[t] || accents.survey;
  const alpha = 0.12 + ratio * 0.4;
  return `rgba(${rgb},${alpha})`;
}

function drawProvinces() {
  if (provinceLayer) { map.removeLayer(provinceLayer); provinceLayer = null; }
  if (!provincesData || !state.tweaks.showProvinces) return;
  const counts = provinceVisitCount();
  const maxC = Math.max(1, ...Object.values(counts));
  provinceLayer = L.geoJSON(provincesData, {
    style: (f) => {
      const name = (f.properties.name || '').replace(/(省|市|特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区)$/, '');
      const matchKey = matchProvinceName(name);
      const c = counts[matchKey] || 0;
      return {
        fillColor: provColor(c, maxC),
        fillOpacity: 1,
        color: state.tweaks.dark ? 'rgba(180,180,180,0.18)' : 'rgba(80,80,80,0.18)',
        weight: 0.6,
      };
    },
    onEachFeature: (f, layer) => {
      const name = (f.properties.name || '').replace(/(省|市|特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区)$/, '');
      const matchKey = matchProvinceName(name);
      const c = counts[matchKey] || 0;
      layer.bindTooltip(`<b>${matchKey}</b> ${c ? `· ${c} 站` : '· 未访问'}`, {
        sticky: true, direction: 'top', className: 'province-tip', offset: [0, -4],
      });
      layer.on('mouseover', () => layer.setStyle({ weight: 1.5, color: 'var(--ak)' }));
      layer.on('mouseout', () => provinceLayer.resetStyle(layer));
    },
  }).addTo(map);
  provinceLayer.bringToBack();
}

function matchProvinceName(name) {
  const aliases = { '内蒙古': '内蒙古', '广西': '广西', '宁夏': '宁夏', '西藏': '西藏', '新疆': '新疆' };
  return aliases[name] || name;
}

/* ═══════════════════════════════════════════════════════════════
   MARKERS + LINES
   ═══════════════════════════════════════════════════════════════ */
function markerHTML(color, style) {
  if (style === 'dot') {
    return `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2.5px solid var(--sf);box-shadow:0 1px 4px rgba(0,0,0,.35);"></div>`;
  }
  if (style === 'square') {
    return `<div style="width:13px;height:13px;background:${color};border:2px solid var(--sf);box-shadow:0 1px 4px rgba(0,0,0,.35);transform:rotate(45deg);"></div>`;
  }
  // pin
  return `<svg width="22" height="30" viewBox="0 0 22 30" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));">
    <path d="M11 0C4.9 0 0 4.9 0 11c0 8 11 19 11 19s11-11 11-19C22 4.9 17.1 0 11 0z" fill="${color}"/>
    <circle cx="11" cy="11" r="3.5" fill="rgba(0,0,0,.4)"/>
  </svg>`;
}

function makeIcon(color) {
  const style = state.tweaks.markerStyle;
  return L.divIcon({
    className: 'fp-marker',
    html: markerHTML(color, style),
    iconSize: style === 'pin' ? [22, 30] : [16, 16],
    iconAnchor: style === 'pin' ? [11, 30] : [8, 8],
    tooltipAnchor: style === 'pin' ? [0, -28] : [0, -10],
  });
}

function entryColor(e) {
  if (e.tripId) {
    const t = getTrip(e.tripId);
    if (t) return t.color;
  }
  return e.color || COLORS[1];
}

function addEntryMarker(e) {
  if (e.lat == null || e.lng == null) return; // skip unpositioned entries
  const m = L.marker(mapLL(e.lat, e.lng), {
    icon: makeIcon(entryColor(e)),
    draggable: true,
  })
    .addTo(map)
    .bindTooltip(esc(e.title || '未命名'), { direction: 'top' });
  m.on('click', (ev) => { L.DomEvent.stopPropagation(ev); openView(e.id); });
  m.on('dragend', () => {
    const pos = m.getLatLng();
    const wgs = toWgs84(pos.lat, pos.lng);
    const entry = state.entries.find(x => x.id === e.id);
    if (entry) {
      entry.lat = wgs.lat;
      entry.lng = wgs.lng;
      saveMeta();
      // Redraw trip lines if this entry belongs to a trip
      if (entry.tripId) {
        const trip = getTrip(entry.tripId);
        if (trip) drawTripLine(trip);
      }
      toast('位置已更新');
    }
  });
  markers[e.id] = m;
}

function drawTripLine(t) {
  if (lines[t.id]) {
    lines[t.id].forEach(l => map.removeLayer(l));
    delete lines[t.id];
  }
  if (arcLabels[t.id]) {
    arcLabels[t.id].forEach(l => map.removeLayer(l));
    delete arcLabels[t.id];
  }
  const entries = getTripEntries(t.id).filter(e => e.lat != null && e.lng != null);
  const segs = lineForTrip(t);
  if (!segs.length) return;
  const tr = getTransport(t.transport);
  const isExpanded = state.ui.expandedTrips.has(t.id);

  const arr = segs.map(pts => L.polyline(pts, {
    color: t.color,
    weight: 2.5,
    opacity: 0.85,
    dashArray: tr.dash || null,
    lineCap: 'round',
    lineJoin: 'round',
  }).addTo(map));
  lines[t.id] = arr;

  // Arc labels: train/flight numbers always visible, local transport only when expanded
  const labels = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const e = entries[i];
    const vehicle = e.vehicle || entries[i + 1].vehicle || '';
    if (!vehicle) continue;

    // Is this a train/flight number? (K589, G187, MU2231, Z167, D1234, etc.)
    const isTrainOrFlight = /^[A-Za-z]+\d+/.test(vehicle.trim());
    // Skip local transport labels unless trip is expanded in list panel
    if (!isTrainOrFlight && !isExpanded) continue;

    const seg = segs[i];
    if (!seg || seg.length < 2) continue;
    const midIdx = Math.floor(seg.length / 2);
    const midPt = seg[midIdx];
    if (!midPt) continue;

    const cls = isTrainOrFlight ? 'arc-label' : 'arc-label arc-label-minor';
    const icon = L.divIcon({
      className: 'arc-label-wrap',
      html: `<div class="${cls}">${esc(vehicle)}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    const lbl = L.marker(midPt, { icon, interactive: false }).addTo(map);
    labels.push(lbl);
  }
  arcLabels[t.id] = labels;
}

function refreshMap() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  Object.values(lines).forEach(arr => arr.forEach(l => map.removeLayer(l)));
  lines = {};
  Object.values(arcLabels).forEach(arr => arr.forEach(l => map.removeLayer(l)));
  arcLabels = {};
  state.entries.forEach(addEntryMarker);
  state.trips.forEach(drawTripLine);
  drawProvinces();
  updateStats();
}

/* ═══════════════════════════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════════════════════════ */
function updateStats() {
  const provs = new Set(state.entries.map(e => e.province).filter(Boolean));
  const n = state.entries.length;
  let km = 0;
  state.trips.forEach(t => {
    const es = getTripEntries(t.id).filter(e => e.lat != null && e.lng != null);
    for (let i = 0; i < es.length - 1; i++) {
      km += haversineKm([es[i].lat, es[i].lng], [es[i+1].lat, es[i+1].lng]);
    }
  });
  $('#stat-prov').textContent = provs.size;
  $('#stat-entries').textContent = n;
  $('#stat-km').textContent = km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString();
}

/* ═══════════════════════════════════════════════════════════════
   PANELS (open/close, basic)
   ═══════════════════════════════════════════════════════════════ */
function openListPanel() {
  state.ui.listOpen = true;
  $('#list-panel').classList.add('open');
  renderList();
}
function closeListPanel() {
  state.ui.listOpen = false;
  $('#list-panel').classList.remove('open');
}
function openDetailPanel() {
  state.ui.detailOpen = true;
  $('#detail-panel').classList.add('open');
}
function closeDetailPanel() {
  state.ui.detailOpen = false;
  $('#detail-panel').classList.remove('open');
  state.ui.currentEntryId = null;
  state.ui.tempPhotos = [];
  state.ui.tempLatLng = null;
}

/* ═══════════════════════════════════════════════════════════════
   LIST PANEL RENDER
   ═══════════════════════════════════════════════════════════════ */
async function renderList() {
  const body = $('#list-body');
  const standalone = state.entries.filter(e => !e.tripId);
  let html = '';

  // Trips section
  html += `<div class="sec">
    <span>轨迹 · TRIPS<span style="margin-left:6px;color:var(--bh);font-weight:400">${state.trips.length}</span></span>
    <div class="sort-group">
      <button class="sort-btn ${state.ui.tripSort==='desc'?'on':''}" data-sort="desc">新→旧</button>
      <button class="sort-btn ${state.ui.tripSort==='asc'?'on':''}" data-sort="asc">旧→新</button>
    </div>
    <button class="new-btn" id="new-trip-btn">+ 新建</button>
  </div>`;

  // Sort trips
  const sortedTrips = [...state.trips].sort((a, b) => {
    const aEntries = getTripEntries(a.id);
    const bEntries = getTripEntries(b.id);
    const aDate = aEntries.length ? aEntries[0].date || '' : '';
    const bDate = bEntries.length ? bEntries[0].date || '' : '';
    return state.ui.tripSort === 'desc' ? bDate.localeCompare(aDate) : aDate.localeCompare(bDate);
  });

  if (sortedTrips.length) {
    for (const t of sortedTrips) {
      const te = getTripEntries(t.id);
      const tr = getTransport(t.transport);
      const isOpen = state.ui.expandedTrips.has(t.id);
      html += `<div class="trip-item" data-trip="${t.id}">
        <div class="trip-bar" style="background:${t.color}"></div>
        <div class="trip-toggle ${isOpen ? 'open' : ''}" data-toggle="${t.id}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>
        </div>
        <div class="trip-info" data-toggle="${t.id}">
          <div class="trip-name">${esc(t.name)}</div>
          <div class="trip-meta">
            <span class="pip">${tr.icon} ${tr.label}</span>
            <span class="pip">${te.length} 站</span>
          </div>
        </div>
        <div class="trip-actions">
          <button class="icon-btn" data-edit-trip="${t.id}" title="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="icon-btn danger" data-del-trip="${t.id}" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </div>
      </div>`;
      if (isOpen) {
        if (te.length) {
          for (const e of te) {
            const thumb = await firstPhotoUrl(e);
            html += `<div class="entry-item" data-entry="${e.id}" data-trip-entry="${t.id}" draggable="true">
              <div class="entry-dot" style="border-color:${t.color}"></div>
              <div class="entry-info">
                <div class="entry-name">${esc(e.title)}</div>
                <div class="entry-meta">${esc(fmtDate(e))}${e.province ? ' · ' + esc(e.province) : ''}</div>
              </div>
              ${thumb ? `<img class="entry-thumb" src="${thumb}"/>` : ''}
            </div>`;
          }
        } else {
          html += `<div class="empty-state" style="padding:20px">轨迹内还没有站点<br/>点击地图任意位置添加</div>`;
        }
      }
    }
  } else {
    html += `<div class="empty-state">还没有轨迹<br/>新建一条来记录连续的行程</div>`;
  }

  // Standalone
  html += `<div class="sec">
    <span>散记 · STANDALONE<span style="margin-left:6px;color:var(--bh);font-weight:400">${standalone.length}</span></span>
  </div>`;
  if (standalone.length) {
    const sorted = [...standalone].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    for (const e of sorted) {
      const thumb = await firstPhotoUrl(e);
      html += `<div class="entry-item" style="padding-left:18px" data-entry="${e.id}">
        <div class="entry-dot" style="border-color:${e.color || COLORS[1]}"></div>
        <div class="entry-info">
          <div class="entry-name">${esc(e.title)}</div>
          <div class="entry-meta">${esc(fmtDate(e))}${e.province ? ' · ' + esc(e.province) : ''}</div>
        </div>
        ${thumb ? `<img class="entry-thumb" src="${thumb}"/>` : ''}
      </div>`;
    }
  } else {
    html += `<div class="empty-state">暂无散记<br/>不归属轨迹的单点足迹会显示在这里</div>`;
  }

  body.innerHTML = html;
}

async function firstPhotoUrl(e) {
  if (!e.photoIds || !e.photoIds.length) return null;
  return await getPhotoURL(e.photoIds[0]);
}

/* List click handling */
function bindListBody() {
  $('#list-body').addEventListener('click', async (ev) => {
    // Sort buttons
    const sortBtn = ev.target.closest('[data-sort]');
    if (sortBtn) {
      state.ui.tripSort = sortBtn.dataset.sort;
      renderList();
      return;
    }
    const target = ev.target.closest('[data-toggle], [data-entry], [data-edit-trip], [data-del-trip], #new-trip-btn');
    if (!target) return;
    if (target.id === 'new-trip-btn') {
      openTripWizard();
    } else if (target.dataset.toggle) {
      const id = target.dataset.toggle;
      if (state.ui.expandedTrips.has(id)) state.ui.expandedTrips.delete(id);
      else state.ui.expandedTrips.add(id);
      renderList();
      // Redraw trip lines to update arc labels (show/hide local transport)
      const trip = getTrip(id);
      if (trip) drawTripLine(trip);
    } else if (target.dataset.entry) {
      const e = state.entries.find(x => x.id === target.dataset.entry);
      if (e) { closeListPanel(); flyToAndOpen(e); }
    } else if (target.dataset.editTrip) {
      ev.stopPropagation();
      openTripWizard(target.dataset.editTrip);
    } else if (target.dataset.delTrip) {
      ev.stopPropagation();
      askDeleteTrip(target.dataset.delTrip);
    }
  });

  // Drag-reorder of entries within a trip
  const body = $('#list-body');
  let dragEntryId = null;
  let dragTripId = null;
  body.addEventListener('dragstart', e => {
    const row = e.target.closest('[data-trip-entry]');
    if (!row) return;
    dragEntryId = row.dataset.entry;
    dragTripId = row.dataset.tripEntry;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragEntryId);
  });
  body.addEventListener('dragover', e => {
    const row = e.target.closest('[data-trip-entry]');
    if (!row || row.dataset.tripEntry !== dragTripId) return;
    e.preventDefault();
    $$('.entry-item', body).forEach(r => r.classList.remove('drop-target-top', 'drop-target-bottom'));
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    row.classList.add(before ? 'drop-target-top' : 'drop-target-bottom');
  });
  body.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('[data-trip-entry]');
    if (!row || !dragEntryId || row.dataset.tripEntry !== dragTripId) return;
    const targetId = row.dataset.entry;
    if (targetId === dragEntryId) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    reorderTripEntries(dragTripId, dragEntryId, targetId, before);
  });
  body.addEventListener('dragend', () => {
    $$('.entry-item', body).forEach(r => r.classList.remove('dragging', 'drop-target-top', 'drop-target-bottom'));
    dragEntryId = null;
    dragTripId = null;
  });
}

function reorderTripEntries(tripId, draggedId, targetId, before) {
  const sorted = getTripEntries(tripId);
  const fromIdx = sorted.findIndex(e => e.id === draggedId);
  const toIdx = sorted.findIndex(e => e.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const item = sorted.splice(fromIdx, 1)[0];
  let insertAt = sorted.findIndex(e => e.id === targetId);
  if (!before) insertAt += 1;
  sorted.splice(insertAt, 0, item);
  // Reassign order
  sorted.forEach((e, i) => {
    const real = state.entries.find(x => x.id === e.id);
    if (real) real.order = i;
  });
  saveMeta();
  renderList();
  refreshMap();
}

function flyToAndOpen(e) {
  map.flyTo(mapLL(e.lat, e.lng), Math.max(map.getZoom(), 9), { duration: .6 });
  setTimeout(() => openView(e.id), 400);
}

/* ═══════════════════════════════════════════════════════════════
   GEOCODER — Nominatim (OpenStreetMap)
   ═══════════════════════════════════════════════════════════════ */
const Geocoder = (() => {
  let lastReq = 0;
  async function search(q) {
    q = q.trim();
    if (!q) return [];
    // Respect Nominatim 1 req/sec rate limit
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastReq));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastReq = Date.now();
    try {
      const u = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&accept-language=zh-CN&q=${encodeURIComponent(q)}`;
      const r = await fetch(u);
      if (!r.ok) throw new Error('http');
      const d = await r.json();
      return d.map(x => ({
        name: (x.display_name || '').split(',')[0],
        full: x.display_name,
        lat: +x.lat,
        lng: +x.lon,
        type: x.type,
        addr: x.address || {},
      }));
    } catch (e) { console.warn('geocode fail', e); return []; }
  }
  function provinceFromAddr(addr) {
    const raw = addr.state || addr.province || addr.city || '';
    const m = raw.replace(/(省|市|特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区)$/, '');
    return m;
  }
  return { search, provinceFromAddr };
})();

/* ═══════════════════════════════════════════════════════════════
   ENTRY FORM
   ═══════════════════════════════════════════════════════════════ */
async function openForm(latlng, editId) {
  const ex = editId ? state.entries.find(e => e.id === editId) : null;
  state.ui.tempLatLng = latlng || (ex ? { lat: ex.lat, lng: ex.lng } : null);
  state.ui.currentEntryId = editId || null;
  state.ui.tempPhotos = ex ? [...(ex.photoIds || [])] : [];
  state.ui.isDateRange = ex ? !!(ex.dateEnd && ex.dateEnd !== ex.date) : false;

  const today = new Date().toISOString().slice(0, 10);
  const col = ex ? ex.color : COLORS[1];
  const ll = state.ui.tempLatLng;

  $('#detail-head h2').textContent = ex ? '编辑足迹' : '记录足迹';
  $('#detail-sub').textContent = ex ? 'EDIT ENTRY' : `NEW ENTRY · ${ll ? `${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}` : '— 未定位 —'}`;

  const PROVS = ['北京','天津','上海','重庆','河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西','甘肃','青海','台湾','内蒙古','广西','西藏','宁夏','新疆','香港','澳门','海外'];

  $('#detail-body').innerHTML = `
    <div class="form">
      <div class="field">
        <div class="field-lbl">地点名称 <span class="opt">可搜索定位</span></div>
        <div class="geo-wrap">
          <div class="geo-input-row">
            <input type="text" id="f-title" value="${esc(ex?.title || '')}" placeholder="例如：稻城亚丁 / 西安钟楼" autocomplete="off"/>
            <button class="geo-btn" id="geo-btn" type="button">📍 定位</button>
          </div>
          <div class="geo-results" id="geo-results"></div>
        </div>
      </div>
      <div class="field">
        <div class="field-lbl">归属轨迹 <span class="opt">可选</span></div>
        <select id="f-trip">
          <option value="">— 散记（不归属轨迹）—</option>
          ${state.trips.map(t => `<option value="${t.id}"${ex?.tripId === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <div class="field-lbl">车次 / 航班 / 班次 <span class="opt">可选</span></div>
        <input type="text" id="f-vehicle" value="${esc(ex?.vehicle || '')}" placeholder="例如：K888 · MU2231 · 自驾"/>
      </div>
      <div class="field">
        <div class="field-lbl">省份 / 地区</div>
        <select id="f-prov">
          <option value="">— 选择 —</option>
          ${PROVS.map(p => `<option value="${p}"${ex?.province === p ? ' selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <div class="field-lbl">旅行日期</div>
        <div class="date-row">
          <input type="date" id="f-date" value="${ex?.date || today}"/>
          <span class="date-sep" id="d-sep" style="display:${state.ui.isDateRange ? 'inline' : 'none'}">→</span>
          <input type="date" id="f-date-end" value="${ex?.dateEnd || today}" style="display:${state.ui.isDateRange ? 'block' : 'none'}"/>
        </div>
        <span class="date-toggle" id="d-toggle">${state.ui.isDateRange ? '— 改为单日' : '+ 改为日期段'}</span>
      </div>
      <div class="field">
        <div class="field-lbl">感想 / 备注</div>
        <textarea id="f-notes" placeholder="今天发生了什么…">${esc(ex?.notes || '')}</textarea>
      </div>
      <div class="field">
        <div class="field-lbl">照片 <span class="opt">可拖入</span></div>
        <label class="photo-drop" id="photo-drop">
          + 点击或拖入照片
          <input type="file" id="f-photos" accept="image/*" multiple/>
        </label>
        <div class="thumbs" id="thumbs"></div>
      </div>
      <div class="field">
        <div class="field-lbl">标记颜色 <span class="opt">散记用</span></div>
        <div class="color-pick" id="color-pick">
          ${COLORS.map((c, i) => `<div class="color-dot ${c === col ? 'sel' : ''}" style="background:${c}" data-col="${c}" title="${COLOR_NAMES[i]}"></div>`).join('')}
        </div>
      </div>
      <button class="btn-primary" id="f-save">${ex ? '保存修改' : '记录足迹'}</button>
      ${ex ? `<button class="btn-secondary" id="f-del">删除此足迹</button>` : ''}
    </div>
  `;

  let selectedColor = col;
  $('#color-pick').addEventListener('click', (e) => {
    const d = e.target.closest('[data-col]');
    if (!d) return;
    $$('.color-dot', $('#color-pick')).forEach(x => x.classList.remove('sel'));
    d.classList.add('sel');
    selectedColor = d.dataset.col;
  });
  $('#d-toggle').addEventListener('click', () => {
    state.ui.isDateRange = !state.ui.isDateRange;
    $('#f-date-end').style.display = state.ui.isDateRange ? 'block' : 'none';
    $('#d-sep').style.display = state.ui.isDateRange ? 'inline' : 'none';
    $('#d-toggle').textContent = state.ui.isDateRange ? '— 改为单日' : '+ 改为日期段';
  });
  const drop = $('#photo-drop');
  $('#f-photos').addEventListener('change', e => handlePhotos(e.target.files));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--ak)'; });
  drop.addEventListener('dragleave', () => drop.style.borderColor = '');
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.style.borderColor = '';
    if (e.dataTransfer.files) handlePhotos(e.dataTransfer.files);
  });

  // Geocoder
  $('#geo-btn').addEventListener('click', async () => {
    const q = $('#f-title').value.trim();
    if (!q) { toast('请先输入地点名'); $('#f-title').focus(); return; }
    await runGeocode(q);
  });
  $('#f-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#geo-btn').click(); }
  });
  document.addEventListener('click', closeGeoResultsOnOutside);

  await renderThumbs();
  $('#f-save').addEventListener('click', () => saveEntry(selectedColor));
  if (ex) $('#f-del').addEventListener('click', () => askDeleteEntry(ex.id));

  openDetailPanel();
  if (!ex) $('#f-title').focus();
}

function closeGeoResultsOnOutside(e) {
  const dd = $('#geo-results');
  if (!dd || !dd.classList.contains('open')) return;
  if (!e.target.closest('.geo-wrap')) dd.classList.remove('open');
}

async function runGeocode(q) {
  const dd = $('#geo-results');
  if (!dd) return;
  dd.innerHTML = `<div class="geo-status">搜索中…</div>`;
  dd.classList.add('open');
  const results = await Geocoder.search(q);
  if (!results.length) {
    dd.innerHTML = `<div class="geo-status">未找到结果，可手动点击地图</div>`;
    return;
  }
  dd.innerHTML = results.map((r, i) => `
    <div class="geo-item" data-geo-idx="${i}">
      <div class="geo-item-pin"></div>
      <div class="geo-item-text">
        <div class="geo-item-name">${esc(r.name)}</div>
        <div class="geo-item-meta">${esc(r.full)}</div>
      </div>
    </div>`).join('');
  dd.onclick = (e) => {
    const it = e.target.closest('[data-geo-idx]');
    if (!it) return;
    const r = results[+it.dataset.geoIdx];
    pickGeocodeResult(r);
    dd.classList.remove('open');
  };
}

function pickGeocodeResult(r) {
  state.ui.tempLatLng = { lat: r.lat, lng: r.lng };
  // Update sub label to show new coords
  $('#detail-sub').textContent = `${state.ui.currentEntryId ? 'EDIT ENTRY' : 'NEW ENTRY'} · ${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`;
  // Auto-fill title if empty
  if (!$('#f-title').value.trim()) $('#f-title').value = r.name;
  // Auto-pick province if we can match
  const prov = Geocoder.provinceFromAddr(r.addr);
  if (prov && $('#f-prov')) {
    const opt = [...$('#f-prov').options].find(o => o.value && (o.value === prov || prov.includes(o.value)));
    if (opt) $('#f-prov').value = opt.value;
  }
  // Recenter map preview
  if (map) map.flyTo(mapLL(r.lat, r.lng), Math.max(map.getZoom(), 9), { duration: .5 });
  toast('已定位到：' + r.name);
}

async function handlePhotos(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const blob = await compressImageToBlob(f);
      const pid = uid();
      await PhotoDB.put(pid, blob);
      state.ui.tempPhotos.push(pid);
      renderThumbs();
    } catch (e) { toast('照片处理失败'); }
  }
}

async function renderThumbs() {
  const el = $('#thumbs');
  if (!el) return;
  const html = await Promise.all(state.ui.tempPhotos.map(async (pid, i) => {
    const url = await getPhotoURL(pid);
    return url ? `<div class="thumb"><img src="${url}"/><button class="thumb-rm" data-rm="${i}">×</button></div>` : '';
  }));
  el.innerHTML = html.join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    state.ui.tempPhotos.splice(+b.dataset.rm, 1);
    renderThumbs();
  };
}

async function saveEntry(color) {
  const title = $('#f-title').value.trim();
  if (!title) { $('#f-title').focus(); toast('请填写地点名称'); return; }
  if (!state.ui.tempLatLng) { toast('请点击地图或点「📍 定位」先定位'); return; }
  const payload = {
    title,
    tripId: $('#f-trip').value || null,
    vehicle: $('#f-vehicle')?.value.trim() || '',
    province: $('#f-prov').value || null,
    date: $('#f-date').value,
    dateEnd: state.ui.isDateRange ? $('#f-date-end').value : '',
    notes: $('#f-notes').value.trim(),
    color,
    photoIds: [...state.ui.tempPhotos],
  };
  if (state.ui.currentEntryId) {
    const i = state.entries.findIndex(e => e.id === state.ui.currentEntryId);
    if (i !== -1) {
      state.entries[i] = { ...state.entries[i], ...payload };
      // Update coordinates if user repositioned
      if (state.ui.tempLatLng) {
        state.entries[i].lat = state.ui.tempLatLng.lat;
        state.entries[i].lng = state.ui.tempLatLng.lng;
      }
    }
    // delete removed photos from db
    // (we don't track removals separately; simplest: skip cleanup, gc later)
    toast('已更新');
  } else {
    state.entries.push({
      id: uid(),
      lat: state.ui.tempLatLng.lat,
      lng: state.ui.tempLatLng.lng,
      ...payload,
    });
    toast('已记录');
  }
  saveMeta();
  refreshMap();
  closeDetailPanel();
}

function askDeleteEntry(id) {
  showModal('删除足迹', '确定删除此足迹？此操作不可撤销。', [
    { label: '取消', cls: 'btn-cancel', cb: closeModal },
    { label: '删除', cls: 'btn-danger', cb: () => { doDeleteEntry(id); closeModal(); } },
  ]);
}
async function doDeleteEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (e && e.photoIds) {
    for (const pid of e.photoIds) await PhotoDB.del(pid);
  }
  state.entries = state.entries.filter(x => x.id !== id);
  saveMeta();
  refreshMap();
  closeDetailPanel();
  toast('已删除');
}

/* ═══════════════════════════════════════════════════════════════
   ENTRY VIEW
   ═══════════════════════════════════════════════════════════════ */
async function openView(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  const trip = getTrip(e.tripId);
  const tr = trip ? getTransport(trip.transport) : null;
  $('#detail-head h2').textContent = '足迹详情';
  $('#detail-sub').textContent = 'DETAIL';

  const photoUrls = await Promise.all((e.photoIds || []).map(getPhotoURL));

  $('#detail-body').innerHTML = `
    <div class="view-head">
      ${dateHeroHTML(e)}
      <div class="view-title">${esc(e.title)}</div>
      ${e.vehicle ? `<div class="view-vehicle">${esc(e.vehicle)}</div>` : ''}
      <div class="view-tags">
        ${e.province ? `<span class="view-tag info">${esc(e.province)}</span>` : ''}
        ${trip ? `<span class="view-tag" style="background:${trip.color}1a;color:${trip.color};border-color:${trip.color}55">${tr.icon} ${esc(trip.name)}</span>` : ''}
      </div>
    </div>
    <div class="view-body">
      ${photoUrls.filter(Boolean).length ? `<div class="view-photos">${photoUrls.filter(Boolean).map(u => `<img src="${u}" data-lightbox="${u}"/>`).join('')}</div>` : ''}
      ${e.notes ? `<div class="view-notes">${esc(e.notes)}</div>` : `<div class="view-notes-empty">— 暂无感想 —</div>`}
      <div class="view-coord">
        <span><b>纬度</b>${e.lat.toFixed(4)}°</span>
        <span><b>经度</b>${e.lng.toFixed(4)}°</span>
      </div>
      <div class="view-actions">
        <button class="view-act" id="v-edit">编辑</button>
        <button class="view-act danger" id="v-del">删除</button>
      </div>
    </div>
  `;
  $('#v-edit').addEventListener('click', () => openForm({lat: e.lat, lng: e.lng}, e.id));
  $('#v-del').addEventListener('click', () => askDeleteEntry(e.id));
  $$('[data-lightbox]', $('#detail-body')).forEach(img => {
    img.addEventListener('click', () => openLightbox(img.dataset.lightbox));
  });
  openDetailPanel();
}

/* ═══════════════════════════════════════════════════════════════
   TRIP WIZARD — name + stops in one panel
   ═══════════════════════════════════════════════════════════════ */
let wizState = null;

async function openTripWizard(editId) {
  const ex = editId ? getTrip(editId) : null;
  let stops = [];
  if (ex) {
    const ents = getTripEntries(editId);
    stops = ents.map(e => ({
      id: e.id,
      name: e.title,
      date: e.date || '',
      vehicle: e.vehicle || '',
      notes: e.notes || '',
      lat: e.lat,
      lng: e.lng,
      province: e.province || null,
      photoIds: e.photoIds || [],
    }));
  }
  wizState = {
    editId: editId || null,
    name: ex ? ex.name : '',
    transport: ex ? ex.transport : 'train',
    color: ex ? ex.color : COLORS[1],
    stops,
    editingIdx: -1,
    editor: null,
    geoResults: [],
  };
  state.ui.currentEntryId = null;
  $('#detail-head h2').textContent = ex ? '编辑轨迹' : '新建轨迹';
  $('#detail-sub').textContent = ex ? `EDIT TRIP // ${stops.length} STOPS` : 'NEW TRIP // WIZARD';
  renderWizard();
  openDetailPanel();
  setTimeout(() => $('#wiz-name')?.focus(), 200);
}

function renderWizard() {
  const w = wizState;
  $('#detail-body').innerHTML = `
    <div class="wizard-section">
      <div class="ws-title">基本信息 · BASICS</div>
      <div class="field">
        <div class="field-lbl">轨迹名称</div>
        <input type="text" id="wiz-name" value="${esc(w.name)}" placeholder="例如：2024 川西"/>
      </div>
      <div class="field">
        <div class="field-lbl">出行方式</div>
        <div class="transport-row" id="wiz-tr">
          ${TRANSPORTS.map(t => `<div class="tr-chip ${t.key === w.transport ? 'sel' : ''}" data-tr="${t.key}">${t.icon} ${t.label}</div>`).join('')}
        </div>
      </div>
      <div class="field">
        <div class="field-lbl">轨迹颜色</div>
        <div class="color-pick" id="wiz-col">
          ${COLORS.map((c, i) => `<div class="color-dot ${c === w.color ? 'sel' : ''}" style="background:${c}" data-col="${c}" title="${COLOR_NAMES[i]}"></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="wizard-section">
      <div class="ws-title">
        <span>站点 · STOPS</span>
        <span class="ws-count">${w.stops.length}</span>
      </div>
      <div class="stops-list" id="wiz-stops">
        ${renderStopsListHTML()}
      </div>
      ${w.editingIdx === -2 ? renderStopEditorHTML(null) : ''}
      ${w.editingIdx === -1 ? `<button class="add-stop-btn" id="wiz-add-stop">+ 添加站点</button>` : ''}
    </div>

    <div class="wizard-section" style="border-bottom:none;display:flex;flex-direction:column;gap:8px">
      <button class="btn-primary" id="wiz-save">${w.editId ? '保存轨迹' : '创建轨迹'}</button>
      ${w.editId ? `<button class="btn-secondary" id="wiz-del">删除整条轨迹</button>` : ''}
    </div>
  `;

  // Bind basics
  $('#wiz-name').addEventListener('input', e => w.name = e.target.value);
  $('#wiz-tr').addEventListener('click', e => {
    const c = e.target.closest('[data-tr]');
    if (!c) return;
    $$('.tr-chip', $('#wiz-tr')).forEach(x => x.classList.remove('sel'));
    c.classList.add('sel');
    w.transport = c.dataset.tr;
  });
  $('#wiz-col').addEventListener('click', e => {
    const d = e.target.closest('[data-col]');
    if (!d) return;
    $$('.color-dot', $('#wiz-col')).forEach(x => x.classList.remove('sel'));
    d.classList.add('sel');
    w.color = d.dataset.col;
  });

  // Stops list interactions
  bindStopsList();

  // Add stop button
  $('#wiz-add-stop')?.addEventListener('click', () => {
    w.editingIdx = -2;
    w.editor = { name: '', date: lastStopDate(), vehicle: defaultVehicle(), notes: '', lat: null, lng: null, province: null };
    renderWizard();
  });

  // Editor binds, if open
  if (w.editingIdx === -2 || w.editingIdx >= 0) bindStopEditor();

  // Save
  $('#wiz-save').addEventListener('click', saveWizard);
  $('#wiz-del')?.addEventListener('click', () => {
    if (wizState.editId) askDeleteTrip(wizState.editId);
  });
}

function lastStopDate() {
  const w = wizState;
  if (w.stops.length) return w.stops[w.stops.length - 1].date || new Date().toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function defaultVehicle() {
  const w = wizState;
  if (w.stops.length) return w.stops[w.stops.length - 1].vehicle || '';
  return '';
}

function renderStopsListHTML() {
  const w = wizState;
  if (!w.stops.length && w.editingIdx !== -2) {
    return `<div class="stop-empty">还没有添加站点</div>`;
  }
  return w.stops.map((s, i) => {
    if (w.editingIdx === i) return renderStopEditorHTML(s, i);
    const metaBits = [];
    if (s.date) metaBits.push(s.date);
    if (s.vehicle) metaBits.push(`<span class="v">${esc(s.vehicle)}</span>`);
    if (s.province) metaBits.push(esc(s.province));
    if (s.lat != null) metaBits.push(`${s.lat.toFixed(2)}, ${s.lng.toFixed(2)}`);
    return `
      <div class="stop-row" draggable="true" data-stop-idx="${i}">
        <div class="stop-handle is-num">${String(i + 1).padStart(2, '0')}</div>
        <div class="stop-content">
          <div class="stop-name">${esc(s.name) || '未命名'}</div>
          <div class="stop-meta">${metaBits.join(' · ')}</div>
        </div>
        <button class="stop-rm" data-stop-rm="${i}" title="删除">×</button>
      </div>
    `;
  }).join('');
}

function renderStopEditorHTML(stop, idx) {
  const e = wizState.editor || {};
  return `
    <div class="stop-editor">
      <div class="field">
        <div class="field-lbl">地点名称</div>
        <div class="geo-wrap">
          <div class="geo-input-row">
            <input type="text" id="se-name" value="${esc(e.name || '')}" placeholder="例如：洛阳" autocomplete="off"/>
            <button class="geo-btn" id="se-geo" type="button">📍 定位</button>
          </div>
          <div class="geo-results" id="se-geo-results"></div>
        </div>
        ${e.lat != null ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--lime);margin-top:6px;letter-spacing:1px;">✓ ${e.lat.toFixed(3)}, ${e.lng.toFixed(3)}${e.province ? ' · ' + e.province : ''}</div>` : `<div style="font-family:var(--font-mono);font-size:10px;color:var(--t3);margin-top:6px;letter-spacing:1px;">尚未定位</div>`}
      </div>
      <div class="field">
        <div class="field-lbl">日期</div>
        <input type="date" id="se-date" value="${esc(e.date || '')}"/>
      </div>
      <div class="field">
        <div class="field-lbl">车次 / 航班号 <span class="opt">可选</span></div>
        <input type="text" id="se-vehicle" value="${esc(e.vehicle || '')}" placeholder="例如：K888 · MU2231"/>
      </div>
      <div class="field">
        <div class="field-lbl">备注 <span class="opt">可选</span></div>
        <textarea id="se-notes" placeholder="备注…">${esc(e.notes || '')}</textarea>
      </div>
      <div class="editor-actions">
        <button class="btn-cancel-stop" id="se-cancel">取消</button>
        <button class="btn-confirm-stop" id="se-confirm">${idx != null ? '保存' : '+ 添加'}</button>
      </div>
    </div>
  `;
}

function bindStopEditor() {
  $('#se-name')?.addEventListener('input', e => { wizState.editor.name = e.target.value; });
  $('#se-date')?.addEventListener('input', e => { wizState.editor.date = e.target.value; });
  $('#se-vehicle')?.addEventListener('input', e => { wizState.editor.vehicle = e.target.value; });
  $('#se-notes')?.addEventListener('input', e => { wizState.editor.notes = e.target.value; });
  $('#se-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#se-geo').click(); }
  });
  $('#se-geo')?.addEventListener('click', async () => {
    const q = $('#se-name').value.trim();
    if (!q) { toast('请先输入地名'); return; }
    const dd = $('#se-geo-results');
    dd.innerHTML = `<div class="geo-status">搜索中…</div>`;
    dd.classList.add('open');
    const res = await Geocoder.search(q);
    wizState.geoResults = res;
    if (!res.length) {
      dd.innerHTML = `<div class="geo-status">未找到结果</div>`;
      return;
    }
    dd.innerHTML = res.map((r, i) => `
      <div class="geo-item" data-se-pick="${i}">
        <div class="geo-item-pin"></div>
        <div class="geo-item-text">
          <div class="geo-item-name">${esc(r.name)}</div>
          <div class="geo-item-meta">${esc(r.full)}</div>
        </div>
      </div>`).join('');
    dd.onclick = (ev) => {
      const it = ev.target.closest('[data-se-pick]');
      if (!it) return;
      const r = wizState.geoResults[+it.dataset.sePick];
      wizState.editor.lat = r.lat;
      wizState.editor.lng = r.lng;
      wizState.editor.province = Geocoder.provinceFromAddr(r.addr);
      if (!wizState.editor.name) wizState.editor.name = r.name;
      dd.classList.remove('open');
      renderWizard();
    };
  });
  $('#se-cancel')?.addEventListener('click', () => {
    wizState.editingIdx = -1;
    wizState.editor = null;
    renderWizard();
  });
  $('#se-confirm')?.addEventListener('click', () => {
    const e = wizState.editor;
    if (!e.name?.trim()) { toast('请填写站点名'); return; }
    if (e.lat == null) { toast('请点击「📍 定位」选择坐标'); return; }
    const data = { name: e.name.trim(), date: e.date, vehicle: e.vehicle?.trim() || '', notes: e.notes?.trim() || '', lat: e.lat, lng: e.lng, province: e.province };
    if (wizState.editingIdx >= 0) wizState.stops[wizState.editingIdx] = data;
    else wizState.stops.push(data);
    wizState.editingIdx = -1;
    wizState.editor = null;
    renderWizard();
  });
}

function bindStopsList() {
  const cont = $('#wiz-stops');
  if (!cont) return;
  cont.addEventListener('click', e => {
    const rm = e.target.closest('[data-stop-rm]');
    if (rm) {
      wizState.stops.splice(+rm.dataset.stopRm, 1);
      renderWizard();
      return;
    }
    const row = e.target.closest('[data-stop-idx]');
    if (row && !e.target.closest('.stop-handle')) {
      const idx = +row.dataset.stopIdx;
      wizState.editingIdx = idx;
      wizState.editor = { ...wizState.stops[idx] };
      renderWizard();
    }
  });
  // Drag-reorder
  let dragIdx = -1;
  cont.addEventListener('dragstart', e => {
    const row = e.target.closest('[data-stop-idx]');
    if (!row) return;
    dragIdx = +row.dataset.stopIdx;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  cont.addEventListener('dragover', e => {
    e.preventDefault();
    const row = e.target.closest('[data-stop-idx]');
    $$('.stop-row', cont).forEach(r => r.classList.remove('drag-over'));
    if (row) row.classList.add('drag-over');
  });
  cont.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('[data-stop-idx]');
    if (!row || dragIdx === -1) return;
    const toIdx = +row.dataset.stopIdx;
    if (toIdx === dragIdx) return;
    const item = wizState.stops.splice(dragIdx, 1)[0];
    wizState.stops.splice(toIdx, 0, item);
    dragIdx = -1;
    renderWizard();
  });
  cont.addEventListener('dragend', () => {
    $$('.stop-row', cont).forEach(r => r.classList.remove('dragging', 'drag-over'));
    dragIdx = -1;
  });
}

function saveWizard() {
  const w = wizState;
  if (!w.name.trim()) { $('#wiz-name').focus(); toast('请填写轨迹名称'); return; }
  if (!w.stops.length) { toast('至少添加一个站点'); return; }

  if (w.editId) {
    // EDIT MODE: reconcile
    const trip = getTrip(w.editId);
    if (trip) { trip.name = w.name.trim(); trip.transport = w.transport; trip.color = w.color; }
    const keptIds = new Set(w.stops.map(s => s.id).filter(Boolean));
    // Delete entries removed from wizard
    const toRemove = state.entries.filter(e => e.tripId === w.editId && !keptIds.has(e.id));
    toRemove.forEach(e => { (e.photoIds || []).forEach(pid => PhotoDB.del(pid).catch(() => {})); });
    state.entries = state.entries.filter(e => e.tripId !== w.editId || keptIds.has(e.id));
    // Update / add
    w.stops.forEach((s, i) => {
      if (s.id) {
        const idx = state.entries.findIndex(e => e.id === s.id);
        if (idx !== -1) {
          state.entries[idx] = { ...state.entries[idx],
            title: s.name, lat: s.lat, lng: s.lng, date: s.date || '',
            vehicle: s.vehicle || '', province: s.province || null,
            notes: s.notes ?? state.entries[idx].notes,
            order: i,
          };
        }
      } else {
        state.entries.push({
          id: uid(), tripId: w.editId, title: s.name, lat: s.lat, lng: s.lng,
          date: s.date || '', dateEnd: '', vehicle: s.vehicle || '',
          province: s.province || null, notes: s.notes || '', photoIds: [],
          color: w.color, order: i,
        });
      }
    });
    saveMeta();
    refreshMap();
    closeDetailPanel();
    if (state.ui.listOpen) renderList();
    toast(`已保存：${w.name} · ${w.stops.length} 站`);
    wizState = null;
    return;
  }

  // CREATE MODE
  const tripId = uid();
  state.trips.push({ id: tripId, name: w.name.trim(), transport: w.transport, color: w.color });
  w.stops.forEach((s, i) => {
    state.entries.push({
      id: uid(), tripId,
      title: s.name, lat: s.lat, lng: s.lng,
      date: s.date || '', dateEnd: '',
      vehicle: s.vehicle || '',
      province: s.province || null,
      notes: s.notes || '', photoIds: [],
      color: w.color, order: i,
    });
  });
  saveMeta();
  refreshMap();
  closeDetailPanel();
  toast(`已创建：${w.name} · ${w.stops.length} 站`);
  wizState = null;
  // Fit to trip
  const es = getTripEntries(tripId);
  if (es.length > 1) {
    const b = L.latLngBounds(es.map(e => mapCoord(e.lat, e.lng)));
    setTimeout(() => map.flyToBounds(b, { padding: [80, 80], duration: .8 }), 200);
  } else if (es.length === 1) {
    setTimeout(() => map.flyTo(mapLL(es[0].lat, es[0].lng), 9, { duration: .6 }), 200);
  }
}

/* ═══════════════════════════════════════════════════════════════
   TRIP MODAL
   ═══════════════════════════════════════════════════════════════ */
function openTripModal(editId) {
  const ex = editId ? getTrip(editId) : null;
  const col = ex ? ex.color : COLORS[1];
  const tr = ex ? ex.transport : 'train';
  showModal(ex ? '编辑轨迹' : '新建轨迹', `
    <div class="field">
      <div class="field-lbl">轨迹名称</div>
      <input type="text" id="mt-name" value="${esc(ex?.name || '')}" placeholder="例如：2024 川西"/>
    </div>
    <div class="field">
      <div class="field-lbl">出行方式</div>
      <div class="transport-row" id="mt-tr">
        ${TRANSPORTS.map(t => `<div class="tr-chip ${t.key === tr ? 'sel' : ''}" data-tr="${t.key}">${t.icon} ${t.label}</div>`).join('')}
      </div>
    </div>
    <div class="field">
      <div class="field-lbl">轨迹颜色</div>
      <div class="color-pick" id="mt-col">
        ${COLORS.map((c, i) => `<div class="color-dot ${c === col ? 'sel' : ''}" style="background:${c}" data-col="${c}" title="${COLOR_NAMES[i]}"></div>`).join('')}
      </div>
    </div>
  `, [
    { label: '取消', cls: 'btn-cancel', cb: closeModal },
    { label: ex ? '保存' : '创建', cls: 'btn-ok', cb: () => saveTrip(editId) },
  ]);
  let selT = tr, selC = col;
  $('#mt-tr').addEventListener('click', e => {
    const c = e.target.closest('[data-tr]');
    if (!c) return;
    $$('.tr-chip', $('#mt-tr')).forEach(x => x.classList.remove('sel'));
    c.classList.add('sel');
    selT = c.dataset.tr;
  });
  $('#mt-col').addEventListener('click', e => {
    const d = e.target.closest('[data-col]');
    if (!d) return;
    $$('.color-dot', $('#mt-col')).forEach(x => x.classList.remove('sel'));
    d.classList.add('sel');
    selC = d.dataset.col;
  });
  window._mt = { getT: () => selT, getC: () => selC };
}

function saveTrip(editId) {
  const name = $('#mt-name').value.trim();
  if (!name) { $('#mt-name').focus(); toast('请填写轨迹名称'); return; }
  const t = window._mt.getT();
  const c = window._mt.getC();
  if (editId) {
    const tr = getTrip(editId);
    if (tr) { tr.name = name; tr.transport = t; tr.color = c; }
  } else {
    state.trips.push({ id: uid(), name, transport: t, color: c });
  }
  saveMeta();
  refreshMap();
  closeModal();
  if (state.ui.listOpen) renderList();
  toast(editId ? '已更新' : '已创建');
}

function askDeleteTrip(id) {
  const t = getTrip(id);
  const cnt = getTripEntries(id).length;
  showModal('删除轨迹', `删除「${esc(t?.name || '')}」？<br/><br/>${cnt ? `<span style="color:var(--red)">${cnt} 个站点</span>将一并删除。` : '此轨迹下没有站点。'}`, [
    { label: '取消', cls: 'btn-cancel', cb: closeModal },
    { label: '删除', cls: 'btn-danger', cb: () => doDeleteTrip(id) },
  ]);
}
async function doDeleteTrip(id) {
  const eIds = state.entries.filter(e => e.tripId === id).map(e => e.id);
  for (const eid of eIds) {
    const e = state.entries.find(x => x.id === eid);
    if (e?.photoIds) for (const pid of e.photoIds) await PhotoDB.del(pid);
  }
  state.trips = state.trips.filter(t => t.id !== id);
  state.entries = state.entries.filter(e => e.tripId !== id);
  saveMeta();
  refreshMap();
  closeModal();
  if (state.ui.listOpen) renderList();
  toast('已删除');
}

/* ═══════════════════════════════════════════════════════════════
   MODAL
   ═══════════════════════════════════════════════════════════════ */
function showModal(title, bodyHtml, actions) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-actions').innerHTML = actions.map((a, i) => `<button class="${a.cls}" data-act="${i}">${a.label}</button>`).join('');
  $('#modal-actions').onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    actions[+b.dataset.act].cb();
  };
  $('#modal').classList.add('open');
}
function closeModal() { $('#modal').classList.remove('open'); }

/* ═══════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════ */
function runSearch(q) {
  q = q.trim().toLowerCase();
  const dd = $('#search-results');
  if (!q) { dd.classList.remove('open'); state.ui.searchOpen = false; return; }
  state.ui.searchOpen = true;
  const ents = state.entries.filter(e =>
    (e.title || '').toLowerCase().includes(q) ||
    (e.notes || '').toLowerCase().includes(q) ||
    (e.province || '').toLowerCase().includes(q)
  );
  const trips = state.trips.filter(t => (t.name || '').toLowerCase().includes(q));
  state.ui.searchResults = [...trips.map(t => ({ type: 'trip', obj: t })), ...ents.map(e => ({ type: 'entry', obj: e }))];
  state.ui.searchKbdIdx = 0;
  renderSearchResults(q);
  dd.classList.add('open');
}

function renderSearchResults(q) {
  const dd = $('#search-results');
  if (!state.ui.searchResults.length) { dd.innerHTML = `<div class="sr-empty">没有匹配的结果</div>`; return; }
  const hi = (s) => esc(s || '').replace(new RegExp(esc(q), 'gi'), m => `<mark>${m}</mark>`);
  const trips = state.ui.searchResults.filter(r => r.type === 'trip');
  const ents = state.ui.searchResults.filter(r => r.type === 'entry');
  let html = '';
  let idx = 0;
  if (trips.length) {
    html += `<div class="sr-group">TRIP · 轨迹 (${trips.length})</div>`;
    trips.forEach(({obj: t}) => {
      const te = getTripEntries(t.id);
      html += `<div class="sr-item ${idx === state.ui.searchKbdIdx ? 'kbd' : ''}" data-sr="${idx}">
        <span class="sr-dot" style="background:${t.color}"></span>
        <div class="sr-info">
          <div class="sr-title">${hi(t.name)}</div>
          <div class="sr-meta">${te.length} 站</div>
        </div>
      </div>`;
      idx++;
    });
  }
  if (ents.length) {
    html += `<div class="sr-group">ENTRY · 足迹 (${ents.length})</div>`;
    ents.forEach(({obj: e}) => {
      html += `<div class="sr-item ${idx === state.ui.searchKbdIdx ? 'kbd' : ''}" data-sr="${idx}">
        <span class="sr-dot" style="background:${entryColor(e)}"></span>
        <div class="sr-info">
          <div class="sr-title">${hi(e.title)}</div>
          <div class="sr-meta">${esc(fmtDate(e))}${e.province ? ' · ' + hi(e.province) : ''}</div>
        </div>
      </div>`;
      idx++;
    });
  }
  dd.innerHTML = html;
  dd.onclick = (ev) => {
    const item = ev.target.closest('[data-sr]');
    if (!item) return;
    pickSearchResult(+item.dataset.sr);
  };
}

function pickSearchResult(idx) {
  const r = state.ui.searchResults[idx];
  if (!r) return;
  $('#search').value = '';
  $('#search-results').classList.remove('open');
  state.ui.searchOpen = false;
  if (r.type === 'entry') flyToAndOpen(r.obj);
  else if (r.type === 'trip') {
    const es = getTripEntries(r.obj.id);
    if (es.length) {
      const bounds = L.latLngBounds(es.map(e => mapCoord(e.lat, e.lng)));
      map.flyToBounds(bounds, { padding: [80, 80], duration: .8 });
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   TIMELINE OVERLAY
   ═══════════════════════════════════════════════════════════════ */
async function openTimeline() {
  state.ui.timelineOpen = true;
  $('#timeline').classList.add('open');
  renderTimeline();
}
function closeTimeline() {
  state.ui.timelineOpen = false;
  $('#timeline').classList.remove('open');
}
async function renderTimeline() {
  const body = $('#timeline-body');
  if (!state.entries.length) {
    body.innerHTML = `<div class="empty-state" style="margin-top:80px">还没有任何足迹<br/><br/>关闭这个视图，点击地图任意位置开始记录</div>`;
    return;
  }
  const sorted = [...state.entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const groups = {};
  sorted.forEach(e => {
    const y = (e.date || '').slice(0, 4) || '未知';
    (groups[y] = groups[y] || []).push(e);
  });
  const years = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  let html = '';
  for (const y of years) {
    html += `<div class="timeline-year">
      <span class="yr">${y}</span>
      <span class="yr-meta">${groups[y].length} 站</span>
      <span class="yr-line"></span>
    </div>`;
    html += `<div class="timeline-entries">`;
    for (const e of groups[y]) {
      const t = getTrip(e.tripId);
      const thumb = await firstPhotoUrl(e);
      html += `<div class="tl-card" data-entry="${e.id}">
        ${thumb ? `<img class="tl-thumb" src="${thumb}"/>` : `<div class="tl-thumb-empty">NO PHOTO</div>`}
        <div class="tl-date">${esc(fmtDate(e))}${e.province ? ' · ' + esc(e.province) : ''}</div>
        <div class="tl-title">${esc(e.title)}</div>
        ${t ? `<div class="tl-tag" style="color:${t.color}">— ${esc(t.name)}</div>` : ''}
      </div>`;
    }
    html += `</div>`;
  }
  body.innerHTML = html;
  body.onclick = (ev) => {
    const c = ev.target.closest('[data-entry]');
    if (!c) return;
    const e = state.entries.find(x => x.id === c.dataset.entry);
    if (e) { closeTimeline(); flyToAndOpen(e); }
  };
}

/* ═══════════════════════════════════════════════════════════════
   IMPORT / EXPORT
   ═══════════════════════════════════════════════════════════════ */
async function doExport() {
  if (!state.entries.length && !state.trips.length) { toast('暂无数据可导出'); return; }
  toast('正在导出，照片转码中…');
  const photos = {};
  const allPids = new Set();
  state.entries.forEach(e => (e.photoIds || []).forEach(p => allPids.add(p)));
  for (const pid of allPids) {
    const b = await PhotoDB.get(pid);
    if (b) photos[pid] = await blobToDataURL(b);
  }
  const data = {
    version: 'v1',
    exportedAt: new Date().toISOString(),
    trips: state.trips,
    entries: state.entries,
    photos,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `足迹_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`已导出 ${state.entries.length} 站 / ${state.trips.length} 轨迹`);
}

function doImport() { $('#import-input').click(); }
async function handleImport(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const d = JSON.parse(text);
    let newTrips = d.trips || [];
    let newEntries = d.entries || [];
    const photos = d.photos || {};
    // legacy support: top-level array
    if (Array.isArray(d)) newEntries = d;
    let at = 0, ae = 0, ap = 0;
    const tIds = new Set(state.trips.map(t => t.id));
    const eIds = new Set(state.entries.map(e => e.id));
    for (const t of newTrips) {
      if (!t.id) t.id = uid();
      if (!tIds.has(t.id)) { state.trips.push(t); at++; }
    }
    for (const e of newEntries) {
      if (!e.id) e.id = uid();
      if (eIds.has(e.id)) continue;
      // legacy photos as dataURL array → convert to photoIds
      if (e.photos && e.photos.length && !e.photoIds) {
        e.photoIds = [];
        for (const p of e.photos) {
          if (typeof p === 'string' && p.startsWith('data:')) {
            const pid = uid();
            await PhotoDB.put(pid, dataURLToBlob(p));
            e.photoIds.push(pid);
            ap++;
          }
        }
        delete e.photos;
      }
      state.entries.push(e);
      ae++;
    }
    // attached photos by id
    for (const [pid, durl] of Object.entries(photos)) {
      const existing = await PhotoDB.get(pid);
      if (!existing) {
        await PhotoDB.put(pid, dataURLToBlob(durl));
        ap++;
      }
    }
    saveMeta();
    refreshMap();
    toast(`导入 ${at} 轨迹 · ${ae} 站 · ${ap} 照片`);
  } catch (e) { console.error(e); toast('文件解析失败'); }
}

/* ═══════════════════════════════════════════════════════════════
   TWEAKS PANEL
   ═══════════════════════════════════════════════════════════════ */
function applyTweaks() {
  document.body.classList.remove('theme-survey', 'theme-journal', 'theme-atlas');
  document.body.classList.add('theme-' + state.tweaks.theme);
  document.body.classList.toggle('dark', !!state.tweaks.dark);
  // update tile + map
  if (map) {
    setTiles();
    drawProvinces();
    refreshMap();
  }
  // dark toggle button icon
  const db = $('#dark-toggle');
  if (db) db.innerHTML = state.tweaks.dark
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
  saveTweaks();
}

function setTweak(k, v) {
  state.tweaks[k] = v;
  applyTweaks();
  renderTweaks();
}

function renderTweaks() {
  const t = state.tweaks;
  $('#tweaks-body').innerHTML = `
    <div class="tweak-group">
      <div class="tg-lbl">主题方向</div>
      <div class="tweak-segment">
        <button class="${t.theme === 'survey'  ? 'sel' : ''}" data-tw="theme:survey">勘探</button>
        <button class="${t.theme === 'journal' ? 'sel' : ''}" data-tw="theme:journal">手账</button>
        <button class="${t.theme === 'atlas'   ? 'sel' : ''}" data-tw="theme:atlas">图谱</button>
      </div>
    </div>
    <div class="tweak-group">
      <div class="tg-lbl">轨迹连线</div>
      <div class="tweak-segment">
        <button class="${t.lineStyle === 'straight' ? 'sel' : ''}" data-tw="lineStyle:straight">直线</button>
        <button class="${t.lineStyle === 'arc'      ? 'sel' : ''}" data-tw="lineStyle:arc">弧线</button>
        <button class="${t.lineStyle === 'great'    ? 'sel' : ''}" data-tw="lineStyle:great">大圆</button>
      </div>
    </div>
    <div class="tweak-group">
      <div class="tg-lbl">标记样式</div>
      <div class="tweak-segment">
        <button class="${t.markerStyle === 'pin'    ? 'sel' : ''}" data-tw="markerStyle:pin">图钉</button>
        <button class="${t.markerStyle === 'dot'    ? 'sel' : ''}" data-tw="markerStyle:dot">圆点</button>
        <button class="${t.markerStyle === 'square' ? 'sel' : ''}" data-tw="markerStyle:square">菱形</button>
      </div>
    </div>
    <div class="tweak-group">
      <div class="tweak-toggle">
        <span class="tt-lbl">省份高亮</span>
        <div class="switch ${t.showProvinces ? 'on' : ''}" data-tw-toggle="showProvinces"></div>
      </div>
      <div class="tweak-toggle">
        <span class="tt-lbl">深色模式</span>
        <div class="switch ${t.dark ? 'on' : ''}" data-tw-toggle="dark"></div>
      </div>
    </div>
  `;
  $('#tweaks-body').onclick = (e) => {
    const seg = e.target.closest('[data-tw]');
    const tog = e.target.closest('[data-tw-toggle]');
    if (seg) {
      const [k, v] = seg.dataset.tw.split(':');
      setTweak(k, v);
    } else if (tog) {
      setTweak(tog.dataset.twToggle, !state.tweaks[tog.dataset.twToggle]);
    }
  };
}

function toggleTweaks() {
  state.ui.tweaksOpen = !state.ui.tweaksOpen;
  $('#tweaks-panel').classList.toggle('open', state.ui.tweaksOpen);
  $('#tweaks-toggle').classList.toggle('open', state.ui.tweaksOpen);
  if (state.ui.tweaksOpen) renderTweaks();
}

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
function bindUI() {
  // Top bar tools
  $('#tool-list').addEventListener('click', () => {
    if (state.ui.listOpen) closeListPanel(); else openListPanel();
  });
  $('#tool-timeline').addEventListener('click', () => {
    if (state.ui.timelineOpen) closeTimeline(); else openTimeline();
  });
  $('#tool-new-trip').addEventListener('click', () => openTripWizard());
  $('#tool-export').addEventListener('click', doExport);
  $('#tool-import').addEventListener('click', doImport);
  $('#dark-toggle').addEventListener('click', () => setTweak('dark', !state.tweaks.dark));
  $('#import-input').addEventListener('change', e => {
    handleImport(e.target.files[0]);
    e.target.value = '';
  });

  // Close panel buttons
  $$('[data-close-panel]').forEach(b => {
    b.addEventListener('click', () => {
      const p = b.dataset.closePanel;
      if (p === 'list') closeListPanel();
      else if (p === 'detail') closeDetailPanel();
      else if (p === 'timeline') closeTimeline();
      else if (p === 'tweaks') toggleTweaks();
    });
  });

  // Modal cancel
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  // Search
  const search = $('#search');
  search.addEventListener('input', () => runSearch(search.value));
  search.addEventListener('focus', () => { if (search.value) runSearch(search.value); });
  search.addEventListener('keydown', (e) => {
    if (!state.ui.searchOpen) return;
    if (e.key === 'ArrowDown') { state.ui.searchKbdIdx = Math.min(state.ui.searchResults.length - 1, state.ui.searchKbdIdx + 1); renderSearchResults(search.value); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { state.ui.searchKbdIdx = Math.max(0, state.ui.searchKbdIdx - 1); renderSearchResults(search.value); e.preventDefault(); }
    else if (e.key === 'Enter') { pickSearchResult(state.ui.searchKbdIdx); e.preventDefault(); }
    else if (e.key === 'Escape') { search.blur(); $('#search-results').classList.remove('open'); state.ui.searchOpen = false; }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      $('#search-results').classList.remove('open');
      state.ui.searchOpen = false;
    }
  });

  // Tweaks
  $('#tweaks-toggle').addEventListener('click', toggleTweaks);

  // Map language toggle
  $('#map-lang-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lang]');
    if (!btn) return;
    mapLang = btn.dataset.lang;
    $$('.mlt-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === mapLang));
    setTiles();
    refreshMap(); // Re-draw all markers/lines with correct coordinates
  });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search) {
      e.preventDefault(); search.focus();
    }
    if (e.key === 'Escape') {
      if (state.ui.timelineOpen) closeTimeline();
      else if (state.ui.detailOpen) closeDetailPanel();
      else if (state.ui.listOpen) closeListPanel();
      else if (state.ui.tweaksOpen) toggleTweaks();
      else closeModal();
    }
  });

  bindListBody();
}

async function init() {
  loadMeta();
  applyTweaks();
  initMap();
  bindUI();
  refreshMap();

  // Welcome hint
  if (!state.entries.length && !state.trips.length) {
    setTimeout(() => toast('点击地图任意位置开始记录足迹', 3000), 600);
  }
}

document.addEventListener('DOMContentLoaded', init);
