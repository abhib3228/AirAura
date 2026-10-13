document.addEventListener("DOMContentLoaded", () => {
  // Nav/CTA adapt if already logged in
  if (localStorage.getItem(TOKEN_KEY)) {
    document.querySelectorAll("[data-auth-cta]").forEach((a) => { a.textContent = "Open dashboard"; a.href = "dashboard.html"; });
    document.querySelectorAll("[data-signup]").forEach((a) => { a.style.display = "none"; });
  }

  // GSAP entrance + scroll reveals (skipped for reduced motion)
  if (window.gsap && window.ScrollTrigger && !prefersReduced) {
    gsap.registerPlugin(ScrollTrigger);
    gsap.from("[data-hero]", { y: 30, opacity: 0, duration: 0.9, stagger: 0.12, ease: "power3.out" });
    gsap.utils.toArray("[data-reveal]").forEach((el) =>
      gsap.from(el, { y: 40, opacity: 0, duration: 0.8, ease: "power3.out", scrollTrigger: { trigger: el, start: "top 88%", once: true } })
    );
  }

  // Lazy 3D: wait for idle time, and skip when the user has Data Saver on
  let smog = null, current = 60;
  const apply = (v) => { current = v; if (smog) smog.setAQI(v); };
  const saveData = navigator.connection && navigator.connection.saveData;
  if (!saveData) {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
    idle(async () => {
      try {
        smog = await initSmog($("#smog"));
        smog.setAQI(current);

        // Scroll-driven globe: one full turn, camera pulls back as you scroll
        if (window.gsap && window.ScrollTrigger && !prefersReduced) {
          const st = { trigger: document.body, start: "top top", end: "bottom bottom", scrub: 1 };
          gsap.to(smog.group.rotation, { y: Math.PI * 2, ease: "none", scrollTrigger: st });
          gsap.to(smog.camera.position, { z: 12, ease: "none", scrollTrigger: st });
        }
      } catch (e) {
        console.warn("3D scene disabled:", e);
      }
    });
  }

  // Live AQI for a showcase city (New Delhi); falls back to a direct browser request
  api("/api/air?lat=28.61&lon=77.21")
    .catch(() => fallbackAir(28.61, 77.21))
    .then((d) => {
      if (d.us_aqi == null) throw new Error("no aqi");
      const info = aqiInfo(d.us_aqi);
      countTo($("#heroAqi"), d.us_aqi);
      $("#heroCat").textContent = info.name + (d.source === "ml_estimate" ? " (estimate)" : "");
      $("#heroDot").style.color = $("#heroDot").style.background = info.color;
      $("#preview").value = Math.min(d.us_aqi, 300);
      $("#previewVal").textContent = "AQI " + d.us_aqi;
      apply(d.us_aqi);
    })
    .catch(() => { $("#heroAqi").textContent = "–"; $("#heroCat").textContent = "live data unavailable"; });

  // Slider previews how the scene reacts to AQI
  $("#preview").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("#previewVal").textContent = "AQI " + v;
    apply(v);
  });
});