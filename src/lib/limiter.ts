/**
 * Cupos por IP y globales.
 *
 * El binding `ratelimits` de Cloudflare solo admite ventanas de 10 o 60 s y sus
 * contadores son locales a cada ubicacion, asi que no sirve para un cupo horario
 * exacto. Los cupos largos viven aqui: un Durable Object por IP que cuenta por
 * ventana de una hora sobre SQLite (backend disponible en el plan gratuito).
 *
 * Una instancia de esta clase atiende a una sola IP (o al contador global), de
 * modo que su tabla solo contiene los cubos de ese actor.
 */
import { DurableObject } from "cloudflare:workers";

export interface Bucket {
  bucket: string;
  max: number;
}

export interface BucketResult {
  bucket: string;
  ok: boolean;
  n: number;
  max: number;
}

export const HOUR_MS = 3_600_000;

/** Numero de hora desde la epoca; es el sufijo que llevan todos los cubos. */
export function hourSuffix(now = Date.now()): string {
  return String(Math.floor(now / HOUR_MS));
}

/** Nombre del cubo de una hora concreta: `api:29374`. */
export function hourBucket(prefix: string, now = Date.now()): string {
  return `${prefix}:${hourSuffix(now)}`;
}

export class RateLimiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (bucket TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    );
  }

  /**
   * Suma una unidad a cada cubo y devuelve como ha quedado cada uno.
   *
   * `keepHour` permite tirar los cubos de horas anteriores; se hace unicamente
   * cuando aparece un cubo nuevo, para no escribir en cada peticion.
   *
   * El borrado se hace por el sufijo de hora (`%:<hora>`) y no comparando
   * nombres: los cubos de una misma instancia pueden tener prefijos distintos
   * (`api:` y `send:`) y el prefijo de envio ordena despues del de la API, asi
   * que una comparacion lexicografica no los borraba nunca. Tampoco se puede
   * borrar "todo lo que no este en la lista de esta peticion": una comprobacion
   * sin envio borraria el cubo de envio de la misma hora y regalaria el cupo.
   */
  hit(buckets: Bucket[], keepHour?: string): BucketResult[] {
    const sql = this.ctx.storage.sql;
    const out: BucketResult[] = [];
    let nuevoCubo = false;

    for (const { bucket, max } of buckets) {
      sql.exec(
        "INSERT INTO hits (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1",
        bucket,
      );
      const n = Number(sql.exec<{ n: number }>("SELECT n FROM hits WHERE bucket = ?", bucket).one().n);
      if (n === 1) nuevoCubo = true;
      out.push({ bucket, ok: n <= max, n, max });
    }

    if (nuevoCubo && keepHour) {
      sql.exec("DELETE FROM hits WHERE bucket NOT LIKE '%:' || ?", keepHour);
    }

    return out;
  }
}
