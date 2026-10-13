// initSmog(canvas, { variant: "hero" | "dash" }) -> { setAQI, group, camera }
async function initSmog(canvas, opts = {}) {
  await loadScript("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js");

  const dash = opts.variant === "dash";
  const small = window.innerWidth < 768;
  const MAX = dash ? (small ? 600 : 1400) : (small ? 1000 : 3200);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !small, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.z = dash ? 11 : 9;

  const group = new THREE.Group();
  group.position.set(dash ? (small ? 0 : 5) : (small ? 0 : 2.4), dash ? (small ? 3.5 : -0.5) : 0, dash ? -2 : 0);
  scene.add(group);

  // Smog particles
  const pos = new Float32Array(MAX * 3);
  for (let i = 0; i < MAX; i++) {
    const r = 2.8 + Math.random() * 7, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    size: small ? 0.07 : 0.05, transparent: true, opacity: dash ? 0.5 : 0.8,
    depthWrite: false, blending: THREE.AdditiveBlending, color: 0x22c55e,
  });
  const points = new THREE.Points(geo, mat);
  group.add(points);

  // Globe: dark core + wireframe
  const globeMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, wireframe: true, transparent: true, opacity: dash ? 0.14 : 0.28 });
  const globe = new THREE.Mesh(new THREE.IcosahedronGeometry(2, 3), globeMat);
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.9, 32, 32), new THREE.MeshBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.85 }));
  group.add(core, globe);

  // Atmosphere glow (fresnel shader)
  const atmoColor = { value: new THREE.Color(0x22c55e) };
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(2.35, 48, 48),
    new THREE.ShaderMaterial({
      uniforms: { uColor: atmoColor }, transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: "varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform vec3 uColor; varying vec3 vN; void main(){ float i = pow(max(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 0.0), 3.0); gl_FragColor = vec4(uColor, 1.0) * i * " + (dash ? "1.0" : "1.7") + "; }",
    })
  );
  group.add(atmo);

  // Orbiting rings
  const rings = [3.1, 3.6].map((r, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 8, 120), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: dash ? 0.12 : 0.3 }));
    m.rotation.set(1.2 + i * 0.5, i * 0.8, 0);
    group.add(m);
    return m;
  });

  // Glowing city nodes on the globe (lat, lon)
  const CITIES = [[28.6, 77.2], [39.9, 116.4], [51.5, -0.1], [40.7, -74], [-33.9, 151.2], [30, 31.2], [-23.5, -46.6], [35.7, 139.7]];
  const nodes = CITIES.map(([la, lo]) => {
    const phi = (90 - la) * Math.PI / 180, th = (lo + 180) * Math.PI / 180, R = 2.03;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.position.set(-R * Math.sin(phi) * Math.cos(th), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(th));
    globe.add(m);
    return m;
  });

  const target = new THREE.Color(0x22c55e);
  let speed = 1, raf = 0, running = false, mx = 0, my = 0;
  const clock = new THREE.Clock();

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!running) renderer.render(scene, camera);
  }
  function frame() {
    const t = clock.getElapsedTime();
    mat.color.lerp(target, 0.06);
    globeMat.color.copy(mat.color);
    atmoColor.value.copy(mat.color);
    points.rotation.y += 0.0015 * speed;
    points.rotation.x = Math.sin(t * 0.2) * 0.1;
    globe.rotation.y += 0.002;
    rings[0].rotation.z += 0.003; rings[1].rotation.z -= 0.002;
    atmo.scale.setScalar(1 + Math.sin(t * 1.4) * 0.015 * speed);
    nodes.forEach((n, i) => n.scale.setScalar(1 + 0.6 * Math.abs(Math.sin(t * 2 + i))));
    group.rotation.x += (my * 0.2 - group.rotation.x) * 0.04;
    camera.position.x += (mx * 0.6 - camera.position.x) * 0.04;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  const start = () => { if (!running && !prefersReduced) { running = true; raf = requestAnimationFrame(frame); } };
  const stop = () => { running = false; cancelAnimationFrame(raf); };

  window.addEventListener("pointermove", (e) => { mx = (e.clientX / innerWidth - 0.5) * 2; my = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  resize(); start();

  return {
    group, camera,
    setAQI(aqi) {
      target.set(aqiInfo(aqi).color);
      const density = Math.min(Math.max(aqi / 300, 0.12), 1);
      geo.setDrawRange(0, Math.floor(MAX * density));
      mat.opacity = (dash ? 0.35 : 0.55) + 0.35 * density;
      speed = 0.6 + density * 2.5;
      if (window.gsap && !prefersReduced)
        gsap.fromTo(group.scale, { x: 1.07, y: 1.07, z: 1.07 }, { x: 1, y: 1, z: 1, duration: 1.3, ease: "elastic.out(1, 0.45)" });
      if (!running) { mat.color.copy(target); renderer.render(scene, camera); }
    },
  };
}