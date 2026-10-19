/**
 * Cliente SMTP (logica de protocolo, independiente del runtime).
 *
 * El socket se inyecta mediante un `TransportFactory`, de modo que este modulo
 * puede probarse en Node con un servidor simulado. La implementacion real
 * sobre `cloudflare:sockets` vive en `cf-transport.ts`.
 *
 * Limitaciones de la plataforma que condicionan el diseno:
 *
 *  - El puerto 25 esta bloqueado por Cloudflare (no se puede enviar por el).
 *  - No se puede fijar la version de TLS ni inspeccionar el certificado.
 *  - La validacion del certificado la hace el runtime y no se puede desactivar.
 */
import { hmacMd5, toHex } from "./md5.ts";
import type { AuthMechanism, ConnMode, Fact, LogKind, ProbeRequest, ProbeResponse } from "./types.ts";

const MAX_LOG_LINES = 2000;
const MAX_RESPONSE_LINES = 200;

export class SmtpError extends Error {
  code: string;
  hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const CHUNK = 0x8000;

function b64Bytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64Text(text: string): string {
  return b64Bytes(new TextEncoder().encode(text));
}

function b64Decode(text: string): string {
  const bin = atob(text.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Rechaza CR/LF para evitar inyeccion de comandos SMTP. */
function assertNoCRLF(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new SmtpError("input", `El campo "${field}" no puede contener saltos de linea.`);
  }
  return value;
}

/** Extrae la direccion de un valor tipo `Nombre <a@b.com>` o `a@b.com`. */
function extractAddress(value: string): string {
  const v = value.trim();
  const m = v.match(/<([^>]+)>/);
  const addr = (m ? m[1] : v).trim();
  if (!addr) throw new SmtpError("input", "Direccion de correo vacia.");
  assertNoCRLF(addr, "direccion");
  return addr;
}

function wrap76(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 76) out.push(text.slice(i, i + 76));
  return out.join("\r\n");
}

function dotStuff(text: string): string {
  return text.replace(/^\./gm, "..");
}

function rfc2822Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

/** Cabecera segura: sin CR/LF y con codificacion RFC 2047 si no es ASCII. */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${b64Text(clean)}?=`;
}

function withTimeout<T>(p: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError(code, message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Transporte                                                          */
/* ------------------------------------------------------------------ */

/**
 * Abstraccion minima sobre el socket. Permite sustituir la red real por un
 * servidor SMTP simulado en los tests, y mantiene este modulo libre de
 * dependencias del runtime de Cloudflare.
 */
export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(expectedHost?: string): Transport;
  close(): Promise<void>;
}

export type TransportFactory = (
  host: string,
  port: number,
  mode: ConnMode,
) => { transport: Transport; opened: Promise<unknown> };

/* ------------------------------------------------------------------ */
/* Registro                                                            */
/* ------------------------------------------------------------------ */

class Logger {
  lines: { kind: LogKind; text: string }[] = [];

  add(kind: LogKind, text: string): void {
    if (this.lines.length >= MAX_LOG_LINES) return;
    for (const part of text.split("\n")) this.lines.push({ kind, text: part });
  }

  head(text: string): void {
    this.add("head", text);
  }
}

/* ------------------------------------------------------------------ */
/* Sesion SMTP                                                         */
/* ------------------------------------------------------------------ */

interface SmtpResponse {
  code: number;
  lines: string[];
}

class Session {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private transport: Transport;
  private log: Logger;
  private timeoutMs: number;
  private maskPass: () => string;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private closed = false;

  constructor(
    transport: Transport,
    log: Logger,
    timeoutMs: number,
    maskPass: () => string,
  ) {
    this.transport = transport;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.maskPass = maskPass;
    this.reader = transport.readable.getReader();
    this.writer = transport.writable.getWriter();
  }

  static async open(
    host: string,
    port: number,
    mode: ConnMode,
    log: Logger,
    timeoutMs: number,
    maskPass: () => string,
    factory: TransportFactory,
  ): Promise<Session> {
    if (port === 25) {
      throw new SmtpError(
        "port25",
        "Cloudflare Workers no permite conexiones salientes al puerto 25.",
        "Prueba con 587 (STARTTLS), 465 (SSL implicito) o el puerto alternativo de tu proveedor.",
      );
    }

    let transport: Transport;
    let opened: Promise<unknown>;

    try {
      ({ transport, opened } = factory(host, port, mode));
    } catch (e) {
      throw new SmtpError("connect", `No se pudo iniciar la conexion: ${describe(e)}`);
    }

    try {
      await withTimeout(
        opened,
        timeoutMs,
        "connect",
        `Tiempo de espera agotado al conectar con ${host}:${port} (${timeoutMs / 1000}s).`,
      );
    } catch (e) {
      try {
        await transport.close();
      } catch {
        /* ignora */
      }
      if (e instanceof SmtpError) throw e;
      throw new SmtpError(
        "connect",
        `No se pudo conectar con ${host}:${port}: ${describe(e)}`,
        hintForConnect(e, host, port),
      );
    }

    const session = new Session(transport, log, timeoutMs, maskPass);

    // SSL implicito: el TLS empieza antes de cualquier comando SMTP.
    if (mode === "implicit") {
      return session.upgrade(log, host);
    }

    return session;
  }

  /** Actualiza la conexion a TLS (STARTTLS). Devuelve una sesion nueva. */
  upgrade(log: Logger, expectedHost?: string): Session {
    // startTls() falla si los streams antiguos siguen bloqueados por sus
    // readers/writers, asi que hay que soltarlos primero.
    try {
      this.reader.releaseLock();
    } catch {
      /* el reader puede tener una lectura pendiente */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* ignora */
    }

    const secure = this.transport.startTls(expectedHost);
    this.closed = true; // los streams antiguos dejan de ser validos
    return new Session(secure, log, this.timeoutMs, this.maskPass);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Cerrar el writer puede quedarse esperando si el servidor no vacia la
    // cola; nunca debe bloquear el resultado del sondeo.
    try {
      await withTimeout(this.writer.close(), 2000, "close", "cierre lento");
    } catch {
      /* ignora */
    }

    try {
      await withTimeout(this.transport.close(), 2000, "close", "cierre lento");
    } catch {
      /* ignora */
    }
  }

  /* -------------------- lectura -------------------- */

  private findEol(): number {
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i] === 0x0a) return i;
    }
    return -1;
  }

  private async readLine(): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;

    for (;;) {
      const idx = this.findEol();
      if (idx >= 0) {
        const line = this.decoder.decode(this.buf.subarray(0, idx));
        this.buf = this.buf.slice(idx + 1);
        return line.endsWith("\r") ? line.slice(0, -1) : line;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SmtpError(
          "timeout",
          `El servidor no respondio en ${this.timeoutMs / 1000}s.`,
          "Comprueba el puerto y el modo de cifrado (STARTTLS / SSL implicito).",
        );
      }

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await withTimeout(
          this.reader.read(),
          remaining,
          "timeout",
          `El servidor no respondio en ${this.timeoutMs / 1000}s.`,
        );
      } catch (e) {
        if (e instanceof SmtpError) throw e;
        throw new SmtpError("read", `Error leyendo del servidor: ${describe(e)}`);
      }

      if (chunk.done) {
        if (this.buf.length > 0) {
          const rest = this.decoder.decode(this.buf).replace(/\r?\n$/, "");
          this.buf = new Uint8Array(0);
          return rest;
        }
        throw new SmtpError(
          "eof",
          "El servidor cerro la conexion sin responder.",
          "Suele indicar que el modo de cifrado no es el correcto o que el servidor rechaza tu IP.",
        );
      }

      this.buf = concat(this.buf, chunk.value);
    }
  }

  async readResponse(): Promise<SmtpResponse> {
    const first = await this.readLine();

    if (!/^\d{3}/.test(first)) {
      throw new SmtpError(
        "protocol",
        `Respuesta inesperada del servidor: ${JSON.stringify(first.slice(0, 120))}`,
        "Puede que el servidor espere TLS desde el primer byte (prueba 'SSL implicito').",
      );
    }

    const code = Number(first.slice(0, 3));
    const lines = [first.slice(3).trim()];
    let more = first[3] === "-";
    let guard = 0;

    while (more) {
      if (++guard > MAX_RESPONSE_LINES) {
        throw new SmtpError("protocol", "El servidor envio una respuesta multilinea demasiado larga.");
      }
      const line = await this.readLine();
      lines.push(line.length > 4 ? line.slice(4) : line.slice(3).trim());
      more = line[3] === "-";
    }

    this.log.add("trace", `S: ${code} ${lines.filter(Boolean).join(" | ").slice(0, 400)}`);
    return { code, lines };
  }

  /* -------------------- escritura -------------------- */

  /** Escribe texto tal cual, sin anadir CRLF. Para el cuerpo del mensaje. */
  async sendRaw(text: string): Promise<void> {
    try {
      await withTimeout(
        this.writer.write(this.encoder.encode(text)),
        this.timeoutMs,
        "timeout",
        "Tiempo de espera agotado al enviar los datos.",
      );
    } catch (e) {
      if (e instanceof SmtpError) throw e;
      throw new SmtpError("write", `Error escribiendo en el socket: ${describe(e)}`);
    }
  }

  async send(command: string, mask = false): Promise<void> {
    const line = mask ? `${command.split(" ")[0]} ${this.maskPass()}` : command;
    this.log.add("trace", `C: ${line}`);
    await this.sendRaw(command + "\r\n");
  }

  async command(command: string, mask = false): Promise<SmtpResponse> {
    await this.send(command, mask);
    return this.readResponse();
  }

  /** Ejecuta un comando y exige un codigo concreto. */
  async expect(command: string, expected: number[], mask = false): Promise<SmtpResponse> {
    const res = await this.command(command, mask);
    if (!expected.includes(res.code)) {
      throw new SmtpError(
        `smtp-${res.code}`,
        `${command.split(" ")[0]} respondio ${res.code}: ${res.lines.filter(Boolean).join(" ")}`,
      );
    }
    return res;
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostico de errores                                              */
/* ------------------------------------------------------------------ */

function describe(e: unknown): string {
  if (e instanceof Error) {
    const extra = (e as { cause?: unknown }).cause;
    const base = e.message || e.name;
    return extra ? `${base} (${describe(extra)})` : base;
  }
  return String(e);
}

function hintForConnect(e: unknown, host: string, port: number): string | undefined {
  const msg = describe(e).toLowerCase();

  if (msg.includes("port 25") || msg.includes("prohibited")) {
    return "Cloudflare bloquea el puerto 25. Usa 587, 465 o 2525.";
  }
  if (msg.includes("proxy request failed") || msg.includes("cannot connect to the specified address")) {
    return `No se pudo alcanzar ${host}:${port}. Comprueba el host, el puerto y que el servidor acepte conexiones desde Internet.`;
  }
  if (msg.includes("loop")) {
    return "El host apunta a Cloudflare y no se puede conectar desde un Worker.";
  }
  if (msg.includes("certificate") || msg.includes("tls") || msg.includes("ssl") || msg.includes("handshake")) {
    return "El handshake TLS fallo. Si el servidor usa un certificado autofirmado o caducado, Cloudflare no permite aceptarlo.";
  }
  if (msg.includes("timed out") || msg.includes("timeout")) {
    return "El servidor no respondio. Puede estar filtrando el puerto o requerir otro modo de cifrado.";
  }
  if (msg.includes("refused")) {
    return "El servidor rechazo la conexion en ese puerto.";
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Capacidades                                                         */
/* ------------------------------------------------------------------ */

interface Caps {
  raw: string[];
  auth: string[];
  starttls: boolean;
  size?: string;
}

function parseCaps(lines: string[]): Caps {
  const raw = lines.map((l) => l.trim()).filter(Boolean);
  const caps: Caps = { raw, auth: [], starttls: false };

  for (const line of raw) {
    const upper = line.toUpperCase();

    if (upper.startsWith("STARTTLS")) caps.starttls = true;

    if (upper.startsWith("SIZE")) {
      const parts = line.split(/\s+/);
      if (parts[1]) caps.size = parts[1];
    }

    // "AUTH PLAIN LOGIN" y la forma antigua "AUTH=PLAIN LOGIN"
    if (upper.startsWith("AUTH")) {
      const rest = line.replace(/^AUTH[=\s]+/i, "");
      for (const mech of rest.split(/\s+/)) {
        if (mech) caps.auth.push(mech.toUpperCase());
      }
    }
  }

  return caps;
}

/* ------------------------------------------------------------------ */
/* Autenticacion                                                       */
/* ------------------------------------------------------------------ */

function pickMechanism(requested: AuthMechanism, advertised: string[]): string {
  if (requested !== "auto") return requested.toUpperCase();

  const preference = ["CRAM-MD5", "PLAIN", "LOGIN"];
  for (const mech of preference) {
    if (advertised.includes(mech)) return mech;
  }
  // Si el servidor no anuncia nada, PLAIN es la apuesta mas habitual.
  return "PLAIN";
}

async function authenticate(
  session: Session,
  mechanism: string,
  user: string,
  pass: string,
  log: Logger,
): Promise<void> {
  if (mechanism === "LOGIN") {
    let res = await session.command("AUTH LOGIN");
    if (res.code !== 334) {
      throw new SmtpError(`smtp-${res.code}`, `AUTH LOGIN respondio ${res.code}: ${res.lines.join(" ")}`);
    }
    res = await session.command(b64Text(user), true);
    if (res.code !== 334) {
      throw new SmtpError(
        `smtp-${res.code}`,
        `El servidor rechazo el usuario (${res.code}): ${res.lines.join(" ")}`,
      );
    }
    res = await session.command(b64Text(pass), true);
    if (res.code !== 235) {
      throw new SmtpError(
        "auth",
        `Autenticacion rechazada (${res.code}): ${res.lines.join(" ")}`,
        "Revisa usuario y contrasena. Muchos proveedores exigen una 'contrasena de aplicacion'.",
      );
    }
    return;
  }

  if (mechanism === "PLAIN") {
    const token = b64Text(`\0${user}\0${pass}`);
    const res = await session.command(`AUTH PLAIN ${token}`, true);
    if (res.code !== 235) {
      throw new SmtpError(
        "auth",
        `Autenticacion rechazada (${res.code}): ${res.lines.join(" ")}`,
        "Revisa usuario y contrasena. Muchos proveedores exigen una 'contrasena de aplicacion'.",
      );
    }
    return;
  }

  if (mechanism === "CRAM-MD5") {
    const res = await session.command("AUTH CRAM-MD5");
    if (res.code !== 334) {
      throw new SmtpError(
        `smtp-${res.code}`,
        `AUTH CRAM-MD5 no disponible (${res.code}): ${res.lines.join(" ")}`,
        "Prueba con LOGIN o PLAIN.",
      );
    }

    const challenge = b64Decode(res.lines[0] ?? "");
    log.add("hint", `Desafio CRAM-MD5 recibido (${challenge.length} caracteres).`);

    const digest = toHex(hmacMd5(new TextEncoder().encode(pass), new TextEncoder().encode(challenge)));
    const answer = await session.command(b64Text(`${user} ${digest}`), true);

    if (answer.code !== 235) {
      throw new SmtpError(
        "auth",
        `Autenticacion rechazada (${answer.code}): ${answer.lines.join(" ")}`,
        "Revisa usuario y contrasena.",
      );
    }
    return;
  }

  throw new SmtpError("auth", `Mecanismo AUTH no soportado: ${mechanism}`);
}

/* ------------------------------------------------------------------ */
/* Mensaje                                                             */
/* ------------------------------------------------------------------ */

function buildMessage(req: ProbeRequest): { message: string; messageId: string } {
  const from = extractAddress(req.from ?? "");
  const to = extractAddress(req.to ?? "");
  const subject = req.subject ?? "Correo de prueba desde MailCheck";
  const body = req.body ?? "";
  const messageId = `<${crypto.randomUUID()}@mailcheck>`;

  const encodedBody = wrap76(b64Bytes(new TextEncoder().encode(body)));

  const headers = [
    `From: ${headerValue(req.from ?? from)}`,
    `To: ${headerValue(req.to ?? to)}`,
    `Subject: ${headerValue(subject)}`,
    `Date: ${rfc2822Date(new Date())}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    `X-Mailer: MailCheck Web`,
  ];

  const message = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
  return { message, messageId };
}

/* ------------------------------------------------------------------ */
/* Sondeo principal                                                    */
/* ------------------------------------------------------------------ */

export async function probe(req: ProbeRequest, factory: TransportFactory): Promise<ProbeResponse> {
  const started = Date.now();
  const log = new Logger();
  const facts: Fact[] = [];

  const timeoutMs = Math.min(Math.max((req.timeoutSec ?? 20) * 1000, 2000), 120_000);

  // Limite global: ningun sondeo debe durar mas que el timeout indicado
  // (mas un pequeño margen), aunque encadene varias operaciones.
  const hardLimitMs = timeoutMs + 5000;

  const run = probeInner(req, log, facts, started, timeoutMs, factory);

  const guarded = new Promise<ProbeResponse>((resolve) => {
    const timer = setTimeout(() => {
      log.add("fail", `La comprobacion supero el limite de ${Math.round(hardLimitMs / 1000)}s.`);
      resolve({
        ok: false,
        title: "Tiempo agotado",
        detail: `La comprobacion supero el limite de ${Math.round(hardLimitMs / 1000)}s.`,
        phase: "timeout",
        elapsedMs: Date.now() - started,
        facts,
        log: log.lines,
        code: "timeout",
      });
    }, hardLimitMs);

    run.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          title: "Comprobacion fallida",
          detail: e instanceof Error ? e.message : String(e),
          phase: "interno",
          elapsedMs: Date.now() - started,
          facts,
          log: log.lines,
          code: "interno",
        });
      },
    );
  });

  return guarded;
}

async function probeInner(
  req: ProbeRequest,
  log: Logger,
  facts: Fact[],
  started: number,
  timeoutMs: number,
  factory: TransportFactory,
): Promise<ProbeResponse> {
  const host = (req.host ?? "").trim();
  const port = Number(req.port);
  const mode: ConnMode = req.mode;
  const user = req.user ?? "";
  const pass = req.pass ?? "";

  let phase = "validacion";
  let session: Session | undefined;

  const mask = () => "********";

  const addFact = (key: string, value: string) => {
    if (value) facts.push({ key, value });
  };

  try {
    /* ---------- validacion ---------- */
    if (!host) throw new SmtpError("input", "Indica el servidor SMTP.");
    assertNoCRLF(host, "servidor");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SmtpError("input", "El puerto debe estar entre 1 y 65535.");
    }
    if (port === 25) {
      throw new SmtpError(
        "port25",
        "Cloudflare Workers no permite conexiones salientes al puerto 25.",
        "Usa 587 (STARTTLS), 465 (SSL implicito) o el puerto alternativo de tu proveedor.",
      );
    }
    if (req.useAuth && !user) throw new SmtpError("input", "Indica el usuario o desmarca la autenticacion.");
    if (req.send) {
      if (!req.from) throw new SmtpError("input", "Indica el remitente del correo de prueba.");
      if (!req.to) throw new SmtpError("input", "Indica el destinatario del correo de prueba.");
      extractAddress(req.from);
      extractAddress(req.to);
    }

    const modeName =
      mode === "implicit" ? "SSL/TLS implicito" : mode === "starttls" ? "STARTTLS" : "Sin cifrado";

    log.head(`MailCheck - ${host}:${port} (${modeName})`);

    addFact("Servidor", `${host}:${port}`);
    addFact("Modo", modeName);
    addFact("Timeout", `${timeoutMs / 1000}s`);

    /* ---------- conexion ---------- */
    phase = "conexion";
    const tConnect = Date.now();
    session = await Session.open(host, port, mode, log, timeoutMs, mask, factory);
    const connectMs = Date.now() - tConnect;
    log.add("ok", `Conectado en ${connectMs} ms.`);
    addFact("Conexion TCP", `${connectMs} ms`);

    if (mode === "implicit") {
      log.add("ok", "TLS implicito establecido (el runtime valida el certificado automaticamente).");
    }

    /* ---------- saludo ---------- */
    phase = "saludo";
    const banner = await session.readResponse();
    if (banner.code !== 220) {
      throw new SmtpError(`smtp-${banner.code}`, `El servidor no saludo con 220: ${banner.lines.join(" ")}`);
    }
    const bannerText = banner.lines.filter(Boolean).join(" ");
    log.add("info", `Saludo: ${bannerText.slice(0, 200)}`);
    addFact("Saludo", bannerText.slice(0, 160));

    /* ---------- EHLO ---------- */
    phase = "ehlo";
    const heloName = (req.helo ?? "").trim() || "mailcheck.local";
    assertNoCRLF(heloName, "EHLO");

    let ehlo = await session.command(`EHLO ${heloName}`);

    if (ehlo.code !== 250) {
      log.add("warn", `EHLO respondio ${ehlo.code}; se intenta HELO.`);
      const helo = await session.command(`HELO ${heloName}`);
      if (helo.code !== 250) {
        throw new SmtpError("ehlo", `El servidor rechazo EHLO y HELO (${helo.code}).`);
      }
      ehlo = helo;
    }

    const caps = parseCaps(ehlo.lines);
    log.add("info", `Capacidades: ${caps.raw.join(", ").slice(0, 300)}`);
    addFact("Capacidades", caps.raw.filter(Boolean).join(", ").slice(0, 220));
    if (caps.size) addFact("Tamano maximo", `${Number(caps.size).toLocaleString("es-ES")} bytes`);

    /* ---------- STARTTLS ---------- */
    if (mode === "starttls") {
      phase = "starttls";

      if (!caps.starttls) {
        throw new SmtpError(
          "no-starttls",
          "El servidor no anuncia STARTTLS en EHLO.",
          "Prueba con 'SSL implicito' (puerto 465) o con 'Sin cifrado'.",
        );
      }

      const res = await session.command("STARTTLS");
      if (res.code !== 220) {
        throw new SmtpError(
          `smtp-${res.code}`,
          `El servidor rechazo STARTTLS (${res.code}): ${res.lines.join(" ")}`,
          "Puede requerir SSL implicito en el puerto 465.",
        );
      }

      log.add("info", "Actualizando la conexion a TLS...");
      session = session.upgrade(log);

      // Tras el upgrade hay que repetir EHLO.
      const ehloTls = await session.command(`EHLO ${heloName}`);
      if (ehloTls.code !== 250) {
        throw new SmtpError("ehlo", `EHLO tras TLS respondio ${ehloTls.code}.`);
      }
      const tlsCaps = parseCaps(ehloTls.lines);
      log.add("ok", "TLS establecido correctamente.");
      addFact("TLS", "STARTTLS negociado");

      // Las capacidades relevantes son las de despues del upgrade.
      caps.auth = tlsCaps.auth;
      caps.size = tlsCaps.size ?? caps.size;
    } else if (mode === "implicit") {
      addFact("TLS", "Implicito (desde el primer byte)");
    }

    /* ---------- autenticacion ---------- */
    if (req.useAuth) {
      phase = "auth";

      if (caps.auth.length) addFact("AUTH anunciado", caps.auth.join(", "));

      const mechanism = pickMechanism(req.auth ?? "auto", caps.auth);
      log.add("info", `Autenticando con AUTH ${mechanism}...`);

      const finalUser = req.domain ? `${req.domain}\\${user}` : user;
      if (req.domain) {
        log.add(
          "warn",
          `Se enviara "${req.domain}\\${user}" como usuario. La mayoria de servidores de correo rechazan el dominio.`,
        );
      }

      await authenticate(session, mechanism, finalUser, pass, log);
      log.add("ok", `Autenticacion correcta (AUTH ${mechanism}).`);
      addFact("Autenticacion", `Correcta (${mechanism})`);
    } else {
      log.add("info", "Autenticacion omitida.");
      addFact("Autenticacion", "No solicitada");
    }

    /* ---------- envio ---------- */
    if (req.send) {
      phase = "envio";

      const from = extractAddress(req.from ?? "");
      const to = extractAddress(req.to ?? "");

      const mailFrom = await session.command(`MAIL FROM:<${from}>`);
      if (mailFrom.code !== 250) {
        throw new SmtpError(
          `smtp-${mailFrom.code}`,
          `MAIL FROM rechazado (${mailFrom.code}): ${mailFrom.lines.join(" ")}`,
          "El remitente debe pertenecer al dominio del servidor o estar autorizado.",
        );
      }

      const rcptTo = await session.command(`RCPT TO:<${to}>`);
      if (rcptTo.code !== 250 && rcptTo.code !== 251) {
        throw new SmtpError(
          `smtp-${rcptTo.code}`,
          `RCPT TO rechazado (${rcptTo.code}): ${rcptTo.lines.join(" ")}`,
          "El destinatario puede estar bloqueado por el servidor.",
        );
      }

      const data = await session.command("DATA");
      if (data.code !== 354) {
        throw new SmtpError(`smtp-${data.code}`, `DATA rechazado (${data.code}): ${data.lines.join(" ")}`);
      }

      const { message, messageId } = buildMessage(req);
      const payload = `${dotStuff(message)}\r\n.\r\n`;

      await session.sendRaw(payload);
      const queued = await session.readResponse();

      if (queued.code !== 250) {
        throw new SmtpError(
          `smtp-${queued.code}`,
          `El servidor no acepto el mensaje (${queued.code}): ${queued.lines.join(" ")}`,
        );
      }

      log.add("ok", `Mensaje aceptado: ${queued.lines.filter(Boolean).join(" ")}`);
      addFact("Mensaje", "Aceptado por el servidor (250)");
      addFact("Message-ID", messageId);
    } else {
      log.add("info", "Envio omitido (solo comprobacion).");
    }

    /* ---------- cierre ---------- */
    phase = "cierre";
    try {
      await session.command("QUIT");
    } catch (e) {
      log.add("warn", `No se pudo cerrar la sesion con QUIT: ${describe(e)}`);
    }

    const elapsedMs = Date.now() - started;
    const detail = req.send
      ? `Conexion, ${req.useAuth ? "autenticacion" : "sin autenticacion"} y envio correctos en ${elapsedMs} ms.`
      : `Conexion y ${req.useAuth ? "autenticacion" : "saludo"} correctos en ${elapsedMs} ms.`;

    return {
      ok: true,
      title: req.send ? "Correo de prueba enviado" : "Comprobacion correcta",
      detail,
      phase: "completado",
      elapsedMs,
      facts,
      log: log.lines,
      code: "ok",
    };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    const err =
      e instanceof SmtpError
        ? e
        : new SmtpError("interno", describe(e));

    log.add("fail", err.message);
    if (err.hint) log.add("hint", err.hint);

    return {
      ok: false,
      title: err.code === "port25" ? "Puerto no permitido" : titleForPhase(phase),
      detail: err.message,
      phase,
      elapsedMs,
      facts,
      log: log.lines,
      code: err.code,
    };
  } finally {
    if (session) await session.close();
  }
}

function titleForPhase(phase: string): string {
  switch (phase) {
    case "conexion":
      return "No se pudo conectar";
    case "saludo":
      return "Sin saludo del servidor";
    case "ehlo":
      return "EHLO rechazado";
    case "starttls":
      return "Fallo al negociar TLS";
    case "auth":
      return "Autenticacion fallida";
    case "envio":
      return "Fallo al enviar el mensaje";
    case "cierre":
      return "Error al cerrar la conexion";
    case "validacion":
      return "Datos incompletos";
    default:
      return "Comprobacion fallida";
  }
}
