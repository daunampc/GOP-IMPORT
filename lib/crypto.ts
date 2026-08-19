/*
 * Do NOT import "server-only" here.
 *
 * This module is in worker/index.ts's import graph — a plain Node process that
 * never goes through Next.js's bundler. The `server-only` package throws the
 * moment it is required outside a React Server Component, so adding it would
 * kill the worker at startup.
 *
 * The guard instead is that this module requires `node:crypto`, so importing it
 * from a Client Component fails the build with a clear message.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts each site's `api_secret` before it reaches the database.
 *
 * A site secret in plain text is equivalent to full write access to that site's
 * database, and database dumps travel further than anyone intends.
 *
 * AES-256-GCM both encrypts and authenticates, so tampered ciphertext throws on
 * decryption rather than quietly returning rubbish.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommends a 96-bit nonce
const KEY_LENGTH = 32;

function key(): Buffer {
  const raw = process.env.STORE_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      "STORE_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }

  const buffer = Buffer.from(raw, "hex");

  if (buffer.length !== KEY_LENGTH) {
    throw new Error(
      `STORE_ENCRYPTION_KEY must be 32 bytes of hex (64 characters); this one is ${buffer.length} bytes.`,
    );
  }

  return buffer;
}

/** Returns "iv:tag:ciphertext", all base64. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decrypt(payload: string): string {
  const parts = payload.split(":");

  if (parts.length !== 3) {
    throw new Error("The encrypted value is malformed.");
  }

  const [iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Masks a secret for display or logging. */
export function mask(secret: string): string {
  if (secret.length <= 8) {
    return "••••••••";
  }
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
