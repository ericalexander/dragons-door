/**
 * Per-request details the game logic needs but the route handlers don't pass down:
 * who's calling (plugin version, app, OS) and roughly where (Vercel's IP geolocation headers).
 * Set by middleware, read with current().
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** Known only inside this process: the bot runner passes it on its in-process calls. Can't be sent from outside. */
export const INTERNAL_TOKEN = randomBytes(24).toString("hex");

export interface RequestInfo {
  plugin?: string;        // plugin version, e.g. "0.2.8"
  app?: string;           // e.g. "claude-code 2.1.300"
  os?: string;            // e.g. "darwin"
  townsfolk: boolean;     // the bot runner, calling in-process (proved by INTERNAL_TOKEN)
  lat?: number;
  lon?: number;
  tz?: string;
  /** The caller's address as Vercel reports it. Used only to count sign-ups, hashed, never stored. */
  addr?: string;
}

const store = new AsyncLocalStorage<RequestInfo>();
export const current = () => store.getStore();
export const runWith = <T>(info: RequestInfo, fn: () => Promise<T>) => store.run(info, fn);

const clip = (v: string | undefined, n = 60) => (v ? v.slice(0, n).replace(/[^\x20-\x7e]/g, "") : undefined);

export function fromHeaders(h: (name: string) => string | undefined): RequestInfo {
  const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    plugin: clip(h("x-dragons-door-version"), 20),
    app: clip(h("x-dragons-door-app")),
    os: clip(h("x-dragons-door-os"), 20),
    townsfolk: h("x-dragons-door-internal") === INTERNAL_TOKEN,
    lat: num(h("x-vercel-ip-latitude")),
    lon: num(h("x-vercel-ip-longitude")),
    tz: clip(h("x-vercel-ip-timezone"), 40),
    addr: clip((h("x-vercel-forwarded-for") ?? h("x-real-ip") ?? h("x-forwarded-for") ?? "").split(",")[0].trim(), 64) || undefined,
  };
}

const parts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
export function older(a: string, b: string) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}
