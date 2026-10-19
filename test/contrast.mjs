/**
 * Guarda de contraste WCAG AA para la paleta de MailCheck.
 *
 * Los valores deben coincidir con las variables de `public/styles.css`.
 * Si alguien cambia un color y baja del minimo, `npm test` falla.
 *
 * Minimos (HIG › Accessibility): 4.5:1 para texto hasta 17 pt y para texto
 * en negrita hasta 18 pt; 3:1 para texto grande y para componentes de interfaz.
 */

function lum(hex) {
  const c = hex.replace("#", "");
  const v = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const f = v.map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}

function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

let fails = 0;

function check(label, fg, bg, need) {
  const r = ratio(fg, bg);
  const ok = r >= need;
  if (!ok) fails++;
  console.log(`${ok ? "PASA " : "FALLA"} ${r.toFixed(2).padStart(5)}:1  min ${need}  ${label}`);
}

/* --- modo claro (public/styles.css :root) --- */
const L = {
  bg: "#F2F2F7",
  surface: "#FFFFFF",
  field: "#F2F2F7",
  surface3: "#E9E9EE",
  label: "#1D1D1F",
  label2: "#6E6E73",
  label3: "#6B6B70",
  accent: "#0066CC",
  accentFill: "#0071E3",
  accentText: "#FFFFFF",
  ok: "#1D7A3E",
  warn: "#A85000",
  fail: "#C41230",
};

/* --- modo oscuro (public/styles.css [data-theme="dark"]) --- */
const D = {
  bg: "#1C1C1E",
  surface: "#2C2C2E",
  field: "#3A3A3C",
  surface3: "#48484A",
  label: "#F5F5F7",
  label2: "#AEAEB2",
  label3: "#A3A3A8",
  accent: "#4DA3FF",
  accentFill: "#1A8CFF",
  accentText: "#000000",
  ok: "#30D158",
  warn: "#FF9F0A",
  fail: "#FF5950",
};

/* --- consola (misma en ambos modos) --- */
const C = {
  bg: "#1C1C1E",
  text: "#C7C7CC",
  trace: "#98989D",
  head: "#8AB4F8",
  ok: "#30D158",
  warn: "#FF9F0A",
  fail: "#FF5950",
  hint: "#64D2FF",
};

console.log("=== CLARO: texto (4.5:1) ===");
check("principal sobre tarjeta", L.label, L.surface, 4.5);
check("principal sobre fondo", L.label, L.bg, 4.5);
check("principal sobre campo", L.label, L.field, 4.5);
check("principal sobre chip", L.label, L.surface3, 4.5);
check("secundario sobre tarjeta", L.label2, L.surface, 4.5);
check("secundario sobre fondo", L.label2, L.bg, 4.5);
check("secundario sobre campo", L.label2, L.field, 4.5);
check("placeholder sobre tarjeta", L.label3, L.surface, 4.5);
check("placeholder sobre campo", L.label3, L.field, 4.5);
check("acento sobre tarjeta", L.accent, L.surface, 4.5);
check("acento sobre fondo", L.accent, L.bg, 4.5);
check("exito sobre tarjeta", L.ok, L.surface, 4.5);
check("aviso sobre tarjeta", L.warn, L.surface, 4.5);
check("fallo sobre tarjeta", L.fail, L.surface, 4.5);

console.log("\n=== CLARO: controles ===");
check("texto del boton principal", L.accentText, L.accentFill, 4.5);
check("boton principal sobre fondo (UI)", L.accentFill, L.bg, 3);

console.log("\n=== OSCURO: texto (4.5:1) ===");
check("principal sobre tarjeta", D.label, D.surface, 4.5);
check("principal sobre fondo", D.label, D.bg, 4.5);
check("principal sobre campo", D.label, D.field, 4.5);
check("principal sobre chip", D.label, D.surface3, 4.5);
check("secundario sobre tarjeta", D.label2, D.surface, 4.5);
check("secundario sobre fondo", D.label2, D.bg, 4.5);
check("secundario sobre campo", D.label2, D.field, 4.5);
check("placeholder sobre tarjeta", D.label3, D.surface, 4.5);
check("placeholder sobre campo", D.label3, D.field, 4.5);
check("acento sobre tarjeta", D.accent, D.surface, 4.5);
check("acento sobre fondo", D.accent, D.bg, 4.5);
check("exito sobre tarjeta", D.ok, D.surface, 4.5);
check("aviso sobre tarjeta", D.warn, D.surface, 4.5);
check("fallo sobre tarjeta", D.fail, D.surface, 4.5);

console.log("\n=== OSCURO: controles ===");
check("texto del boton principal", D.accentText, D.accentFill, 4.5);
check("boton principal sobre fondo (UI)", D.accentFill, D.bg, 3);
check("boton principal sobre tarjeta (UI)", D.accentFill, D.surface, 3);

console.log("\n=== CONSOLA DE REGISTRO ===");
check("texto", C.text, C.bg, 4.5);
check("traza", C.trace, C.bg, 4.5);
check("cabecera", C.head, C.bg, 4.5);
check("exito", C.ok, C.bg, 4.5);
check("aviso", C.warn, C.bg, 4.5);
check("fallo", C.fail, C.bg, 4.5);
check("pista", C.hint, C.bg, 4.5);

console.log(fails === 0 ? "\nTodos los pares pasan." : `\n${fails} par(es) por debajo del minimo.`);
process.exit(fails === 0 ? 0 : 1);
