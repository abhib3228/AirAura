const ALERT_KEY = "airaura_alert_level";
// One-line advice per band; index matches AQI_BANDS (colours and labels come from aqiInfo in api.js)
const SHORT = [
  "Air is good. Enjoy the outdoors.",
  "Unusually sensitive people may want shorter outdoor sessions.",
  "Sensitive groups should limit outdoor activity.",
  "Everyone should reduce prolonged outdoor exertion.",
  "Avoid outdoor activity. Wear an N95 mask if you must go out.",
  "Emergency conditions. Stay indoors.",
];
const Alerts = {
  _current: null, _dismissed: null,
  level() { return Number(localStorage.getItem(ALERT_KEY)) || 101; },  // 101 = AQI above 100
  render(items) {  // items: [{ name, aqi, time }]
    const lvl = Alerts.level(), ul = $("#alertList");
    const hits = items.filter((i) => i.aqi != null && i.aqi >= lvl).sort((a, b) => b.aqi - a.aqi).slice(0, 5);
    const missing = items.filter((i) => i.aqi == null).length;
    ul.innerHTML = hits.length
      ? hits.map((h) => {
          const i = aqiInfo(h.aqi);
          return `<li style="border-left-color:${i.color}"><b>${esc(h.name)}</b>
            <span class="sev" style="color:${i.color}">AQI ${esc(h.aqi)} · ${esc(i.name)}</span>
            <small>${esc(h.time ? h.time.replace("T", " ") + " local · modeled" : "time unavailable")}</small>
            <span>${esc(SHORT[i.index])}</span></li>`;
        }).join("")
      : `<li class="ok">No monitored location is at or above AQI ${lvl} in the latest data.</li>`;
    if (missing) ul.insertAdjacentHTML("beforeend", `<li class="ok">${missing} location(s) had no data right now.</li>`);
  },
  banner(name, aqi) {  // dismissible banner when the selected location is above AQI 150
    const el = $("#alertBanner");
    if (aqi == null || aqi <= 150 || Alerts._dismissed === name) { el.hidden = true; return; }
    Alerts._current = name;
    const i = aqiInfo(aqi);
    $("#alertBannerText").textContent = `${name}: AQI ${aqi} (${i.name}). ${SHORT[i.index]}`;
    el.hidden = false;
  },
};
$("#alertClose").onclick = () => { Alerts._dismissed = Alerts._current; $("#alertBanner").hidden = true; };