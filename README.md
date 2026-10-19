# MailCheck Web

Comprobador de servidores SMTP para navegador, desplegado en **Cloudflare Workers**.

Es el port a la web de `MailCheck.exe` (aplicación WPF en C#/.NET Framework). Permite
comprobar servidores SMTP: conexión, TLS (STARTTLS e implícito), autenticación,
envío de un correo de prueba, barrido de puertos y registro detallado de la sesión.

---

## Índice

- [Qué hace](#qué-hace)
- [Arquitectura](#arquitectura)
- [Límites de Cloudflare](#límites-de-cloudflare-importante)
- [Puesta en marcha](#puesta-en-marcha)
- [Tests](#tests)
- [Despliegue](#despliegue)
- [Proteger con Cloudflare Access](#proteger-con-cloudflare-access)
- [Solución de problemas](#solución-de-problemas)
- [Estructura del proyecto](#estructura-del-proyecto)

---

## Qué hace

| Función | Estado |
|---|---|
| Conexión TCP y lectura del saludo (banner) | ✅ |
| `EHLO` con reserva a `HELO` y lectura de capacidades | ✅ |
| STARTTLS | ✅ |
| SSL/TLS implícito (puerto 465) | ✅ |
| Autenticación `AUTH LOGIN` / `PLAIN` / `CRAM-MD5` y selección automática | ✅ |
| Envío de correo de prueba (`MAIL FROM` → `RCPT TO` → `DATA`) | ✅ |
| Barrido de puertos con detección de banner | ✅ |
| Registro con copiar / guardar / limpiar y filtro de traza SMTP | ✅ |
| Tema claro / oscuro, siguiendo al sistema operativo por defecto | ✅ |
| Puerto 25 | ❌ Bloqueado por Cloudflare |
| Fijar la versión de TLS (1.0 / 1.1 / 1.2 / 1.3, "heredado .NET 4.0") | ❌ No es posible |
| Ver el certificado del servidor / aceptar certificados no válidos | ❌ No es posible |

Todo lo que no se puede hacer se indica también dentro de la propia interfaz, en la
tarjeta **"Límites de la versión web"**.

---

## Arquitectura

```
public/                 Interfaz (HTML + CSS + JS, sin dependencias ni build)
  index.html
  styles.css
  app.js

src/
  index.ts              Router del Worker: /api/probe, /api/sweep, /api/me + estáticos
  lib/
    smtp.ts             Protocolo SMTP (transporte inyectable, probado con tests)
    cf-transport.ts     Transporte real sobre `cloudflare:sockets`
    sweep.ts            Barrido de puertos
    md5.ts              MD5 + HMAC-MD5 (para CRAM-MD5; WebCrypto no expone MD5)
    access.ts           Verificación del JWT de Cloudflare Access
    types.ts            Tipos compartidos

test/
  md5.test.ts           MD5/HMAC-MD5 contra los vectores oficiales (RFC 1321 y 2202)
  smtp.test.ts          Protocolo completo contra un servidor SMTP simulado en memoria
```

El protocolo SMTP no depende del runtime: recibe un `TransportFactory`, así que los
tests lo ejecutan en Node con un servidor simulado, sin abrir conexiones reales.

No hay proceso de build para el frontend. `wrangler` empaqueta el Worker y sirve
`public/` como assets estáticos.

---

## Límites de Cloudflare (importante)

Estos límites son de la plataforma, no del código:

1. **Puerto 25 bloqueado.** Los Workers no pueden abrir conexiones salientes al 25.
   Usa 587 (STARTTLS), 465 (SSL implícito) o el puerto alternativo de tu proveedor
   (2525, 2465, 1025...). La app lo detecta y lo explica antes de intentar conectar.
2. **Versión de TLS no configurable.** El runtime negocia automáticamente (TLS 1.2/1.3).
   No se puede reproducir el fallo *"No se pudo realizar una llamada a SSPI"* de las
   aplicaciones .NET antiguas, porque no se puede forzar Ssl3/TLS 1.0.
3. **Certificado no inspeccionable.** Cloudflare valida siempre el certificado y no
   permite desactivar la validación, así que no hay datos de emisor, caducidad ni
   huella, y no se puede aceptar un certificado autofirmado o caducado.
4. **6 conexiones salientes simultáneas por petición.** El barrido de puertos se hace
   en tandas de 6.
5. **Destinos bloqueados.** No se puede conectar a IPs de Cloudflare, `localhost`,
   rangos privados (`10.x`, `192.168.x`...) ni al propio Worker.

---

## Puesta en marcha

Requisitos: **Node.js 22.6 o superior** (los tests usan el borrado de tipos nativo de Node).

```bash
npm install
npm run dev          # http://127.0.0.1:8787
```

Otros comandos:

```bash
npm run typecheck    # comprobación de tipos (tsc --noEmit)
npm test             # tests de MD5 y del protocolo SMTP
```

> **Nota sobre redes corporativas.** Si tu red tiene un firewall que intercepta TLS
> (Sophos, Zscaler, etc.), el puerto 465 puede fallar en local con un certificado
> autofirmado del propio firewall. No es un fallo de la app: en Cloudflare funciona.

---

## Tests

```bash
npm run test:md5     # vectores oficiales de MD5 y HMAC-MD5
npm run test:smtp    # 37 comprobaciones del protocolo SMTP
```

El test SMTP levanta un servidor simulado en memoria y verifica: saludo, EHLO,
STARTTLS, los tres mecanismos de autenticación (incluido el digest real de CRAM-MD5),
el envío completo, la codificación RFC 2047 del asunto, el *dot stuffing*, el rechazo
de inyección de cabeceras por CRLF, el bloqueo del puerto 25 y los tiempos de espera.

---

## Despliegue

### Automático (GitHub Actions)

El repositorio incluye `.github/workflows/deploy.yml`: cada push a `main` ejecuta los
tipos y los tests, y si pasan, despliega en Cloudflare. También se puede lanzar a mano
desde la pestaña **Actions → Deploy a Cloudflare Workers → Run workflow**.

Configúralo una sola vez:

1. **Token de API.** En el panel de Cloudflare: *My Profile → API Tokens → Create Token*.
   Usa la plantilla **"Edit Cloudflare Workers"** y limita el permiso a tu cuenta.
2. **Account ID.** Está en *Workers & Pages → Overview*, en la barra lateral derecha.
3. En GitHub, entra en **Settings → Secrets and variables → Actions** y crea dos secretos:

   | Secreto | Valor |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | El token del paso 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | El ID del paso 2 |

A partir de ahí, `git push` publica los cambios.

> Si el despliegue falla con "Authentication error", revisa que el token tenga el
> permiso **Workers Scripts: Edit** y **Account Settings: Read**.

### Manual

```bash
npx wrangler login
npm run deploy
```

Para usar un dominio propio: añade la zona a Cloudflare y configura una ruta o un
dominio personalizado para el Worker (`mailcheck.tudominio.com`) desde el panel o con
`routes` en `wrangler.jsonc`.

---

## Proteger con Cloudflare Access

Esta herramienta **recibe credenciales SMTP reales**, así que no debe quedar abierta.
Además, con Access activo el Worker verifica el token por su cuenta, de modo que la URL
`*.workers.dev` (que **no** pasa por Access) también queda protegida.

1. En el panel de Cloudflare, entra en **Zero Trust → Access → Applications**.
2. **Add an application → Self-hosted**.
3. Configura:
   - **Application domain:** `mailcheck.tudominio.com`
   - **Session duration:** lo que prefieras (por ejemplo 24 h)
4. Añade una **policy**: `Allow` → `Emails` → tu correo (o el dominio de tu equipo).
5. Guarda y copia el **Application Audience (AUD) Tag** de la sección *Overview*.
6. Rellena `vars` en `wrangler.jsonc`:

```jsonc
{
  "name": "mailcheck",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-19",
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "observability": { "enabled": true },
  "vars": {
    "TEAM_DOMAIN": "tu-equipo.cloudflareaccess.com",
    "POLICY_AUD": "el-aud-tag-que-has-copiado"
  }
}
```

7. Vuelve a desplegar:

```bash
npm run deploy
```

Cómo se comporta:

- **Sin `TEAM_DOMAIN` ni `POLICY_AUD`:** la app queda abierta. Válido para desarrollo,
  peligroso en producción.
- **Con las dos variables:** toda llamada a `/api/*` debe traer un token de Access
  válido (firma RS256, `aud` y `exp` comprobados contra el JWKS del equipo). Si no,
  responde `401`. La interfaz muestra el correo del usuario conectado en la cabecera.

Las credenciales SMTP nunca se guardan: se usan para la comprobación en curso y se
descartan. Las contraseñas se enmascaran en el registro (`AUTH LOGIN ********`).

---

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| `No se pudo conectar ... proxy request failed` | El host no es alcanzable desde Internet, o apunta a una IP privada / de Cloudflare. |
| `Cloudflare Workers no permite conexiones salientes al puerto 25` | Límite de la plataforma. Usa 587, 465 o 2525. |
| `Fallo al negociar TLS` con certificado | Certificado autofirmado o caducado: Cloudflare no permite aceptarlo. |
| `Sin saludo del servidor` en el 465 | Estás usando STARTTLS en el puerto del SSL implícito (o al revés). Cambia el modo. |
| `Autenticación rechazada (535)` | Credenciales incorrectas, o el proveedor exige una "contraseña de aplicación". |
| `401 No autorizado` en la web | La sesión de Cloudflare Access ha caducado: recarga e inicia sesión de nuevo. |
| El 465 falla solo en local | Un firewall corporativo intercepta TLS. En Cloudflare funciona. |

---

## Estructura del proyecto

| Archivo | Descripción |
|---|---|
| `MailCheck.exe` | Aplicación original de Windows (se conserva como referencia). |
| `wrangler.jsonc` | Configuración del Worker y de los assets. |
| `public/*` | Interfaz web. |
| `src/*` | Worker y biblioteca SMTP. |
| `test/*` | Tests ejecutables con Node. |
