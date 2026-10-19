import { accessEnabled, verifyAccess } from "./lib/access.ts";
import { cloudflareTransportFactory } from "./lib/cf-transport.ts";
import { SECURITY_HEADERS } from "./lib/csp.ts";
import { ipKey } from "./lib/identity.ts";
import { hourBucket, hourSuffix, type Bucket, type RateLimiter } from "./lib/limiter.ts";
import { probe } from "./lib/smtp.ts";
import { sweep } from "./lib/sweep.ts";
import { allowedPortsLabel, isAllowedPort, isBlockedHost, MAX_SWEEP_PORTS } from "./lib/target.ts";
import type { ConnMode, ProbeRequest, SweepRequest } from "./lib/types.ts";

// La clase tiene que exportarse desde el modulo principal para que wrangler la
// registre como Durable Object.
export { RateLimiter } from "./lib/limiter.ts";

export interface Env {
  ASSETS: Fetcher;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  /** Cupos horarios exactos por IP y globales (Durable Object). */
  LIMITER: DurableObjectNamespace<RateLimiter>;
  /** Freno de rafagas por IP (binding nativo, contadores por ubicacion). */
  RL_BURST: RateLimit;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Cupos del servicio publico. Son deliberadamente holgados para el uso normal
 * (comprobar el correo de casa o del trabajo) y muy bajos para el abuso.
 */
const LIMITS = {
  /** Peticiones por IP y hora, sumando todos los endpoints con trabajo real. */
  perIpHour: 50,
  /** Correos de prueba por IP y hora: es el unico verbo peligroso. */
  perIpSendHour: 5,
  /** Techo global por hora: protege la cuota de la cuenta. */
  globalHour: 1000,
  /** Correos de prueba por hora en total. */
  globalSendHour: 50,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function unauthorized(message: string): Response {
  return json({ error: message }, 401);
}

/** Demasiadas peticiones. La interfaz ya muestra `error` tal cual. */
function tooMany(message: string): Response {
  return json({ error: message }, 429);
}

/** Peticion del cliente mal formada: se responde 400, no 500. */
class BadRequest extends Error {}

/** Tipo de contenido no admitido: se responde 415. */
class UnsupportedMediaType extends Error {}

/** Lee el cuerpo sin pasar nunca del tope indicado (streaming, no buffer+check). */
async function readBodyBounded(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new BadRequest("Peticion demasiado grande.");
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* el cuerpo ya estaba cerrado */
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Lee el cuerpo como objeto JSON.
 *
 * - Exige `Content-Type: application/json`: es lo que obliga a un POST cruzado
 *   desde otro origen a pasar por el preflight de CORS (que este Worker no
 *   responde). Sin esto, un `text/plain` con JSON dentro era una peticion
 *   valida y no hacia falta preflight.
 * - Comprueba `Content-Length` antes de leer y, si falta o no es fiable, corta
 *   la lectura al superar el tope: el cuerpo no se materializa entero para
 *   rechazarlo despues.
 */
async function readJson<T>(request: Request): Promise<T> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type)) {
    throw new UnsupportedMediaType("Se espera Content-Type: application/json.");
  }

  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BadRequest("Peticion demasiado grande.");
  }

  const text = await readBodyBounded(request, MAX_BODY_BYTES);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest("JSON invalido.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequest("Se espera un objeto JSON.");
  }
  return body as T;
}

/** Validacion minima del host: dominio, IPv4 o IPv6 literal. */
function isValidHost(host: unknown): host is string {
  if (typeof host !== "string") return false;
  const h = host.trim();
  if (h.length === 0 || h.length > 253) return false;
  if (/[\s\r\n/@\\]/.test(h)) return false;
  return true;
}

const MODES: readonly ConnMode[] = ["plain", "starttls", "implicit"];

/** El modo de cifrado solo puede ser uno de los tres definidos. */
function isValidMode(mode: unknown): mode is ConnMode {
  return typeof mode === "string" && (MODES as readonly string[]).includes(mode);
}

/** Tiempo limite opcional: numero finito dentro del rango admitido. */
function isValidTimeout(value: unknown, min: number, max: number): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max)
  );
}

/**
 * Identidad de red del visitante para los cupos.
 *
 * `CF-Connecting-IP` la fija Cloudflare; `ipKey` comprueba que sea una
 * direccion IP (y agrupa las IPv6 por /64) para que una cabecera ausente o
 * rara no cree un cubo distinto por cada valor enviado.
 */
function clientIp(request: Request): string {
  return ipKey(request.headers.get("CF-Connecting-IP"));
}

/**
 * Cupo horario de la IP. Se consume antes de abrir ninguna conexion; si el
 * retorno no es `undefined`, hay que devolverlo tal cual.
 */
async function consumeIpQuota(env: Env, ip: string, send: boolean): Promise<Response | undefined> {
  const hour = hourBucket("api");
  const buckets: Bucket[] = [
    { bucket: hour, max: LIMITS.perIpHour },
    ...(send ? [{ bucket: hourBucket("send"), max: LIMITS.perIpSendHour }] : []),
  ];

  const results = await env.LIMITER.get(env.LIMITER.idFromName(`ip:${ip}`)).hit(buckets, hourSuffix());

  const general = results[0];
  if (!general?.ok) {
    return tooMany(
      `Has agotado las ${LIMITS.perIpHour} comprobaciones por hora de esta conexion. Intentalo dentro de un rato.`,
    );
  }

  const envio = results[1];
  if (send && !envio?.ok) {
    return tooMany(
      `Limite de ${LIMITS.perIpSendHour} correos de prueba por hora alcanzado. Intentalo dentro de un rato.`,
    );
  }

  return undefined;
}

/** Techo global: evita que un abuso agote la cuota diaria de la cuenta. */
async function consumeGlobalQuota(env: Env, send: boolean): Promise<Response | undefined> {
  const buckets: Bucket[] = [{ bucket: hourBucket("global"), max: LIMITS.globalHour }];
  if (send) buckets.push({ bucket: hourBucket("global-send"), max: LIMITS.globalSendHour });

  const results = await env.LIMITER.get(env.LIMITER.idFromName("global")).hit(buckets, hourSuffix());

  if (!results[0]?.ok) {
    return tooMany("El servicio ha alcanzado su limite de comprobaciones por hora. Prueba mas tarde.");
  }
  if (send && !results[1]?.ok) {
    return tooMany("El servicio ha alcanzado su limite de correos de prueba por hora. Prueba mas tarde.");
  }

  return undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- API ----
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") {
        return json({ error: "Metodo no permitido." }, 405);
      }

      const ip = clientIp(request);

      // Freno de rafagas: contadores locales de Cloudflare, sin coste adicional.
      // La clave es solo la identidad (no la ruta): si incluyera el camino, cada
      // endpoint tendria su propio cubo y el limite anunciado se multiplicaria.
      const burst = await env.RL_BURST.limit({ key: ip });
      if (!burst.success) {
        return tooMany("Demasiadas peticiones seguidas. Espera unos segundos y vuelve a intentarlo.");
      }

      // Cloudflare Access: si esta configurado, exigimos token valido.
      let identityEmail: string | undefined;
      if (accessEnabled(env)) {
        try {
          const identity = await verifyAccess(request, env);
          identityEmail = identity?.email;
        } catch (e) {
          return unauthorized(e instanceof Error ? e.message : "Acceso no autorizado.");
        }
      }

      try {
        if (url.pathname === "/api/me") {
          return json({ email: identityEmail ?? null, access: accessEnabled(env) });
        }

        if (url.pathname === "/api/probe") {
          const body = await readJson<ProbeRequest>(request);
          if (!isValidHost(body.host)) return json({ error: "Servidor no valido." }, 400);
          if (isBlockedHost(body.host)) {
            return json({ error: "Ese servidor no se puede comprobar (red interna o reservada)." }, 400);
          }
          if (!isAllowedPort(Number(body.port))) {
            return json({ error: `Puerto no permitido. Disponibles: ${allowedPortsLabel()}.` }, 400);
          }
          if (body.send !== undefined && typeof body.send !== "boolean") {
            return json({ error: "El campo send debe ser booleano." }, 400);
          }
          if (!isValidMode(body.mode)) {
            return json({ error: "El modo de cifrado debe ser plain, starttls o implicit." }, 400);
          }
          if (!isValidTimeout(body.timeoutSec, 2, 120)) {
            return json({ error: "El tiempo limite debe ser un numero entre 2 y 120 segundos." }, 400);
          }

          const send = body.send === true;
          const perIp = await consumeIpQuota(env, ip, send);
          if (perIp) return perIp;
          const global = await consumeGlobalQuota(env, send);
          if (global) return global;

          // El valor canonicalizado -no el cuerpo crudo- es el que llega al
          // verbo: si no, un `send` verdadero que no sea `true` enviaba el
          // correo sin consumir los cubos de envio.
          const result = await probe({ ...body, send }, cloudflareTransportFactory);
          return json(result);
        }

        if (url.pathname === "/api/sweep") {
          const body = await readJson<SweepRequest>(request);
          if (!isValidHost(body.host)) return json({ error: "Servidor no valido." }, 400);
          if (isBlockedHost(body.host)) {
            return json({ error: "Ese servidor no se puede comprobar (red interna o reservada)." }, 400);
          }
          if (!Array.isArray(body.ports)) return json({ error: "Lista de puertos no valida." }, 400);
          if (body.ports.length === 0) return json({ error: "Indica al menos un puerto." }, 400);
          if (body.ports.length > MAX_SWEEP_PORTS) {
            return json({ error: `Maximo ${MAX_SWEEP_PORTS} puertos por barrido.` }, 400);
          }
          const prohibido = body.ports.find((p) => !isAllowedPort(p));
          if (prohibido !== undefined) {
            return json(
              { error: `Puerto ${prohibido} no permitido. Disponibles: ${allowedPortsLabel()}.` },
              400,
            );
          }
          if (!isValidTimeout(body.timeoutSec, 1, 15)) {
            return json({ error: "El tiempo limite debe ser un numero entre 1 y 15 segundos." }, 400);
          }

          const timeoutSec = body.timeoutSec ?? 3;
          const perIp = await consumeIpQuota(env, ip, false);
          if (perIp) return perIp;
          const global = await consumeGlobalQuota(env, false);
          if (global) return global;

          const result = await sweep(body.host, body.ports, timeoutSec);
          return json(result);
        }

        return json({ error: "Ruta no encontrada." }, 404);
      } catch (e) {
        if (e instanceof BadRequest) return json({ error: e.message }, 400);
        if (e instanceof UnsupportedMediaType) return json({ error: e.message }, 415);
        // El detalle va al registro del operador, no al cliente anonimo.
        console.error("Error no controlado en /api/*", e);
        return json({ error: "Error interno del servicio." }, 500);
      }
    }

    // ---- estaticos ----
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
