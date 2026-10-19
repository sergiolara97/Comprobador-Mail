/**
 * Politica de destinos: que puertos y que servidores se pueden comprobar.
 *
 * Es logica pura y sin dependencias del runtime, para poder probarla en Node
 * (igual que `md5.ts`). La aplica el Worker antes de abrir cualquier conexion:
 * fuera de esta lista, el barrido seria un escaner de puertos cualquiera
 * lanzado desde las IPs de Cloudflare.
 */

/**
 * Puertos SMTP y sus equivalentes cifrados.
 *
 * El 25 esta en la lista a proposito: nunca llega a conectar (Cloudflare lo
 * bloquea) pero se deja pasar para que el protocolo emita su mensaje propio
 * ("puerto no permitido por la plataforma") en vez de un error generico.
 */
export const ALLOWED_PORTS: readonly number[] = [25, 465, 587, 2525, 993, 143, 110, 995];

/** Tope de puertos por barrido: una peticion abre como mucho estas conexiones. */
export const MAX_SWEEP_PORTS = 8;

export function isAllowedPort(port: unknown): boolean {
  return typeof port === "number" && Number.isInteger(port) && ALLOWED_PORTS.includes(port);
}

export function allowedPortsLabel(): string {
  return ALLOWED_PORTS.join(", ");
}

/* ------------------------------------------------------------------ */
/* Rangos reservados                                                   */
/* ------------------------------------------------------------------ */

/** Redes IPv4 que nunca deben alcanzarse desde el servicio. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "esta red"
  ["10.0.0.0", 8], // privada
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incluye 169.254.169.254, metadatos)
  ["172.16.0.0", 12], // privada
  ["192.0.0.0", 24], // protocolos especiales
  ["192.0.2.0", 24], // documentacion (TEST-NET-1)
  ["192.88.99.0", 24], // relay 6to4
  ["192.168.0.0", 16], // privada
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // documentacion (TEST-NET-2)
  ["203.0.113.0", 24], // documentacion (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado (incluye 255.255.255.255)
];

/** Redes IPv6 que nunca deben alcanzarse desde el servicio. */
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ["::", 128], // sin direccion
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // NAT64 local
  ["fe80::", 10], // link-local
  ["fc00::", 7], // unique local
  ["ff00::", 8], // multicast
];

/* ------------------------------------------------------------------ */
/* Analisis de direcciones                                             */
/* ------------------------------------------------------------------ */

export function parseIpv4(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;

  const octets: number[] = [];
  for (const part of parts) {
    // Se rechazan los ceros a la izquierda ("0177") para no confundir octal con decimal.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

/** Devuelve los 8 grupos de 16 bits, o `undefined` si no es una IPv6 valida. */
export function parseIpv6(value: string): number[] | undefined {
  let host = value;
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone); // fe80::1%eth0
  if (!host.includes(":")) return undefined;

  if (host.includes(":::")) return undefined;

  const doubleAt = host.indexOf("::");
  if (doubleAt >= 0 && host.slice(doubleAt + 2).includes("::")) return undefined;

  const head = doubleAt >= 0 ? host.slice(0, doubleAt) : "";
  const tail = doubleAt >= 0 ? host.slice(doubleAt + 2) : host;

  const headGroups: number[] = [];
  const tailGroups: number[] = [];

  const push = (parts: string[], out: number[]): boolean => {
    for (const part of parts) {
      if (part === "") return false;
      if (part.includes(".")) {
        const octets = parseIpv4(part);
        if (!octets) return false;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return false;
      out.push(parseInt(part, 16));
    }
    return true;
  };

  const headParts = doubleAt >= 0 ? head.split(":").filter((p) => p !== "") : [];
  if (doubleAt >= 0 && head !== "" && head.split(":").some((p) => p === "")) return undefined;
  const tailParts = tail.split(":").filter((p) => p !== "");

  if (!push(headParts, headGroups)) return undefined;
  if (!push(tailParts, tailGroups)) return undefined;

  const total = headGroups.length + tailGroups.length;
  if (doubleAt >= 0) {
    if (total > 8) return undefined;
    while (headGroups.length + tailGroups.length < 8) headGroups.push(0);
  } else if (total !== 8) {
    return undefined;
  }

  return [...headGroups, ...tailGroups];
}

function toV4(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function v4Blocked(octets: number[]): boolean {
  const ip = toV4(octets);
  return BLOCKED_V4.some(([net, len]) => {
    const base = parseIpv4(net);
    if (!base) return false;
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return (ip & mask) === (toV4(base) & mask);
  });
}

function v6PrefixMatch(groups: number[], net: number[], len: number): boolean {
  let bits = len;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = take === 0 ? 0 : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (net[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

/** IPv4 mapeada en IPv6 (`::ffff:192.168.1.1`) como sus cuatro octetos. */
function mappedV4(groups: number[]): number[] | undefined {
  for (let i = 0; i < 5; i++) if (groups[i] !== 0) return undefined;
  if (groups[5] !== 0xffff) return undefined;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/**
 * `true` si el destino no debe comprobarse por ser loopback, rango privado o
 * reservado (IPv4 e IPv6), un nombre de red interna o una direccion disfrazada.
 */
export function isBlockedHost(host: unknown): boolean {
  if (typeof host !== "string") return true;

  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.+$/, ""); // punto final del FQDN (ejemplo.com.)
  if (!h) return true;

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/\.(local|localdomain|internal|intranet|lan|home\.arpa|test|invalid|example)$/.test(h)) return true;

  const v4 = parseIpv4(h);
  if (v4) return v4Blocked(v4);

  const v6 = parseIpv6(h);
  if (v6) {
    const mapped = mappedV4(v6);
    if (mapped) return v4Blocked(mapped);
    return BLOCKED_V6.some(([net, len]) => v6PrefixMatch(v6, parseIpv6(net) ?? [], len));
  }

  // Si queda un ":" es que no era una IPv6 valida: formas como
  // "127.0.0.1:993" o "smtp.interno.internal:22" no las reconoce el parser de
  // arriba y el runtime podria interpretarlas de otra manera, asi que se
  // rechazan en vez de darlas por buenas.
  if (h.includes(":")) return true;

  // Direcciones disfrazadas: 2130706433, 0177.0.0.1, 0x7f000001...
  if (/^\d[\d.]*$/.test(h) || h.startsWith("0x")) return true;

  // Gramatica estricta de nombre: solo letras, digitos, punto, guion y guion
  // bajo. Antes cualquier otra forma (no-ASCII, "%", corchetes sueltos...)
  // caia en el fallback de abajo y se colaba como destino valido.
  if (!/^[a-z0-9._-]+$/.test(h)) return true;

  // Un nombre sin puntos no existe en el DNS publico: es una maquina interna.
  return !h.includes(".");
}
