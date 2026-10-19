/**
 * Transporte real sobre `cloudflare:sockets`.
 *
 * Se mantiene aparte de smtp.ts para que el protocolo SMTP pueda probarse en
 * Node sin cargar modulos exclusivos del runtime de Workers.
 */
import { connect } from "cloudflare:sockets";
import type { ConnMode } from "./types.ts";
import type { Transport, TransportFactory } from "./smtp.ts";

function socketTransport(socket: Socket): Transport {
  return {
    readable: socket.readable as ReadableStream<Uint8Array>,
    writable: socket.writable as WritableStream<Uint8Array>,
    startTls(expectedHost?: string): Transport {
      const secure = expectedHost
        ? socket.startTls({ expectedServerHostname: expectedHost })
        : socket.startTls();
      return socketTransport(secure);
    },
    close: () => socket.close(),
  };
}

export const cloudflareTransportFactory: TransportFactory = (host, port, mode: ConnMode) => {
  // Para SSL implicito se usa 'starttls' + upgrade inmediato en lugar de
  // secureTransport: "on". El resultado es identico (TLS desde el primer
  // byte) pero "on" se queda colgado en algunos entornos de ejecucion.
  const secureTransport: "off" | "starttls" = mode === "plain" ? "off" : "starttls";
  const socket = connect({ hostname: host, port }, { secureTransport, allowHalfOpen: false });
  return { transport: socketTransport(socket), opened: socket.opened };
};
