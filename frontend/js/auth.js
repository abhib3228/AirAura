document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem(TOKEN_KEY)) return location.replace("dashboard.html");

  const form = $("form[data-mode]");
  const mode = form.dataset.mode;
  const formError = $(".form-error", form);
  const button = $("button[type=submit]", form);
  const label = button.textContent;

  const setErr = (field, msg) => {
    const el = $(`[data-for="${field}"]`, form), input = form.elements[field];
    if (el) el.textContent = msg || "";
    if (input) input.classList.toggle("invalid", !!msg);
  };

  // Client-side checks mirror the server rules so users get instant feedback
  function validate(v) {
    const e = {};
    if (mode === "register" && v.name.trim().length < 2) e.name = "Please enter your name (at least 2 characters).";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) e.email = "Please enter a valid email address.";
    if (mode === "register") {
      if (v.password.length < 8) e.password = "Password must be at least 8 characters.";
      else if (!/[A-Za-z]/.test(v.password) || !/\d/.test(v.password)) e.password = "Use at least one letter and one number.";
    } else if (!v.password) e.password = "Please enter your password.";
    return e;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    formError.hidden = true;
    ["name", "email", "password"].forEach((f) => setErr(f, ""));

    const values = { name: form.elements.name?.value || "", email: form.elements.email.value.trim(), password: form.elements.password.value };
    const errors = validate(values);
    if (Object.keys(errors).length) { Object.entries(errors).forEach(([f, m]) => setErr(f, m)); return; }

    button.disabled = true; button.textContent = "Please wait…";
    try {
      const body = mode === "register" ? values : { email: values.email, password: values.password };
      const data = await api(`/api/auth/${mode}`, { method: "POST", body });
      localStorage.setItem(TOKEN_KEY, data.token);
      location.replace("dashboard.html");
    } catch (e) {
      Object.entries(e.fields || {}).forEach(([f, m]) => setErr(f, m));
      formError.textContent = e.message;
      formError.hidden = false;
      button.disabled = false; button.textContent = label;
    }
  });
});