import { accessEnabled, verifyAccess } from "./lib/access.ts";
import { cloudflareTransportFactory } from "./lib/cf-transport.ts";
import { hourBucket, type Bucket, type RateLimiter } from "./lib/limiter.ts";
import { probe } from "./lib/smtp.ts";
import { sweep } from "./lib/sweep.ts";
import { allowedPortsLabel, isAllowedPort, isBlockedHost, MAX_SWEEP_PORTS } from "./lib/target.ts";
import type { ProbeRequest, SweepRequest } from "./lib/types.ts";

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

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest("Peticion demasiado grande.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BadRequest("JSON invalido.");
  }
}

/** Validacion minima del host: dominio, IPv4 o IPv6 literal. */
function isValidHost(host: unknown): host is string {
  if (typeof host !== "string") return false;
  const h = host.trim();
  if (h.length === 0 || h.length > 253) return false;
  if (/[\s\r\n/@\\]/.test(h)) return false;
  return true;
}

/** IP real del visitante. La fija Cloudflare, el cliente no puede falsearla. */
function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "desconocida";
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

  const results = await env.LIMITER.get(env.LIMITER.idFromName(`ip:${ip}`)).hit(buckets, hour);

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

  const results = await env.LIMITER.get(env.LIMITER.idFromName("global")).hit(buckets);

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
      const burst = await env.RL_BURST.limit({ key: `${ip}:${url.pathname}` });
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

          const send = body.send === true;
          const perIp = await consumeIpQuota(env, ip, send);
          if (perIp) return perIp;
          const global = await consumeGlobalQuota(env, send);
          if (global) return global;

          const result = await probe(body, cloudflareTransportFactory);
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

          const perIp = await consumeIpQuota(env, ip, false);
          if (perIp) return perIp;
          const global = await consumeGlobalQuota(env, false);
          if (global) return global;

          const result = await sweep(body.host, body.ports, body.timeoutSec ?? 3);
          return json(result);
        }

        return json({ error: "Ruta no encontrada." }, 404);
      } catch (e) {
        if (e instanceof BadRequest) return json({ error: e.message }, 400);
        return json({ error: e instanceof Error ? e.message : "Error interno." }, 500);
      }
    }

    // ---- estaticos ----
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
