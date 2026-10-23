import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync } from "node:crypto";

/**
 * Sealing a machine's character keys for another machine. The code is made here and only ever shown to the
 * maintainer; the realm gets the code's hash (to find the bundle) and the sealed bundle, never the code or keys.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode(): string {
  const c = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}
const norm = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const codeHash = (code: string) => createHash("sha256").update(`dragons-door-share:${norm(code)}`).digest("hex");
const keyOf = (code: string) => scryptSync(norm(code), "dragons-door-share-key", 32);

export function seal(code: string, data: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(code), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function unseal<T>(code: string, sealed: string): T {
  const b = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", keyOf(code), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
}
