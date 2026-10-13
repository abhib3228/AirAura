// Health advice per AQI band (index matches AQI_BANDS)
const ADVICE = [
  { summary: "Air quality is satisfactory and poses little or no risk.",
    general: "Enjoy normal outdoor activity. Opening windows is fine.",
    sensitive: "Children and older adults can play and walk outside as usual.",
    patients: "No special precautions. Keep any prescribed inhaler or medication with you as usual.",
    exercise: "A great time for runs, cycling, and sports outdoors.",
    mask: "Not needed.", purifier: "Not needed." },
  { summary: "Acceptable air, though a few unusually sensitive people may notice effects.",
    general: "Fine for most people. Unusually sensitive people may want shorter outdoor sessions.",
    sensitive: "Generally fine. Watch for coughing or tiredness during long time outdoors.",
    patients: "Carry your inhaler or medication. Ease off if symptoms start.",
    exercise: "Fine for most. Sensitive people should take it a little easier on long efforts.",
    mask: "Not needed.", purifier: "Optional for bedrooms if you are sensitive." },
  { summary: "People in sensitive groups may feel effects. Most others are fine.",
    general: "Reduce long or heavy outdoor exertion if you notice irritation.",
    sensitive: "Limit prolonged outdoor play and walks. Choose shorter, calmer activities.",
    patients: "Limit time outdoors, keep rescue medication close, and follow your doctor's action plan.",
    exercise: "Shorten or lower the intensity of outdoor workouts, or move indoors.",
    mask: "Sensitive groups: consider a well-fitted N95/FFP2 outdoors.", purifier: "Helpful indoors for sensitive groups (HEPA)." },
  { summary: "Everyone may begin to feel effects. Sensitive groups may feel more serious ones.",
    general: "Cut down on prolonged outdoor exertion. Take more breaks and keep activity light.",
    sensitive: "Keep children and older adults indoors where possible.",
    patients: "Stay indoors, keep windows closed, and have medication ready. Contact a doctor if symptoms worsen.",
    exercise: "Exercise indoors today.",
    mask: "Wear a well-fitted N95/FFP2 outdoors.", purifier: "Run a HEPA purifier in the rooms you use most." },
  { summary: "Health warning: everyone is more likely to be affected.",
    general: "Avoid outdoor exertion and keep windows closed.",
    sensitive: "Keep children and older adults indoors with clean air.",
    patients: "Stay indoors, follow your care plan, and seek medical advice if you feel unwell.",
    exercise: "Skip outdoor exercise. Light indoor activity only.",
    mask: "N95/FFP2 for any time outside.", purifier: "Run a HEPA purifier continuously." },
  { summary: "Emergency conditions. Serious health effects are likely for everyone.",
    general: "Stay indoors, avoid going out unless essential, and keep windows and doors closed.",
    sensitive: "Keep children and older adults indoors in the cleanest room available.",
    patients: "Stay inside, use your medication as directed, and seek medical help early if symptoms appear.",
    exercise: "No outdoor exercise.",
    mask: "N95/FFP2 if you must go out.", purifier: "Run HEPA purifiers continuously and seal gaps where you can." },
];

const POLLUTANTS = ["PM2.5", "PM10", "NO2", "O3", "SO2", "CO"];
const CITY_KEY = "airaura_city";
const DEFAULT_CITY = { name: "Delhi", country: "India", lat: 28.6139, lon: 77.209 };
const FRIENDLY_ERROR = "Live data is temporarily unavailable. Please try again shortly.";

const WX = (c) => {
  if (c == null) return "–";
  if (c === 0) return "☀️ Clear";
  if (c <= 3) return "⛅ Partly cloudy";
  if (c === 45 || c === 48) return "🌫️ Fog";
  if (c >= 51 && c <= 57) return "🌦️ Drizzle";
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "🌧️ Rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "❄️ Snow";
  if (c >= 95) return "⛈️ Thunderstorm";
  return "☁️ Cloudy";
};

// Coordinates only; every AQI value on the globe comes from the API (mirrors WATCH in app.py)
const WATCH = [["Delhi", 28.61, 77.21], ["Beijing", 39.90, 116.40], ["London", 51.51, -0.13], ["New York", 40.71, -74.01],
  ["Cairo", 30.04, 31.24], ["São Paulo", -23.55, -46.63], ["Sydney", -33.87, 151.21], ["Tokyo", 35.68, 139.69],
  ["Lagos", 6.52, 3.38], ["Mexico City", 19.43, -99.13]];

async function fallbackGlobe() {  // browser-side version, used if the backend can't reach Open-Meteo
  const d = await omGet(OM_AQ, {
    latitude: WATCH.map((w) => w[1]).join(","), longitude: WATCH.map((w) => w[2]).join(","),
    current: "us_aqi,pm2_5", timezone: "auto",
  });
  const items = Array.isArray(d) ? d : [d];
  return { points: WATCH.map(([name, lat, lon], i) => {
    const c = (items[i] && items[i].current) || {};
    return { name, lat, lon, us_aqi: c.us_aqi, pm2_5: c.pm2_5, time: c.time };
  }) };
}

(async function () {
  // ---- Auth gate -----------------------------------------------------------
  if (!localStorage.getItem(TOKEN_KEY)) return location.replace("login.html");
  try { $("#userName").textContent = (await api("/api/auth/me")).user.name; }
  catch { localStorage.removeItem(TOKEN_KEY); return location.replace("login.html"); }
  $("#logout").onclick = () => { localStorage.removeItem(TOKEN_KEY); location.replace("login.html"); };

  const state = { city: null, band: 0, tab: "general", favs: [] };
  let reqId = 0, map, mapLayer, chart;
  let earth = null, watch = [], lastAir = null, lastGrid = [];

  // ---- Entrance animations -------------------------------------------------
  if (window.gsap && window.ScrollTrigger && !prefersReduced) {
    gsap.registerPlugin(ScrollTrigger);
    gsap.set(".card", { opacity: 0 });
    ScrollTrigger.batch(".card", {
      once: true, start: "top 92%",
      onEnter: (els) => gsap.fromTo(els, { y: 30, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.1, duration: 0.6, ease: "power2.out" }),
    });
  }

  // ---- Helpers -------------------------------------------------------------
  const cityLabel = (c) => (c.country ? `${c.name}, ${c.country}` : c.name);
  const showNotice = (m) => { const n = $("#status"); n.textContent = m; n.hidden = false; };
  const hideNotice = () => ($("#status").hidden = true);
  const same = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

  // Free Render instances sleep; tell the user why the first load is slow
  window.addEventListener("airaura:slow", () => showNotice("Waking up the server… free instances sleep after inactivity, so the first load can take up to a minute."));
  window.addEventListener("airaura:ready", hideNotice);

  // ---- Search (debounced) --------------------------------------------------
  const results = $("#results");
  const hideResults = () => (results.hidden = true);
  function showResults(list) {
    results.innerHTML = "";
    if (!list.length) { results.innerHTML = '<li class="muted">No matches found</li>'; results.hidden = false; return; }
    list.forEach((r) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.innerHTML = `${esc(r.name)} <small>${esc([r.admin1, r.country].filter(Boolean).join(", "))}</small>`;
      const pick = () => { hideResults(); $("#q").value = ""; selectCity({ name: r.name, country: r.country, lat: r.lat, lon: r.lon }); };
      li.onclick = pick;
      li.onkeydown = (e) => e.key === "Enter" && pick();
      results.appendChild(li);
    });
    results.hidden = false;
  }
  const doSearch = debounce(async (q) => {
    if (q.length < 2) return hideResults();
    try { showResults((await api("/api/geocode?q=" + encodeURIComponent(q))).results); }
    catch (e) { showNotice(e.message || FRIENDLY_ERROR); }
  }, 350);
  $("#q").addEventListener("input", (e) => doSearch(e.target.value.trim()));
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideResults(); });
  document.addEventListener("keydown", (e) => e.key === "Escape" && hideResults());

  $("#locate").onclick = () => {
    if (!navigator.geolocation) return showNotice("Your browser doesn't support location access.");
    navigator.geolocation.getCurrentPosition(
      (p) => selectCity({ name: "My location", country: "", lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }),
      () => showNotice("Couldn't get your location. Allow location access, or search for a city instead."),
      { timeout: 10000 }
    );
  };

  // ---- Favorites -----------------------------------------------------------
  function renderFavs() {
    const box = $("#favs");
    box.innerHTML = "";
    state.favs.forEach((f) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const go = document.createElement("span");
      go.textContent = f.name;
      go.onclick = () => selectCity({ name: f.name, country: f.country, lat: f.lat, lon: f.lon });
      const del = document.createElement("button");
      del.setAttribute("aria-label", "Remove " + f.name);
      del.textContent = "×";
      del.onclick = async () => { try { state.favs = (await api("/api/favorites/" + f.id, { method: "DELETE" })).favorites; renderFavs(); updateSaveBtn(); } catch (e) { showNotice(e.message); } };
      chip.append(go, del);
      box.appendChild(chip);
    });
  }
  function updateSaveBtn() {
    const saved = state.city && state.favs.some((f) => same(f, state.city));
    $("#saveFav").textContent = saved ? "★ Saved" : "☆ Save city";
    $("#saveFav").disabled = !!saved;
  }
  $("#saveFav").onclick = async () => {
    try {
      state.favs = (await api("/api/favorites", { method: "POST", body: state.city })).favorites;
      renderFavs(); updateSaveBtn();
    } catch (e) { showNotice(e.message); }
  };

  // ---- Rendering -----------------------------------------------------------
  function tile(label, value, unit = "") {
    return `<div class="tile"><small>${esc(label)}</small><b class="sk">${esc(value)}</b><i>${esc(unit)}</i></div>`;
  }
  function renderAdvice() {
    const a = ADVICE[state.band];
    $("#panel").textContent = a[state.tab];
    $("#mask").textContent = a.mask;
    $("#purifier").textContent = a.purifier;
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    state.tab = t.dataset.tab; renderAdvice();
    FX.tab();
  }));

  // Badge: green Live, yellow Cached, orange ML estimate
  function renderSource(air) {
    const s = air.source || "live";
    const m = {
      live: ["#22c55e", "Live"],
      cached: ["#eab308", `Cached (${Math.max(1, Math.round((air.age_s || 0) / 60))} min ago)`],
      ml_estimate: ["#f97316", "ML estimate"],
    }[s] || ["#94a3b8", s];
    $("#srcBadge").style.setProperty("--c", m[0]);
    $("#srcBadge").textContent = m[1];
    $("#srcNote").textContent =
      s === "ml_estimate" ? "A prediction from typical past levels near this place, not a measurement."
      : s === "cached" ? "Live data is unreachable, so this is the last successful reading."
      : "Modeled by Open-Meteo (CAMS), not a ground station.";
  }

  function renderAir(air) {
    const aqi = air.us_aqi, info = aqiInfo(aqi);
    state.band = info.index;

    // Gauge arc (0 to 300 scale)
    const pct = Math.min(aqi || 0, 300) / 3;
    const arc = $("#arc");
    arc.style.stroke = info.color;
    if (window.gsap && !prefersReduced) gsap.to(arc, { strokeDashoffset: 100 - pct, duration: 1.2, ease: "power3.out" });
    else arc.style.strokeDashoffset = 100 - pct;

    countTo($("#aqiVal"), aqi);
    const pill = $("#aqiCat");
    pill.textContent = aqi == null ? "No data" : info.name;
    pill.style.background = info.color + "33"; pill.style.color = info.color; pill.style.borderColor = info.color + "88";
    $("#aqiAdvice").textContent = ADVICE[info.index].summary;
    $("#updated").textContent = air.time ? "Reading time " + air.time.replace("T", " ") + " (local time)" : "";

    const w = air.weather || {};
    const f = (v, d = 0) => (v == null ? "–" : Number(v).toFixed(d));
    $("#weather").innerHTML =
      tile("Temperature", f(w.temp, 1), "°C") + tile("Feels like", f(w.feels_like, 1), "°C") + tile("Humidity", f(w.humidity), "%") +
      tile("Wind", f(w.wind, 1), "km/h") + tile("UV index", f(air.uv_index, 1)) + tile("Conditions", WX(w.code));
    $("#pollutants").innerHTML = POLLUTANTS.map((p) => tile(p, f((air.pollutants || {})[p], 1))).join("");
    renderAdvice();
    renderSource(air);
    FX.onData(info);
  }

  function renderCompare(air) {
    const live = air.us_aqi, ml = air.ml;
    if (air.source === "ml_estimate") {  // no live reading exists, so there is nothing to compare against
      $("#liveAqi").textContent = "–"; $("#mlAqi").textContent = air.us_aqi ?? "–";
      $("#diff").textContent = "No live reading to compare."; $("#mlNote").textContent = "";
      return;
    }
    countTo($("#liveAqi"), live);
    if (!ml) {
      $("#mlAqi").textContent = "–"; $("#diff").textContent = "ML model unavailable. Run train_model.py and redeploy.";
      $("#mlNote").textContent = ""; return;
    }
    countTo($("#mlAqi"), ml.aqi_us_equiv);
    const d = ml.aqi_us_equiv - (live ?? 0);
    $("#diff").textContent = live == null ? "–" : d === 0 ? "Identical" : `Difference: ${d > 0 ? "+" : ""}${d} (ML is ${d > 0 ? "higher" : "lower"})`;
    $("#mlNote").textContent = `Model trained on Indian NAQI data: it predicts ${ml.aqi_india} (${ml.category_india}), converted to the US scale for comparison. Expect larger gaps outside India.`;

    const data = [live ?? 0, ml.aqi_us_equiv];
    const colors = data.map((v) => aqiInfo(v).color);
    if (chart) { chart.data.datasets[0].data = data; chart.data.datasets[0].backgroundColor = colors; chart.update(); return; }
    chart = new Chart($("#chart"), {
      type: "bar",
      data: { labels: ["Live API", "ML predicted"], datasets: [{ data, backgroundColor: colors, borderRadius: 8 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: prefersReduced ? false : undefined,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { color: "#cbd5e1" }, grid: { color: "rgba(255,255,255,.08)" } },
          x: { ticks: { color: "#cbd5e1" }, grid: { display: false } },
        },
      },
    });
  }

  function renderMap(air, points) {
    if (!map) {
      map = L.map("map", { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
      const legend = L.control({ position: "bottomright" });
      legend.onAdd = () => {
        const d = L.DomUtil.create("div", "legend");
        d.innerHTML = "<b>US AQI</b><br>" + AQI_BANDS.map((b, i) => `<i style="background:${b.color}"></i>${i ? AQI_BANDS[i - 1].max + 1 : 0}–${b.max} ${esc(b.name)}`).join("<br>");
        return d;
      };
      legend.addTo(map);
      setTimeout(() => map.invalidateSize(), 300);
    }
    map.setView([air.lat, air.lon], 9);
    mapLayer.clearLayers();
    const when = air.time ? air.time.replace("T", " ") : "time n/a";
    points.forEach((p) => {
      if (p.us_aqi == null) {  // missing measurement: grey marker, never an invented value
        L.circleMarker([p.lat, p.lon], { radius: 8, color: "#94a3b8", weight: 1, fillOpacity: 0.1 }).bindPopup("No data for this point right now.").addTo(mapLayer);
        return;
      }
      const info = aqiInfo(p.us_aqi), isCenter = same(p, air);
      L.circle([p.lat, p.lon], { radius: 14000, stroke: false, fillColor: info.color, fillOpacity: 0.2 }).addTo(mapLayer); // soft "heat" halo
      const rows = Object.entries(p.pollutants).map(([k, v]) => `${esc(k)}: ${v == null ? "–" : Number(v).toFixed(1)}`).join("<br>");
      L.circleMarker([p.lat, p.lon], { radius: isCenter ? 16 : 12, color: "#fff", weight: isCenter ? 2 : 1, fillColor: info.color, fillOpacity: 0.8 })
        .bindPopup(`<b>${isCenter ? esc(cityLabel(state.city)) : "Nearby point"}</b><br>US AQI <b>${p.us_aqi}</b> (${esc(info.name)})<hr style="opacity:.2">${rows}<br><small>Modeled · ${esc(when)} · Open-Meteo/CAMS</small>`)
        .addTo(mapLayer);
    });
  }

  // ---- Alerts --------------------------------------------------------------
  function refreshAlerts() {
    const items = [];
    if (lastAir && state.city) items.push({ name: cityLabel(state.city), aqi: lastAir.us_aqi, time: lastAir.time });
    lastGrid.forEach((p) => { if (!state.city || !same(p, state.city)) items.push({ name: `Nearby point ${p.lat}, ${p.lon}`, aqi: p.us_aqi, time: lastAir && lastAir.time }); });
    watch.forEach((w) => items.push({ name: w.name, aqi: w.us_aqi, time: w.time }));
    Alerts.render(items);
    Alerts.banner(state.city ? cityLabel(state.city) : "", lastAir && lastAir.us_aqi);
  }

  // ---- Load a city ---------------------------------------------------------
  async function selectCity(city) { await loadAll(city); }
  async function loadAll(city) {
    const id = ++reqId;
    state.city = city;
    localStorage.setItem(CITY_KEY, JSON.stringify(city));
    $("#dash").classList.add("loading");
    $("#cityName").textContent = cityLabel(city);
    hideNotice();
    try {
      const q = `?lat=${city.lat}&lon=${city.lon}`;
      // Chain: backend (live -> cached -> ML estimate). If the backend couldn't get live data, try Open-Meteo straight from the browser.
      const [air, grid] = await Promise.all([
        api("/api/air" + q)
          .then((d) => (d.source !== "live" ? fallbackAir(city.lat, city.lon).catch(() => d) : d))
          .catch(() => fallbackAir(city.lat, city.lon)),
        api("/api/grid" + q).catch(() => fallbackGrid(city.lat, city.lon)).catch(() => ({ points: [] })),
      ]);
      if (id !== reqId) return; // a newer search finished first
      renderAir(air); renderCompare(air); renderMap(air, grid.points || []);
      lastAir = air; lastGrid = grid.points || [];
      if (earth) earth.focus(city.lat, city.lon, air.us_aqi);
      refreshAlerts();
    } catch (e) {
      if (id === reqId) showNotice(e && e.message && !/^Open-Meteo/.test(e.message) ? e.message : FRIENDLY_ERROR);
    } finally {
      if (id === reqId) { $("#dash").classList.remove("loading"); updateSaveBtn(); }
    }
  }

  // ---- Start ---------------------------------------------------------------
  try { state.favs = (await api("/api/favorites")).favorites; renderFavs(); } catch {}
  let start = DEFAULT_CITY;
  try { start = JSON.parse(localStorage.getItem(CITY_KEY)) || DEFAULT_CITY; } catch {}

  FX.tilt();
  $("#alertLevel").value = Alerts.level();
  $("#alertLevel").onchange = (e) => { localStorage.setItem(ALERT_KEY, e.target.value); refreshAlerts(); };
  $("#refresh").onclick = () => loadAll(state.city);

  initEarth($("#earthBox"), { onSelect: (c) => selectCity(c) }).then((e) => {
    earth = e;
    if (!earth) return;  // WebGL unavailable: the fallback message is already showing
    if (state.city) earth.focus(state.city.lat, state.city.lon, lastAir && lastAir.us_aqi);
    api("/api/globe").catch(() => fallbackGlobe())
      .then((d) => { watch = d.points; earth.setMarkers(watch); refreshAlerts(); })
      .catch(() => {});
  });
  loadAll(start);
})();