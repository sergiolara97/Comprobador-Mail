import { accessEnabled, verifyAccess } from "./lib/access.ts";
import { cloudflareTransportFactory } from "./lib/cf-transport.ts";
import { probe } from "./lib/smtp.ts";
import { sweep } from "./lib/sweep.ts";
import type { ProbeRequest, SweepRequest } from "./lib/types.ts";

export interface Env {
  ASSETS: Fetcher;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

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

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Peticion demasiado grande.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("JSON invalido.");
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- API ----
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") {
        return json({ error: "Metodo no permitido." }, 405);
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
        if (url.pathname === "/api/probe") {
          const body = await readJson<ProbeRequest>(request);
          if (!isValidHost(body.host)) return json({ error: "Servidor no valido." }, 400);

          const result = await probe(body, cloudflareTransportFactory);
          return json(result);
        }

        if (url.pathname === "/api/sweep") {
          const body = await readJson<SweepRequest>(request);
          if (!isValidHost(body.host)) return json({ error: "Servidor no valido." }, 400);
          if (!Array.isArray(body.ports)) return json({ error: "Lista de puertos no valida." }, 400);

          const result = await sweep(body.host, body.ports, body.timeoutSec ?? 3);
          return json(result);
        }

        if (url.pathname === "/api/me") {
          return json({ email: identityEmail ?? null, access: accessEnabled(env) });
        }

        return json({ error: "Ruta no encontrada." }, 404);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "Error interno." }, 500);
      }
    }

    // ---- estaticos ----
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
