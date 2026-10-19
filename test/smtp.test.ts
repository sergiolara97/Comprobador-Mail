/**
 * Test de integracion del cliente SMTP contra un servidor simulado en memoria.
 *
 * Verifica: saludo, EHLO, capacidades, STARTTLS, los tres mecanismos AUTH,
 * MAIL FROM / RCPT TO / DATA, codificado del mensaje y el "dot stuffing".
 *
 * Ejecutar con: npm run test:smtp
 */
import { probe, type Transport, type TransportFactory } from "../src/lib/smtp.ts";
import { hmacMd5, toHex } from "../src/lib/md5.ts";
import type { ProbeRequest } from "../src/lib/types.ts";

/* ------------------------------------------------------------------ */
/* Servidor SMTP simulado                                              */
/* ------------------------------------------------------------------ */

interface FakeOptions {
  banner?: string;
  caps?: string[];
  /** Capacidades anunciadas despues de STARTTLS (por defecto, las mismas). */
  capsAfterTls?: string[];
  /** Exige STARTTLS antes de AUTH. */
  requireTlsForAuth?: boolean;
  /** Acepta STARTTLS. */
  supportStartTls?: boolean;
  /** Credenciales validas. Si es null, cualquier AUTH falla con 535. */
  user?: string;
  pass?: string;
  /** Fallar siempre el AUTH. */
  rejectAuth?: boolean;
  /** Falla el RCPT TO. */
  rejectRcpt?: boolean;
  /** No responder nunca (para probar timeouts). */
  silent?: boolean;
}

interface FakeServer {
  factory: TransportFactory;
  received: {
    commands: string[];
    message?: string;
    authMechanism?: string;
    authUser?: string;
    authPassOk?: boolean;
    mailFrom?: string;
    rcptTo?: string;
  };
  tlsUpgraded: () => boolean;
}

function createFakeServer(opts: FakeOptions = {}): FakeServer {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const banner = opts.banner ?? "fake.smtp ESMTP listo";
  const caps = opts.caps ?? ["SIZE 10240000", "8BITMIME", "STARTTLS", "AUTH PLAIN LOGIN CRAM-MD5"];
  const capsAfterTls = opts.capsAfterTls ?? caps.filter((c) => !c.startsWith("STARTTLS"));
  const user = opts.user ?? "usuario";
  const pass = opts.pass ?? "secreto";

  const received: FakeServer["received"] = { commands: [] };
  let tls = false;

  const factory: TransportFactory = (_host, _port, mode) => {
    // Canales cliente -> servidor y servidor -> cliente.
    let toClient: WritableStreamDefaultWriter<Uint8Array>;

    const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
    const serverToClient = new TransformStream<Uint8Array, Uint8Array>();

    const clientSide: Transport = {
      readable: serverToClient.readable,
      writable: clientToServer.writable,
      startTls(): Transport {
        // El "upgrade" en el simulador es un no-op: los mismos canales.
        tls = true;
        if (mode !== "starttls" && mode !== "implicit") {
          throw new Error("startTls llamado en un modo sin TLS");
        }
        return clientSide;
      },
      close: async () => {},
    };

    toClient = serverToClient.writable.getWriter();

    // ---- bucle del servidor ----
    const serverLoop = async () => {
      const reader = clientToServer.readable.getReader();
      let buffer = "";
      let inData = false;
      let dataLines: string[] = [];
      let pendingAuth: "login-user" | "login-pass" | "plain" | null = null;
      let cramChallenge = "";

      const write = async (text: string) => {
        await toClient.write(enc.encode(text + "\r\n"));
      };

      if (mode === "implicit" && !opts.silent) tls = true;
      if (!opts.silent) await write(`220 ${banner}`);

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);

          // ---- modo DATA ----
          if (inData) {
            if (line === ".") {
              inData = false;
              received.message = dataLines.join("\r\n");
              dataLines = [];
              await write("250 2.0.0 Ok: mensaje aceptado");
              continue;
            }
            dataLines.push(line);
            continue;
          }

          if (opts.silent) continue;

          received.commands.push(line);
          const upper = line.toUpperCase();

          // ---- respuestas a un intercambio AUTH en curso ----
          if (pendingAuth === "login-user") {
            const decoded = Buffer.from(line, "base64").toString("utf8");
            received.authUser = decoded;
            pendingAuth = "login-pass";
            await write("334 UGFzc3dvcmQ6");
            continue;
          }
          if (pendingAuth === "login-pass") {
            const decoded = Buffer.from(line, "base64").toString("utf8");
            received.authPassOk = decoded === pass;
            pendingAuth = null;
            await write(received.authPassOk ? "235 2.7.0 Autenticado" : "535 5.7.8 Credenciales invalidas");
            continue;
          }
          if (pendingAuth === "plain") {
            // Respuesta de un AUTH PLAIN en dos pasos.
            const parts = Buffer.from(line, "base64").toString("utf8").split("\0");
            received.authUser = parts[1];
            received.authPassOk = parts[2] === pass;
            pendingAuth = null;
            await write(received.authPassOk ? "235 2.7.0 Autenticado" : "535 5.7.8 Credenciales invalidas");
            continue;
          }

          // ---- comandos ----
          if (upper.startsWith("EHLO ") || upper.startsWith("HELO ")) {
            const active = tls ? capsAfterTls : caps;
            await write(`250-${banner}`);
            active.forEach((cap, i) => {
              const last = i === active.length - 1;
              void write(`250${last ? " " : "-"}${cap}`);
            });
            if (active.length === 0) await write("250 OK");
            continue;
          }

          if (upper === "STARTTLS") {
            if (opts.supportStartTls === false) {
              await write("502 5.5.1 Comando no reconocido");
              continue;
            }
            tls = true;
            await write("220 2.0.0 Listo para TLS");
            continue;
          }

          if (upper.startsWith("AUTH ")) {
            if (opts.requireTlsForAuth && !tls) {
              await write("538 5.7.11 Debes usar TLS primero");
              continue;
            }
            const mech = upper.slice(5).trim().split(/\s+/)[0];
            received.authMechanism = mech;

            if (opts.rejectAuth) {
              await write("535 5.7.8 Credenciales invalidas");
              continue;
            }

            if (mech === "LOGIN") {
              pendingAuth = "login-user";
              await write("334 VXNlcm5hbWU6");
              continue;
            }

            if (mech === "PLAIN") {
              const inline = line.slice(5).trim().split(/\s+/)[1];
              if (inline) {
                const parts = Buffer.from(inline, "base64").toString("utf8").split("\0");
                received.authUser = parts[1];
                received.authPassOk = parts[2] === pass;
                await write(received.authPassOk ? "235 2.7.0 Autenticado" : "535 5.7.8 Credenciales invalidas");
              } else {
                pendingAuth = "plain";
                await write("334 ");
              }
              continue;
            }

            if (mech === "CRAM-MD5") {
              cramChallenge = `<${Date.now()}@fake.smtp>`;
              received.authUser = undefined;
              await write(`334 ${Buffer.from(cramChallenge).toString("base64")}`);
              continue;
            }

            await write("504 5.5.4 Mecanismo no soportado");
            continue;
          }

          // respuesta al desafio CRAM-MD5
          if (received.authMechanism === "CRAM-MD5" && received.authUser === undefined && line.length > 8) {
            const decoded = Buffer.from(line, "base64").toString("utf8");
            const [u, digest] = decoded.split(" ");
            received.authUser = u;
            const expected = toHex(
              hmacMd5(enc.encode(pass), enc.encode(cramChallenge)),
            );
            received.authPassOk = digest === expected;
            received.authMechanism = "CRAM-MD5";
            await write(received.authPassOk ? "235 2.7.0 Autenticado" : "535 5.7.8 Credenciales invalidas");
            continue;
          }

          if (upper.startsWith("MAIL FROM:")) {
            received.mailFrom = line.slice(10).trim();
            await write("250 2.1.0 Ok");
            continue;
          }

          if (upper.startsWith("RCPT TO:")) {
            if (opts.rejectRcpt) {
              await write("550 5.1.1 Destinatario rechazado");
              continue;
            }
            received.rcptTo = line.slice(8).trim();
            await write("250 2.1.5 Ok");
            continue;
          }

          if (upper === "DATA") {
            inData = true;
            await write("354 Envia el mensaje y termina con <CRLF>.<CRLF>");
            continue;
          }

          if (upper === "QUIT") {
            await write("221 2.0.0 Adios");
            break;
          }

          await write("500 5.5.2 Comando no reconocido");
        }
      }
    };

    void serverLoop().catch(() => {
      /* el cliente cerro la conexion */
    });

    return { transport: clientSide, opened: Promise.resolve({}) };
  };

  return { factory, received, tlsUpgraded: () => tls };
}

/* ------------------------------------------------------------------ */
/* Utilidades de test                                                  */
/* ------------------------------------------------------------------ */

let failures = 0;

function check(name: string, condition: boolean, extra = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition && extra) console.log(`      ${extra}`);
}

function baseReq(overrides: Partial<ProbeRequest> = {}): ProbeRequest {
  return {
    host: "fake.smtp",
    port: 587,
    mode: "starttls",
    timeoutSec: 10,
    useAuth: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Casos                                                               */
/* ------------------------------------------------------------------ */

async function run() {
  // ---- 1. Comprobacion simple con STARTTLS ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq(), server.factory);
    check("1. STARTTLS: comprobacion correcta", res.ok, `${res.title}: ${res.detail}`);
    check("1. STARTTLS: TLS negociado", res.facts.some((f) => f.key === "TLS"));
  }

  // ---- 2. AUTH LOGIN correcto ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ useAuth: true, user: "usuario", pass: "secreto", auth: "login" }), server.factory);
    check("2. AUTH LOGIN: exito", res.ok, `${res.title}: ${res.detail}`);
    check("2. AUTH LOGIN: mecanismo usado", server.received.authMechanism === "LOGIN");
    check("2. AUTH LOGIN: usuario correcto", server.received.authUser === "usuario");
  }

  // ---- 3. AUTH PLAIN correcto ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ useAuth: true, user: "usuario", pass: "secreto", auth: "plain" }), server.factory);
    check("3. AUTH PLAIN: exito", res.ok, `${res.title}: ${res.detail}`);
    check("3. AUTH PLAIN: usuario correcto", server.received.authUser === "usuario");
  }

  // ---- 4. AUTH CRAM-MD5 correcto (valida HMAC-MD5 de verdad) ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ useAuth: true, user: "usuario", pass: "secreto", auth: "cram-md5" }), server.factory);
    check("4. AUTH CRAM-MD5: exito", res.ok, `${res.title}: ${res.detail}`);
    check("4. AUTH CRAM-MD5: digest validado por el servidor", server.received.authPassOk === true);
  }

  // ---- 5. AUTH automatico elige CRAM-MD5 si esta anunciado ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ useAuth: true, user: "usuario", pass: "secreto", auth: "auto" }), server.factory);
    check("5. AUTH auto: exito", res.ok, `${res.title}: ${res.detail}`);
    check("5. AUTH auto: elige CRAM-MD5", server.received.authMechanism === "CRAM-MD5", server.received.authMechanism ?? "");
  }

  // ---- 6. AUTH auto cae a PLAIN si no hay CRAM-MD5 ----
  {
    const server = createFakeServer({ caps: ["SIZE 1000", "STARTTLS", "AUTH PLAIN LOGIN"] });
    const res = await probe(baseReq({ useAuth: true, user: "usuario", pass: "secreto", auth: "auto" }), server.factory);
    check("6. AUTH auto sin CRAM-MD5: elige PLAIN", res.ok && server.received.authMechanism === "PLAIN", server.received.authMechanism ?? "");
  }

  // ---- 7. Contrasena incorrecta -> fallo de autenticacion ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ useAuth: true, user: "usuario", pass: "mal", auth: "plain" }), server.factory);
    check("7. AUTH con clave incorrecta: falla", !res.ok && res.phase === "auth", `${res.phase}: ${res.detail}`);
  }

  // ---- 8. Envio completo con dot stuffing y subject no ASCII ----
  {
    const server = createFakeServer();
    const res = await probe(
      baseReq({
        useAuth: true,
        user: "usuario",
        pass: "secreto",
        send: true,
        from: "Ana <ana@ejemplo.com>",
        to: "destino@ejemplo.com",
        subject: "Prueba con acentos: ñ á é",
        body: "Primera linea\r\n.\r\nlinea que empieza por punto",
      }),
      server.factory,
    );

    check("8. Envio: exito", res.ok, `${res.title}: ${res.detail}`);
    check("8. Envio: MAIL FROM correcto", server.received.mailFrom === "<ana@ejemplo.com>", server.received.mailFrom ?? "");
    check("8. Envio: RCPT TO correcto", server.received.rcptTo === "<destino@ejemplo.com>", server.received.rcptTo ?? "");

    const msg = server.received.message ?? "";
    check("8. Envio: cabecera From", msg.includes("From: Ana <ana@ejemplo.com>"), msg.slice(0, 200));
    check("8. Envio: asunto codificado (RFC 2047)", msg.includes("Subject: =?UTF-8?B?"), msg.slice(0, 300));
    check("8. Envio: Content-Transfer-Encoding base64", msg.includes("Content-Transfer-Encoding: base64"));

    // El cuerpo va en base64, asi que se descodifica para comprobar el contenido.
    const bodyB64 = msg.split("\r\n\r\n")[1] ?? "";
    const decoded = Buffer.from(bodyB64.replace(/\r\n/g, ""), "base64").toString("utf8");
    check("8. Envio: cuerpo intacto", decoded === "Primera linea\r\n.\r\nlinea que empieza por punto", JSON.stringify(decoded));
  }

  // ---- 9. El servidor no anuncia STARTTLS ----
  {
    const server = createFakeServer({ caps: ["SIZE 1000", "AUTH PLAIN"], supportStartTls: false });
    const res = await probe(baseReq(), server.factory);
    check("9. Sin STARTTLS anunciado: falla con aviso", !res.ok && res.code === "no-starttls", `${res.code}: ${res.detail}`);
  }

  // ---- 10. El servidor rechaza el destinatario ----
  {
    const server = createFakeServer({ rejectRcpt: true });
    const res = await probe(
      baseReq({ send: true, from: "a@ejemplo.com", to: "b@ejemplo.com", user: "usuario" }),
      server.factory,
    );
    check("10. RCPT rechazado: falla en 'envio'", !res.ok && res.phase === "envio", `${res.phase}: ${res.detail}`);
  }

  // ---- 11. Puerto 25 bloqueado sin llegar a conectar ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ port: 25 }), server.factory);
    check("11. Puerto 25: bloqueado", !res.ok && res.code === "port25", `${res.code}: ${res.detail}`);
    check("11. Puerto 25: no se envio nada", server.received.commands.length === 0);
  }

  // ---- 12. Servidor que no responde -> timeout ----
  {
    const server = createFakeServer({ silent: true });
    const t0 = Date.now();
    const res = await probe(baseReq({ timeoutSec: 3 }), server.factory);
    const elapsed = Date.now() - t0;
    check("12. Servidor mudo: timeout", !res.ok && res.code === "timeout", `${res.code}: ${res.detail}`);
    check("12. Servidor mudo: respeta el limite", elapsed < 12000, `${elapsed}ms`);
  }

  // ---- 13. Inyeccion CRLF en el asunto ----
  {
    const server = createFakeServer();
    const res = await probe(
      baseReq({ send: true, from: "a@b.com", to: "c@d.com", subject: "Ok\r\nBcc: victima@mal.com", user: "usuario" }),
      server.factory,
    );
    const msg = server.received.message ?? "";
    // Lo importante: que no se cree una cabecera nueva. Puede aparecer el
    // texto "Bcc:" dentro del asunto, pero nunca al principio de una linea.
    check("13. Inyeccion CRLF: no se crea la cabecera Bcc", !/^Bcc:/m.test(msg), msg.slice(0, 300));
    check("13. Inyeccion CRLF: el envio continua", res.ok);
  }

  // ---- 14. Datos incompletos ----
  {
    const server = createFakeServer();
    const res = await probe(baseReq({ host: "" }), server.factory);
    check("14. Sin host: error de validacion", !res.ok && res.code === "input", `${res.code}`);
  }

  console.log(failures === 0 ? "\nTodo correcto." : `\n${failures} fallo(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
