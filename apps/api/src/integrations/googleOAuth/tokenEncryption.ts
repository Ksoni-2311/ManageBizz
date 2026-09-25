import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GoogleProviderError } from "./googleProviderError.js";

function encryptionKey(): Buffer {
  const value = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ?? process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "";
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new GoogleProviderError("GOOGLE_TOKEN_CONFIGURATION_ERROR", "Set GOOGLE_TOKEN_ENCRYPTION_KEY to a 32-byte base64 or 64-character hex key.", 503);
  return key;
}

export function assertGoogleTokenEncryptionKey(): void { encryptionKey(); }
export function encryptGoogleRefreshToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}
export function decryptGoogleRefreshToken(value: string): string {
  try {
    const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part!, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
  } catch {
    throw new GoogleProviderError("GOOGLE_TOKEN_CONFIGURATION_ERROR", "Stored Google authorization credentials could not be decrypted.", 503);
  }
}
