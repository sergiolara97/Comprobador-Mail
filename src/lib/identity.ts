/**
 * Identidad de red para los cupos.
 *
 * `CF-Connecting-IP` la fija Cloudflare, pero el cubo de cuota no debe
 * construirse con una cadena sin validar: cualquier valor que no sea una
 * direccion IP (cabecera ausente, vacia, `127.0.0.1:993`, texto arbitrario) se
 * agrupa en un unico cubo compartido, de modo que no se puede crear un cubo
 * distinto por cada valor enviado.
 *
 * Las IPv6 se agrupan por prefijo /64: una sola asignacion IPv6 dispone de
 * 2^64 direcciones, asi que contar la direccion completa permitia multiplicar
 * el cupo "por IP" rotando dentro de la misma red.
 *
 * Es logica pura (igual que `target.ts`) para poder probarla en Node.
 */
import { parseIpv4, parseIpv6 } from "./target.ts";

/** Cubo compartido por todo lo que no sea una direccion IP reconocible. */
export const UNKNOWN_IDENTITY = "desconocida";

/** Prefijo /64 de una IPv6, ya normalizado (los cuatro primeros grupos). */
function v6Prefix(groups: number[]): string {
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * Clave de cuota para una identidad de red.
 *
 * - IPv4 valida: la direccion tal cual.
 * - IPv6 valida: su prefijo /64 normalizado.
 * - Cualquier otra cosa (incluida la ausencia de cabecera): `desconocida`.
 */
export function ipKey(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return UNKNOWN_IDENTITY;

  if (parseIpv4(value)) return value;

  const v6 = parseIpv6(value);
  if (v6) return v6Prefix(v6);

  return UNKNOWN_IDENTITY;
}
