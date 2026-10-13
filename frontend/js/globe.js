// Pin to an exact version you've checked on npm (at least two weeks old). 2.32.0 is my best guess and I couldn't verify it.
const GLOBE_URL = "https://cdn.jsdelivr.net/npm/globe.gl@2.32.0/dist/globe.gl.min.js";
const IMG = "https://unpkg.com/three-globe/example/img/";

// initEarth(box, { onSelect }) -> { setMarkers(points), focus(lat, lon, aqi), zoom(d) }, or null when 3D is unavailable
async function initEarth(box, { onSelect }) {
  const el = $("#earthCanvas", box);
  box.classList.add("loading");
  try {
    const t = document.createElement("canvas");
    if (!(t.getContext("webgl2") || t.getContext("webgl"))) throw new Error("no webgl");
    await loadScript(GLOBE_URL);
  } catch { box.classList.remove("loading"); box.classList.add("no3d"); return null; }

  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`; };
  const globe = Globe()(el)
    .width(el.clientWidth).height(el.clientHeight)
    .backgroundImageUrl(IMG + "night-sky.png")
    .globeImageUrl(IMG + "earth-blue-marble.jpg")
    .bumpImageUrl(IMG + "earth-topology.png")
    .atmosphereColor("#38bdf8").atmosphereAltitude(0.2)
    .pointLat("lat").pointLng("lng").pointColor((d) => d.color).pointAltitude(0.03).pointRadius(0.5)
    .pointLabel((d) => `<b>${esc(d.name)}</b><br>${d.us_aqi == null ? "No data" : "AQI " + d.us_aqi + " · " + esc(aqiInfo(d.us_aqi).name)}`)
    .onPointClick((d) => onSelect({ name: d.name, country: "", lat: d.lat, lon: d.lng }))
    .onGlobeClick(({ lat, lng }) => onSelect({ name: `${lat.toFixed(1)}°, ${lng.toFixed(1)}°`, country: "", lat: +lat.toFixed(2), lon: +lng.toFixed(2) }))
    .ringLat("lat").ringLng("lng").ringColor((d) => (t) => `rgba(${rgb(d.color)}, ${1 - t})`)
    .ringMaxRadius(5).ringPropagationSpeed(2).ringRepeatPeriod(1400)
    .onGlobeReady(() => box.classList.remove("loading"));
  setTimeout(() => box.classList.remove("loading"), 8000); // never leave the spinner up forever

  const ctl = globe.controls();
  ctl.autoRotate = !prefersReduced; ctl.autoRotateSpeed = 0.35; ctl.minDistance = 160; ctl.maxDistance = 500;
  el.addEventListener("pointerdown", () => (ctl.autoRotate = false));
  new ResizeObserver(() => globe.width(el.clientWidth).height(el.clientHeight)).observe(el);
  new IntersectionObserver(([e]) => (e.isIntersecting ? globe.resumeAnimation() : globe.pauseAnimation())).observe(el);

  // Markers come from API data only; a missing value is drawn grey. Rings pulse for AQI > 100.
  let marks = [], sel = null;
  const mk = (name, lat, lon, aqi) => ({ name, lat, lng: lon, us_aqi: aqi, color: aqi == null ? "#94a3b8" : aqiInfo(aqi).color });
  const draw = () => {
    const all = sel ? [...marks, sel] : marks;
    globe.pointsData(all);
    globe.ringsData(prefersReduced ? [] : all.filter((m) => m.us_aqi > 100));
  };
  const handle = {
    setMarkers(points) { marks = points.map((p) => mk(p.name, p.lat, p.lon, p.us_aqi)); draw(); },
    focus(lat, lon, aqi) { sel = mk("Selected location", lat, lon, aqi); draw(); ctl.autoRotate = false; globe.pointOfView({ lat, lng: lon, altitude: 1.8 }, prefersReduced ? 0 : 1000); },
    zoom(d) { const p = globe.pointOfView(); globe.pointOfView({ altitude: Math.min(4, Math.max(0.6, p.altitude + d)) }, 250); },
  };
  box.querySelectorAll("[data-z]").forEach((b) => (b.onclick = () => handle.zoom(Number(b.dataset.z) * 0.4)));
  return handle;
}