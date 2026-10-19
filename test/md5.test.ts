/**
 * Vectores de prueba conocidos para MD5 y HMAC-MD5.
 * Ejecutar con: npm test
 */
import { md5, hmacMd5, toHex } from "../src/lib/md5.ts";

const enc = new TextEncoder();

let failures = 0;

function check(name: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      esperado: ${expected}\n      obtenido: ${actual}`);
}

// --- MD5 (RFC 1321, apendice A.5) ---
check("md5('')", toHex(md5(enc.encode(""))), "d41d8cd98f00b204e9800998ecf8427e");
check("md5('a')", toHex(md5(enc.encode("a"))), "0cc175b9c0f1b6a831c399e269772661");
check("md5('abc')", toHex(md5(enc.encode("abc"))), "900150983cd24fb0d6963f7d28e17f72");
check(
  "md5('message digest')",
  toHex(md5(enc.encode("message digest"))),
  "f96b697d7cb7938d525a2f31aaf161d0",
);
check(
  "md5('abcdefghijklmnopqrstuvwxyz')",
  toHex(md5(enc.encode("abcdefghijklmnopqrstuvwxyz"))),
  "c3fcd3d76192e4007dfb496cca67e13b",
);
check(
  "md5('The quick brown fox jumps over the lazy dog')",
  toHex(md5(enc.encode("The quick brown fox jumps over the lazy dog"))),
  "9e107d9d372bb6826bd81d3542a419d6",
);
// cadena larga (>1 bloque, comprueba el manejo del padding)
check(
  "md5(80 chars)",
  toHex(md5(enc.encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))),
  "57edf4a22be3c955ac49da2e2107b67a",
);

// --- HMAC-MD5 (RFC 2202) ---
check(
  "hmac-md5 RFC2202 #1",
  toHex(hmacMd5(new Uint8Array(16).fill(0x0b), enc.encode("Hi There"))),
  "9294727a3638bb1c13f48ef8158bfc9d",
);
check(
  "hmac-md5 RFC2202 #2",
  toHex(hmacMd5(enc.encode("Jefe"), enc.encode("what do ya want for nothing?"))),
  "750c783e6ab0b503eaa86e310a5db738",
);
check(
  "hmac-md5 RFC2202 #3",
  toHex(hmacMd5(new Uint8Array(16).fill(0xaa), new Uint8Array(50).fill(0xdd))),
  "56be34521d144c88dbb8c733f0e8b3f6",
);
// clave de mas de un bloque (se hashea primero)
check(
  "hmac-md5 RFC2202 #6 (clave de 80 bytes)",
  toHex(hmacMd5(new Uint8Array(80).fill(0xaa), enc.encode("Test Using Larger Than Block-Size Key - Hash Key First"))),
  "6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd",
);

console.log(failures === 0 ? "\nTodo correcto." : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
