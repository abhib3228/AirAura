const API = (window.AIRAURA_API || "").replace(/\/$/, "");
const TOKEN_KEY = "airaura_token";
const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (sel, root = document) => root.querySelector(sel);

// US AQI bands (same scale Open-Meteo returns)
const AQI_BANDS = [
  { max: 50,  name: "Good",                           color: "#22c55e" },
  { max: 100, name: "Moderate",                       color: "#eab308" },
  { max: 150, name: "Unhealthy for Sensitive Groups", color: "#f97316" },
  { max: 200, name: "Unhealthy",                      color: "#ef4444" },
  { max: 300, name: "Very Unhealthy",                 color: "#a855f7" },
  { max: 500, name: "Hazardous",                      color: "#be123c" },
];
function aqiInfo(v) {
  const value = Number(v) || 0;
  const index = AQI_BANDS.findIndex((b) => value <= b.max);
  const i = index === -1 ? AQI_BANDS.length - 1 : index;
  return { index: i, ...AQI_BANDS[i] };
}

function debounce(fn, ms = 350) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Animated number; falls back to instant when motion is reduced
function countTo(el, value, decimals = 0) {
  if (value == null) { el.textContent = "–"; return; }
  if (prefersReduced || !window.gsap) { el.textContent = Number(value).toFixed(decimals); return; }
  const obj = { n: parseFloat(el.dataset.v) || 0 };
  el.dataset.v = value;
  gsap.to(obj, { n: value, duration: 1.1, ease: "power2.out", onUpdate: () => (el.textContent = obj.n.toFixed(decimals)) });
}

// Lazy-load a script once (keeps heavy 3D libraries off the critical path)
const _loaded = {};
function loadScript(src) {
  if (!_loaded[src]) {
    _loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }
  return _loaded[src];
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = "Bearer " + token;

  let res;
  // If the server takes more than 4 seconds it is probably waking up (free Render instances sleep)
  const slow = setTimeout(() => window.dispatchEvent(new Event("airaura:slow")), 4000);
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw { message: "Can't reach the server. On Render's free tier it may be waking up, so please try again in about 30 seconds." };
  } finally {
    clearTimeout(slow);
    window.dispatchEvent(new Event("airaura:ready"));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith("/api/auth/login")) {
      localStorage.removeItem(TOKEN_KEY);
      if (location.pathname.endsWith("dashboard.html")) location.replace("login.html");
    }
    throw { status: res.status, message: data.error || "Something went wrong. Please try again.", fields: data.fields || {} };
  }
  return data;
}

// ---- Browser-side fallback (used when the backend can't reach Open-Meteo) ----
const OM_AQ = "https://air-quality-api.open-meteo.com/v1/air-quality";
const OM_WX = "https://api.open-meteo.com/v1/forecast";

async function omGet(url, params) {
  const res = await fetch(url + "?" + new URLSearchParams(params));
  if (!res.ok) throw new Error("Open-Meteo " + res.status);
  return res.json();
}

async function fallbackAir(lat, lon) {
  lat = +lat.toFixed(2); lon = +lon.toFixed(2);
  const [aqR, wxR] = await Promise.all([
    omGet(OM_AQ, { latitude: lat, longitude: lon, timezone: "auto",
      current: "us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide,uv_index" }),
    omGet(OM_WX, { latitude: lat, longitude: lon, timezone: "auto",
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code,is_day" }).catch(() => ({ current: {} })),
  ]);
  const aq = aqR.current, wx = wxR.current;
  const pollutants = {
    "PM2.5": aq.pm2_5, "PM10": aq.pm10, "NO2": aq.nitrogen_dioxide,
    "SO2": aq.sulphur_dioxide, "CO": aq.carbon_monoxide, "O3": aq.ozone,
  };
  let ml = null;
  if (Object.values(pollutants).every((v) => v != null)) {
    try { ml = await api("/predict", { method: "POST", body: pollutants }); } catch {}
  }
  return {
    lat, lon, time: aq.time, us_aqi: aq.us_aqi, uv_index: aq.uv_index, pollutants, source: "live",
    weather: { temp: wx.temperature_2m, feels_like: wx.apparent_temperature, humidity: wx.relative_humidity_2m,
               wind: wx.wind_speed_10m, code: wx.weather_code, is_day: wx.is_day },
    ml,
  };
}

async function fallbackGrid(lat, lon) {
  lat = +lat.toFixed(2); lon = +lon.toFixed(2);
  const step = 0.25, pts = [];
  for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) pts.push([+(lat + i * step).toFixed(3), +(lon + j * step).toFixed(3)]);
  const data = await omGet(OM_AQ, {
    latitude: pts.map((p) => p[0]).join(","), longitude: pts.map((p) => p[1]).join(","), timezone: "auto",
    current: "us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide",
  });
  const items = Array.isArray(data) ? data : [data];
  return {
    points: pts.map(([plat, plon], k) => {
      const c = (items[k] && items[k].current) || {};
      return { lat: plat, lon: plon, us_aqi: c.us_aqi,
        pollutants: { "PM2.5": c.pm2_5, "PM10": c.pm10, "NO2": c.nitrogen_dioxide, "O3": c.ozone, "SO2": c.sulphur_dioxide, "CO": c.carbon_monoxide } };
    }),
  };
}