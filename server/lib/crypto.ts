// Secret encryption (AES-256-GCM) and one-time token helpers.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

/** "v1:<iv>:<tag>:<ciphertext>", all base64. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, data] = payload.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognized secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** A random URL-safe token and the hash stored in its place. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}
