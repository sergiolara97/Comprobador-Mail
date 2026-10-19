/**
 * Barrido de puertos.
 *
 * Solo comprueba si el TCP acepta la conexion, y solo en los puertos SMTP
 * permitidos por `target.ts`. Cloudflare limita a 6 las conexiones salientes
 * simultaneas por peticion, asi que se hace en tandas.
 */
import { connect } from "cloudflare:sockets";
import { isAllowedPort, MAX_SWEEP_PORTS } from "./target.ts";
import type { SweepPortResult, SweepResponse } from "./types.ts";

const CONCURRENCY = 6;
const BANNER_TIMEOUT_MS = 1500;
const BANNER_BYTES = 220;

async function testPort(host: string, port: number, timeoutMs: number): Promise<SweepPortResult> {
  const started = Date.now();

  if (port === 25) {
    return {
      port,
      open: false,
      ms: 0,
      error: "Cloudflare bloquea el puerto 25",
    };
  }

  let socket: Socket | undefined;
  try {
    socket = connect({ hostname: host, port });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      socket!.opened.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

    const ms = Date.now() - started;

    // Intenta leer el banner de bienvenida (SMTP lo envia al conectar).
    let banner: string | undefined;
    try {
      const reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), BANNER_TIMEOUT_MS)),
      ]);
      if (chunk && !chunk.done && chunk.value) {
        banner = new TextDecoder()
          .decode(chunk.value.subarray(0, BANNER_BYTES))
          .split(/\r?\n/)[0]
          ?.trim();
      }
      try {
        reader.releaseLock();
      } catch {
        /* ignora */
      }
    } catch {
      /* el banner es opcional */
    }

    return { port, open: true, ms, banner: banner || undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout/i.test(msg);
    return {
      port,
      open: false,
      ms: Date.now() - started,
      error: isTimeout ? `Sin respuesta en ${timeoutMs / 1000}s` : msg.slice(0, 160),
    };
  } finally {
    if (socket) {
      try {
        await socket.close();
      } catch {
        /* ignora */
      }
    }
  }
}

export async function sweep(host: string, ports: number[], timeoutSec: number): Promise<SweepResponse> {
  const started = Date.now();
  const cleanHost = (host ?? "").trim();

  if (!cleanHost) throw new Error("Indica el servidor a comprobar.");

  const unique = [...new Set(ports.filter((p) => isAllowedPort(p)))].slice(0, MAX_SWEEP_PORTS);

  if (unique.length === 0) {
    throw new Error("Indica al menos un puerto valido (los SMTP habituales).");
  }

  const timeoutMs = Math.min(Math.max(timeoutSec * 1000, 1000), 15_000);
  const results: SweepPortResult[] = [];

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const done = await Promise.all(batch.map((p) => testPort(cleanHost, p, timeoutMs)));
    results.push(...done);
  }

  results.sort((a, b) => a.port - b.port);

  return {
    ok: results.some((r) => r.open),
    host: cleanHost,
    results,
    elapsedMs: Date.now() - started,
  };
}
