/**
 * Politica de destinos: puertos permitidos y hosts bloqueados.
 * Ejecutar con: npm test
 */
import { allowedPortsLabel, ALLOWED_PORTS, isAllowedPort, isBlockedHost, MAX_SWEEP_PORTS } from "../src/lib/target.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      esperado: ${expected}\n      obtenido: ${actual}`);
}

console.log("--- puertos ---");

for (const port of ALLOWED_PORTS) {
  check(`puerto permitido ${port}`, isAllowedPort(port), true);
}

for (const port of [22, 23, 80, 443, 3306, 8080, 65535, 0, -1, 1.5, NaN, "587", null, undefined]) {
  check(`puerto rechazado ${String(port)}`, isAllowedPort(port), false);
}

check("MAX_SWEEP_PORTS = 8", MAX_SWEEP_PORTS, 8);
check("etiqueta de puertos", allowedPortsLabel(), "25, 465, 587, 2525, 993, 143, 110, 995");

console.log("\n--- hosts bloqueados ---");

const bloqueados: string[] = [
  "localhost",
  "LOCALHOST",
  "localhost.",
  "127.0.0.1",
  "127.1.2.3",
  "0.0.0.0",
  "10.0.0.1",
  "172.16.5.4",
  "172.31.255.254",
  "192.168.1.10",
  "169.254.169.254", // metadatos de instancia
  "100.64.0.1", // CGNAT
  "224.0.0.1", // multicast
  "255.255.255.255",
  "::1",
  "[::1]",
  "::",
  "fe80::1",
  "fe80::1%eth0",
  "fd00::1",
  "ff02::1",
  "::ffff:192.168.0.1", // IPv4 mapeada
  "::ffff:127.0.0.1",
  "mail.local",
  "smtp.interno.internal",
  "algo.home.arpa",
  "cualquiera.test",
  "smtp", // nombre de una sola etiqueta
  "2130706433", // 127.0.0.1 en decimal
  "0x7f000001",
  "0177.0.0.1",
  "",
  "   ",
  null,
  undefined,
  42,
];

for (const host of bloqueados) {
  check(`host bloqueado ${JSON.stringify(host)}`, isBlockedHost(host), true);
}

console.log("\n--- hosts permitidos ---");

const permitidos: string[] = [
  "smtp.gmail.com",
  "smtp.ejemplo.es",
  "mail.mi-dominio.com.",
  "8.8.8.8",
  "1.1.1.1",
  "2001:4860:4860::8888",
  "2606:4700:4700::1111",
  "mail.empresa.co.uk",
  "smtp-v2.mailgun.org",
  "xn--e1afmkfd.xn--p1ai",
];

for (const host of permitidos) {
  check(`host permitido ${JSON.stringify(host)}`, isBlockedHost(host), false);
}

console.log(failures === 0 ? "\nTodo correcto." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
