const FX = {
  // 3D card tilt under the cursor (desktop, motion allowed)
  tilt() {
    if (prefersReduced || !window.gsap || !matchMedia("(hover: hover)").matches) return;
    document.querySelectorAll(".card").forEach((card) => {
      const rx = gsap.quickTo(card, "rotationX", { duration: 0.5, ease: "power3.out" });
      const ry = gsap.quickTo(card, "rotationY", { duration: 0.5, ease: "power3.out" });
      gsap.set(card, { transformPerspective: 900 });
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        ry(((e.clientX - r.left) / r.width - 0.5) * 6);
        rx(-((e.clientY - r.top) / r.height - 0.5) * 6);
      });
      card.addEventListener("pointerleave", () => { rx(0); ry(0); });
    });
  },
  // Called after each successful data load
  onData(info) {
    document.documentElement.style.setProperty("--glow", info.color);
    if (prefersReduced || !window.gsap) return;
    gsap.from(".tile", { y: 18, opacity: 0, scale: 0.92, duration: 0.5, stagger: 0.04, ease: "back.out(1.6)", clearProps: "all" });
    gsap.fromTo("#aqiCat", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: "elastic.out(1, 0.5)" });
    gsap.fromTo("#cityName", { y: -10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5 });
    gsap.from(".gear div", { x: -16, opacity: 0, stagger: 0.1, duration: 0.5, clearProps: "all" });
  },
  // Called when a health tab changes
  tab() {
    if (prefersReduced || !window.gsap) return;
    gsap.fromTo("#panel", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" });
  },
};