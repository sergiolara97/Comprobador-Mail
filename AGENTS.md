# AGENTS.md

Port a Cloudflare Workers de `MailCheck.exe` (app WPF en C#/.NET): comprobador de
servidores SMTP con TLS, autenticación, envío de prueba y barrido de puertos.
El ejecutable original se conserva como referencia; **no lo borres**.

## Comandos

```bash
npm install
npm run dev        # wrangler dev -> http://127.0.0.1:8787
npm run typecheck  # tsc --noEmit
npm test           # md5 + limites + smtp + contraste
```

Tests sueltos: `npm run test:md5`, `npm run test:limits`, `npm run test:smtp`,
`npm run test:contrast`.

En CI (`.github/workflows/deploy.yml`) cada push a `main` encadena
**typecheck → test → deploy**. Un `npm test` en rojo bloquea el despliegue.

**Requiere Node >= 22.6** (campo `engines`). Los tests corren con
`node --experimental-strip-types`; no los ejecutes con `node fichero.ts` a secas ni los
migres a `tsx`/`ts-node`.

## Invariantes que hay que respetar

**`src/lib/smtp.ts` no puede importar `cloudflare:sockets`.** Recibe un
`TransportFactory` inyectado para que el protocolo se pruebe en Node contra un servidor
SMTP simulado. El socket real vive en `src/lib/cf-transport.ts` y lo inyecta
`src/index.ts` (y `test/smtp.test.ts` inyecta el falso). Añadir ese import al protocolo
rompe la suite de tests, que es la red de seguridad de todo el flujo SMTP.

**Los imports relativos llevan la extensión `.ts` explícita** (`from "./types.ts"`), con
`allowImportingTsExtensions` activado. Lo exige el ESM de Node; no las quites.

**El TLS implícito (465) se implementa como `secureTransport: "starttls"` + `startTls()`
inmediato**, no como `secureTransport: "on"` — "on" se queda colgado sin responder. Está
documentado en el comentario de `cf-transport.ts`. No lo "simplifiques".

**`Session.send()` añade el CRLF; para el cuerpo del mensaje se usa `sendRaw()`.** El
terminador de `DATA` ya lleva su propio `\r\n.\r\n`; un CRLF de más desincroniza la
conversación y el servidor responde a una línea vacía. Fue un bug real.

**MD5/HMAC-MD5 es propio (`src/lib/md5.ts`)** porque WebCrypto no expone MD5 y
CRAM-MD5 lo necesita. No lo sustituyas por `crypto.subtle`.

**`src/lib/target.ts` (puertos permitidos y hosts bloqueados) es lógica pura.** No puede
importar `cloudflare:sockets` ni nada del runtime: `test/limits.test.ts` lo ejecuta en
Node, y el protocolo SMTP y el barrido lo usan como puerta de entrada. El barrido
(`src/lib/sweep.ts`) vuelve a filtrar con la misma función, aunque `src/index.ts` ya lo
haya hecho: es defensa en profundidad, no duplicación inútil.

**El puerto 25 sigue en `ALLOWED_PORTS` a propósito.** No se conecta nunca (Cloudflare lo
bloquea), pero se deja llegar al protocolo para que `smtp.ts`/`sweep.ts` emitan su
mensaje específico de plataforma en vez de un error genérico de política.

**Los cupos horarios viven en el Durable Object `RateLimiter`** (`src/lib/limiter.ts`),
y la clase **tiene que exportarse desde `src/index.ts`** o wrangler no la registra. Si
cambia la tabla `hits`, hace falta un tag nuevo en `migrations` de `wrangler.jsonc`. Los
`namespace_id` de `ratelimits` deben ser únicos en la cuenta: dos bindings con el mismo
número comparten contadores. Los números de los cupos están en `LIMITS`, en
`src/index.ts`.

## Interfaz

- **Sin build**: `public/` se sirve tal cual como assets estáticos vía el binding
  `env.ASSETS`. El Worker solo atiende `/api/*`. No introduzcas un bundler.
- **`/api/*` solo acepta POST**, incluido `/api/me`.
- El tema se resuelve **en dos sitios**: el script inline del `<head>` de
  `public/index.html` (evita el destello al cargar) y `renderTheme()` en
  `public/app.js`. Si tocas la lógica, actualiza los dos. Clave de `localStorage`:
  `mailcheck-theme` (`auto` | `light` | `dark`, por defecto `auto`).
- La paleta de `public/styles.css` está **verificada por `test/contrast.mjs`**: cada par
  tiene su mínimo WCAG AA declarado. Si cambias un color, actualiza el test con los
  valores reales y ejecuta `npm run test:contrast`.
- El registro (`#log`) es la superficie oscura tipo consola y sigue siéndolo en tema
  claro: es intencionado, no un resto del diseño anterior.

## Configuración y despliegue

- `wrangler.jsonc`: Worker `mailcheck`, binding `ASSETS`, Durable Object `LIMITER`
  (`RateLimiter`) con su migración `v1`, y el binding `ratelimits` `RL_BURST` (5/10 s por
  IP). El despliegue aplica la migración solo: **no hay que crear nada en el panel**.
- **Cloudflare Access es opcional.** Con `TEAM_DOMAIN` y `POLICY_AUD` definidos, el
  Worker verifica el JWT en `/api/*` (`src/lib/access.ts`). Sin ellos la app queda
  abierta: la sostienen los cupos (50/hora por IP, 5 envíos de prueba, 1000/hora global)
  y no la cierres sin querer — la herramienta recibe credenciales SMTP reales.
- La URL `*.workers.dev` **no pasa por Access**; de ahí que la verificación se haga
  dentro del Worker y no solo con una política.
- El CI necesita los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
- `@cloudflare/workers-types` debe ser **v5**: la v4 choca con las peer dependencies de
  wrangler 4.x.

## Límites de la plataforma (no son bugs)

- **Puerto 25 bloqueado.** Se rechaza antes de conectar, con mensaje propio.
- **Versión de TLS no configurable** y **certificado no inspeccionable**: el runtime
  negocia y valida por su cuenta. Estas funciones del `.exe` original no se pueden
  portar; la interfaz las declara en la tarjeta "Límites de la versión web".
- **6 conexiones salientes simultáneas** por petición: el barrido va en tandas.
- **El binding `ratelimits` solo admite ventanas de 10 o 60 s** y sus contadores son
  locales a cada ubicación de Cloudflare. Por eso los cupos horarios exactos los lleva un
  Durable Object y el binding solo frena ráfagas.
- **En esta red, un firewall Sophos intercepta el puerto 465 en local** con un
  certificado autofirmado, así que probar 465 contra `wrangler dev` falla y devuelve
  "el servidor cerró la conexión". En el edge de Cloudflare funciona. No persigas ese
  fallo como si fuera del código.
