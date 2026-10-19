/**
 * Cabeceras de seguridad de los estaticos (`src/lib/csp.ts`).
 *
 * Lo importante: si alguien toca el script inline del tema en
 * `public/index.html`, el hash de la CSP deja de coincidir y este test falla
 * (hoy la unica senal seria que el tema parpadea al cargar).
 *
 * Ejecutar con: npm run test:headers
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTENT_SECURITY_POLICY,
  INLINE_THEME_SCRIPT_SHA256,
  SECURITY_HEADERS,
} from "../src/lib/csp.ts";

let failures = 0;

function check(name: string, condition: boolean, extra = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition && extra) console.log(`      ${extra}`);
}

const htmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));
const html = readFileSync(htmlPath, "utf8");

const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
check("index.html tiene un script inline", inline !== null);

if (inline) {
  const real = "sha256-" + createHash("sha256").update(inline[1], "utf8").digest("base64");
  check(
    "el hash de la CSP coincide con el script inline",
    real === INLINE_THEME_SCRIPT_SHA256,
    `constante: ${INLINE_THEME_SCRIPT_SHA256}\n      real:      ${real}`,
  );
}

console.log("\n--- politica de contenido ---");

check("declara default-src", CONTENT_SECURITY_POLICY.includes("default-src 'self'"));
check("permite el script propio", CONTENT_SECURITY_POLICY.includes("script-src 'self'"));
check("no usa unsafe-inline", !CONTENT_SECURITY_POLICY.includes("unsafe-inline"));
check("no usa unsafe-eval", !CONTENT_SECURITY_POLICY.includes("unsafe-eval"));
check("bloquea objetos", CONTENT_SECURITY_POLICY.includes("object-src 'none'"));
check("bloquea el encuadre", CONTENT_SECURITY_POLICY.includes("frame-ancestors 'none'"));
check("permite el favicon data:", CONTENT_SECURITY_POLICY.includes("img-src 'self' data:"));

console.log("\n--- cabeceras ---");

const names = SECURITY_HEADERS.map(([name]) => name);
for (const expected of [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
]) {
  check(`incluye ${expected}`, names.includes(expected));
}
check("no hay cabeceras repetidas", names.length === new Set(names).size);

console.log(failures === 0 ? "\nTodo correcto." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
