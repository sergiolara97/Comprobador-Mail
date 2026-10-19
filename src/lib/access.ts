/**
 * Verificacion del JWT de Cloudflare Access.
 *
 * Si TEAM_DOMAIN y POLICY_AUD estan configurados, toda peticion debe traer un
 * token valido emitido por Access. Si no lo estan, la app queda abierta (util
 * en desarrollo, peligroso en produccion con credenciales SMTP reales).
 */

interface AccessEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

interface JwkKey extends JsonWebKey {
  kid?: string;
}

interface JwksCache {
  keys: JwkKey[];
  fetchedAt: number;
}

let jwksCache: JwksCache | undefined;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hora

function b64UrlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64UrlToBytes(input))) as T;
}

async function getJwks(teamDomain: string, force = false): Promise<JwkKey[]> {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`No se pudo obtener el JWKS de Access (${res.status}).`);

  const data = (await res.json()) as { keys?: JwkKey[] };
  const keys = data.keys ?? [];
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

export interface AccessIdentity {
  email?: string;
  sub?: string;
}

/**
 * Devuelve la identidad si el token es valido.
 * Lanza un Error con mensaje legible si no lo es.
 */
export async function verifyAccess(
  request: Request,
  env: AccessEnv,
): Promise<AccessIdentity | null> {
  const teamDomain = env.TEAM_DOMAIN?.trim();
  const aud = env.POLICY_AUD?.trim();

  // Sin configurar: acceso abierto.
  if (!teamDomain || !aud) return null;

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    // Access tambien puede enviar el token en la cookie.
    parseCookie(request.headers.get("Cookie") ?? "", "CF_Authorization");

  if (!token) throw new Error("Falta el token de Cloudflare Access.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token de Access mal formado.");

  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];
  const header = decodeJson<{ alg?: string; kid?: string }>(rawHeader);
  const payload = decodeJson<{ aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string; sub?: string }>(
    rawPayload,
  );

  if (header.alg !== "RS256") throw new Error(`Algoritmo no soportado: ${header.alg}`);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new Error("El token de Access ha caducado.");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) {
    throw new Error("El token de Access aun no es valido.");
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(aud)) {
    throw new Error("El token de Access no corresponde a esta aplicacion (AUD incorrecto).");
  }

  const expectedIss = `https://${teamDomain}`;
  if (payload.iss && payload.iss !== expectedIss) {
    throw new Error(`Emisor inesperado en el token: ${payload.iss}`);
  }

  const jwks = await getJwks(teamDomain);
  const jwk = header.kid ? jwks.find((k) => k.kid === header.kid) : jwks[0];
  if (!jwk) throw new Error("No se encontro la clave publica del token.");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64UrlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );

  if (!valid) throw new Error("Firma del token de Access invalida.");

  return { email: payload.email, sub: payload.sub };
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function accessEnabled(env: AccessEnv): boolean {
  return Boolean(env.TEAM_DOMAIN?.trim() && env.POLICY_AUD?.trim());
}
