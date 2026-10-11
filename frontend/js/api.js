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

// Lazy-load a script once (used for Three.js so it never blocks first paint)
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
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw { message: "Can't reach the server. On Render's free tier it may be waking up, so please try again in about 30 seconds." };
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