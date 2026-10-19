/* ===================================================================
   MailCheck Web - interfaz
   =================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  form: $("form"),
  host: $("host"),
  port: $("port"),
  timeout: $("timeout"),
  helo: $("helo"),
  useAuth: $("useAuth"),
  authFields: $("authFields"),
  user: $("user"),
  pass: $("pass"),
  showPass: $("showPass"),
  domain: $("domain"),
  authMech: $("authMech"),
  from: $("from"),
  to: $("to"),
  subject: $("subject"),
  body: $("body"),

  banner: $("banner"),
  bannerTitle: $("bannerTitle"),
  bannerDetail: $("bannerDetail"),
  bannerTime: $("bannerTime"),
  facts: $("facts"),

  log: $("log"),
  busy: $("busy"),
  showTrace: $("showTrace"),
  btnCopyLog: $("btnCopyLog"),
  btnSaveLog: $("btnSaveLog"),
  btnClearLog: $("btnClearLog"),

  status: $("status"),
  progress: $("progress"),
  btnSweep: $("btnSweep"),
  btnCheck: $("btnCheck"),
  btnSend: $("btnSend"),

  sweepDialog: $("sweepDialog"),
  sweepHost: $("sweepHost"),
  sweepPorts: $("sweepPorts"),
  sweepTimeout: $("sweepTimeout"),
  sweepResult: $("sweepResult"),
  sweepRun: $("sweepRun"),
  sweepCancel: $("sweepCancel"),

  identity: $("identity"),
  btnTheme: $("btnTheme"),
  toast: $("toast"),
};

const state = {
  mode: "starttls",
  busy: false,
  logLines: [],
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function setStatus(text) {
  el.status.textContent = text;
}

function setBusy(busy, message = "") {
  state.busy = busy;
  el.btnSend.disabled = busy;
  el.btnCheck.disabled = busy;
  el.btnSweep.disabled = busy;
  el.progress.hidden = !busy;
  el.busy.textContent = busy ? message : "";

  if (busy) {
    setBanner("busy", "Comprobando...", message || "Esperando respuesta del servidor.");
  }
}

function setBanner(stateName, title, detail) {
  el.banner.dataset.state = stateName;
  el.bannerTitle.textContent = title;
  el.bannerDetail.textContent = detail;
  el.bannerTime.textContent =
    stateName === "idle" || stateName === "busy"
      ? ""
      : new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.hidden = true;
  }, 2200);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/* ------------------------------------------------------------------ */
/* Registro                                                            */
/* ------------------------------------------------------------------ */

function renderLog() {
  const hideTrace = !el.showTrace.checked;
  const frag = document.createDocumentFragment();

  for (const line of state.logLines) {
    const div = document.createElement("div");
    div.className = `log-line k-${line.kind}`;
    if (hideTrace && line.kind === "trace") div.classList.add("hidden");
    div.textContent = line.text;
    frag.appendChild(div);
  }

  el.log.replaceChildren(frag);
  el.log.scrollTop = el.log.scrollHeight;
}

function addLog(kind, text) {
  state.logLines.push({ kind, text });
  renderLog();
}

function clearLog() {
  state.logLines = [];
  renderLog();
}

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

function renderFacts(facts) {
  if (!facts || facts.length === 0) {
    el.facts.innerHTML = '<p class="empty">Todavía no hay datos.</p>';
    return;
  }

  const dl = document.createElement("dl");
  dl.className = "facts-list";

  for (const fact of facts) {
    const row = document.createElement("div");
    row.className = "fact";

    const dt = document.createElement("dt");
    dt.textContent = fact.key;

    const dd = document.createElement("dd");
    dd.textContent = fact.value;

    row.append(dt, dd);
    dl.appendChild(row);
  }

  el.facts.replaceChildren(dl);
}

/* ------------------------------------------------------------------ */
/* Formulario                                                          */
/* ------------------------------------------------------------------ */

function syncAuthFields() {
  const enabled = el.useAuth.checked;
  for (const field of el.authFields.querySelectorAll("input, select")) {
    if (field === el.showPass) continue;
    field.disabled = !enabled;
  }
  el.authFields.style.opacity = enabled ? "1" : ".55";
}

function syncPassVisibility() {
  el.pass.type = el.showPass.checked ? "text" : "password";
}

function setMode(mode) {
  state.mode = mode;
  for (const btn of document.querySelectorAll(".seg")) {
    btn.setAttribute("aria-checked", String(btn.dataset.mode === mode));
  }
}

function collectForm() {
  return {
    host: el.host.value.trim(),
    port: Number(el.port.value),
    mode: state.mode,
    timeoutSec: Number(el.timeout.value) || 20,
    helo: el.helo.value.trim(),
    useAuth: el.useAuth.checked,
    user: el.user.value,
    pass: el.pass.value,
    domain: el.domain.value.trim(),
    auth: el.authMech.value,
    from: el.from.value.trim(),
    to: el.to.value.trim(),
    subject: el.subject.value,
    body: el.body.value,
  };
}

function validate(send) {
  if (!el.host.value.trim()) {
    toast("Indica el servidor SMTP.");
    el.host.focus();
    return false;
  }

  const port = Number(el.port.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast("El puerto debe estar entre 1 y 65535.");
    el.port.focus();
    return false;
  }

  if (port === 25) {
    toast("Cloudflare bloquea el puerto 25. Usa 587, 465 o 2525.");
    el.port.focus();
    return false;
  }

  if (el.useAuth.checked && !el.user.value) {
    toast("Indica el usuario o desmarca la autenticación.");
    el.user.focus();
    return false;
  }

  if (send) {
    if (!el.from.value.trim()) {
      toast("Indica el remitente.");
      el.from.focus();
      return false;
    }
    if (!el.to.value.trim()) {
      toast("Indica el destinatario.");
      el.to.focus();
      return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Peticiones                                                          */
/* ------------------------------------------------------------------ */

async function postJson(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.status === 401) {
    throw new Error("No autorizado. Vuelve a iniciar sesión en Cloudflare Access.");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error) || `Error ${res.status}`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

async function run(send) {
  if (state.busy) return;
  if (!validate(send)) return;

  clearLog();
  renderFacts([]);
  setBusy(true, send ? "Conectando y enviando..." : "Conectando...");
  setStatus(send ? "Enviando correo de prueba..." : "Comprobando servidor...");

  const payload = collectForm();
  payload.send = send;

  try {
    const result = await postJson("/api/probe", payload);

    for (const line of result.log || []) addLog(line.kind, line.text);
    renderFacts(result.facts || []);

    setBanner(result.ok ? "ok" : "fail", result.title, result.detail);
    setStatus(result.ok ? `Correcto en ${result.elapsedMs} ms.` : `Fallo en la fase "${result.phase}".`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    addLog("fail", message);
    setBanner("fail", "Error de la aplicación", message);
    setStatus("Error.");
  } finally {
    setBusy(false);
    el.bannerTime.textContent = new Date().toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
}

async function runSweep() {
  const host = el.sweepHost.value.trim();
  if (!host) {
    toast("Indica el servidor a comprobar.");
    return;
  }

  const ports = el.sweepPorts.value
    .split(/[\s,;]+/)
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);

  if (ports.length === 0) {
    toast("Indica al menos un puerto válido.");
    return;
  }

  el.sweepRun.disabled = true;
  el.sweepRun.textContent = "Comprobando...";
  el.sweepResult.innerHTML = '<p class="hint">Probando puertos...</p>';

  try {
    const data = await postJson("/api/sweep", {
      host,
      ports,
      timeoutSec: Number(el.sweepTimeout.value) || 3,
    });

    const rows = data.results
      .map((r) => {
        const stateCell = r.open
          ? '<span class="yes">Abierto</span>'
          : '<span class="no">Cerrado / filtrado</span>';
        const detail = r.open
          ? escapeHtml(r.banner || "—")
          : escapeHtml(r.error || "—");
        return `<tr>
          <td class="mono">${r.port}</td>
          <td>${stateCell}</td>
          <td class="mono">${r.ms} ms</td>
          <td class="mono">${detail}</td>
        </tr>`;
      })
      .join("");

    el.sweepResult.innerHTML = `<table class="sweep-table">
      <thead><tr><th>Puerto</th><th>Estado</th><th>Tiempo</th><th>Banner / error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (e) {
    el.sweepResult.innerHTML = `<p class="hint">${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
  } finally {
    el.sweepRun.disabled = false;
    el.sweepRun.textContent = "Comprobar";
  }
}

/* ------------------------------------------------------------------ */
/* Tema                                                                */
/* ------------------------------------------------------------------ */

const THEME_KEY = "mailcheck-theme";
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_LABEL = {
  auto: "Tema: automático (sigue al sistema)",
  light: "Tema: claro",
  dark: "Tema: oscuro",
};

/** Preferencia guardada: "auto" | "light" | "dark". Por defecto, "auto". */
function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark" || value === "auto") return value;
  } catch {
    /* ignora */
  }
  return "auto";
}

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resuelve "auto" al tema real del sistema. */
function resolveTheme(pref) {
  if (pref === "auto") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

function renderTheme(pref) {
  const effective = resolveTheme(pref);
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;

  el.btnTheme.title = THEME_LABEL[pref];
  el.btnTheme.setAttribute("aria-label", THEME_LABEL[pref]);

  // El icono muestra el tema aplicado: sol en claro, luna en oscuro.
  el.btnTheme.dataset.effective = effective;
}

function applyTheme(pref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignora */
  }
  renderTheme(pref);
}

function initTheme() {
  renderTheme(savedTheme());

  // Si esta en "auto", sigue los cambios del sistema en vivo.
  if (window.matchMedia) {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (savedTheme() === "auto") renderTheme("auto");
    };
    if (query.addEventListener) query.addEventListener("change", onChange);
    else if (query.addListener) query.addListener(onChange);
  }
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(true);
});

el.btnCheck.addEventListener("click", () => run(false));
el.btnSweep.addEventListener("click", () => {
  el.sweepHost.value = el.host.value.trim();
  el.sweepResult.innerHTML = "";
  el.sweepDialog.showModal();
});

for (const btn of document.querySelectorAll(".seg")) {
  btn.addEventListener("click", () => {
    setMode(btn.dataset.mode);
    // Sugiere el puerto habitual al cambiar el modo.
    const port = Number(el.port.value);
    if (btn.dataset.mode === "implicit" && (port === 587 || port === 25)) el.port.value = "465";
    if (btn.dataset.mode === "starttls" && (port === 465 || port === 25)) el.port.value = "587";
  });
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    const port = chip.dataset.port;
    el.port.value = port;

    if (port === "465") setMode("implicit");
    else if (port === "25") {
      setMode("plain");
      toast("El puerto 25 no se puede probar desde Cloudflare.");
    } else setMode("starttls");
  });
}

el.useAuth.addEventListener("change", syncAuthFields);
el.showPass.addEventListener("change", syncPassVisibility);

el.showTrace.addEventListener("change", renderLog);

el.btnClearLog.addEventListener("click", () => {
  clearLog();
  toast("Registro vacío.");
});

el.btnCopyLog.addEventListener("click", async () => {
  const text = state.logLines.map((l) => l.text).join("\n");
  if (!text) return toast("No hay nada que copiar.");

  try {
    await navigator.clipboard.writeText(text);
    toast("Registro copiado.");
  } catch {
    toast("No se pudo copiar al portapapeles.");
  }
});

el.btnSaveLog.addEventListener("click", () => {
  const text = state.logLines.map((l) => l.text).join("\n");
  if (!text) return toast("No hay nada que guardar.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `mailcheck-${stamp}.log`;
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Registro guardado.");
});

el.sweepCancel.addEventListener("click", () => el.sweepDialog.close());
el.sweepRun.addEventListener("click", runSweep);

el.btnTheme.addEventListener("click", () => {
  const current = savedTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  applyTheme(next);
});

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function init() {
  initTheme();
  syncAuthFields();
  syncPassVisibility();
  setMode("starttls");
  renderFacts([]);
  renderLog();
  setBanner("idle", "Sin comprobaciones", "Rellena los datos y pulsa «Enviar correo de prueba».");

  // Marca el chip del puerto 25 como limitado.
  const chip25 = document.querySelector('.chip[data-port="25"]');
  if (chip25) {
    chip25.dataset.blocked = "true";
    chip25.title = "Cloudflare bloquea el puerto 25";
  }

  // Identidad de Cloudflare Access (si esta activo).
  try {
    const res = await fetch("/api/me", { method: "POST" });
    if (res.ok) {
      const me = await res.json();
      if (me.email) {
        el.identity.textContent = me.email;
        el.identity.hidden = false;
      }
    }
  } catch {
    /* opcional */
  }
}

init();
