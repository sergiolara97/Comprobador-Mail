/**
 * Cabeceras de seguridad de los estaticos y politica de contenido.
 *
 * `public/index.html` lleva un script inline que aplica el tema antes de
 * pintar (evita el destello al cargar). La CSP lo autoriza por hash, de modo
 * que **si ese script cambia hay que recalcular la constante**; el test
 * `test/headers.test.ts` recalcula el hash desde `public/index.html` y falla
 * si dejan de coincidir.
 *
 * Modulo puro (sin dependencias del runtime) para poder probarlo en Node.
 */

/** Hash `sha256-` + base64 del contenido exacto del script inline del tema. */
export const INLINE_THEME_SCRIPT_SHA256 = "sha256-GJBumcISt//QSwfk+b0QBzqpBQssNRLfFDjgHh7JXMY=";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self' blob:",
  `script-src 'self' '${INLINE_THEME_SCRIPT_SHA256}'`,
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Cabeceras que se anaden a cada respuesta de `public/`.
 *
 * La CSP se aplica tambien a JS y CSS: ahi no tiene efecto, pero evita que una
 * respuesta de asset se convierta en documento si algun dia cambia el tipo.
 */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
];
