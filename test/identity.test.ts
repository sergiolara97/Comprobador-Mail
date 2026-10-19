/**
 * Identidad de red para los cupos (`ipKey`).
 * Ejecutar con: npm run test:identity
 */
import { ipKey, UNKNOWN_IDENTITY } from "../src/lib/identity.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      esperado: ${expected}\n      obtenido: ${actual}`);
}

console.log("--- identidades validas ---");

check("IPv4 tal cual", ipKey("203.0.114.9"), "203.0.114.9");
check("IPv4 con espacios", ipKey("  198.51.100.7  "), "198.51.100.7");

console.log("\n--- IPv6 agrupada por /64 ---");

const v6a = ipKey("2001:4860:4860::8888");
const v6b = ipKey("2001:4860:4860:0:1:2:3:4");
check("prefijo /64 de una IPv6", v6a, "2001:4860:4860:0::/64");
check("misma red, otra direccion: mismo cubo", v6b, v6a);
check("otra red: cubo distinto", ipKey("2606:4700:4700::1111") !== v6a, true);
check("IPv6 con zona: mismo cubo", ipKey("fe80::1%eth0"), ipKey("fe80::1"));
check("IPv4 mapeada en IPv6: prefijo propio", ipKey("::ffff:192.168.0.1"), "0:0:0:0::/64");

console.log("\n--- identidades desconocidas (cubo compartido) ---");

const desconocidas: (string | null | undefined)[] = [
  null,
  undefined,
  "",
  "   ",
  "127.0.0.1:993",
  "smtp.ejemplo.com:587",
  "no-soy-una-ip",
  "0177.0.0.1",
  "127.0.0.1:587" as string,
  "smtp.ejemplo.com",
];

for (const value of desconocidas) {
  check(`desconocida ${JSON.stringify(value)}`, ipKey(value), UNKNOWN_IDENTITY);
}

console.log(failures === 0 ? "\nTodo correcto." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
