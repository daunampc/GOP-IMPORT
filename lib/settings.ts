import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { settings as settingsTable } from "@/db/schema";

import { decrypt, encrypt } from "./crypto";
import { isKnownCurrency } from "./format";
import { IMAGE_MODES, IMPORT_MODES } from "./import-options";
import { MAX_BATCH_SIZE } from "./gop-client";
import { blockedReason } from "./outbound-url";

/**
 * Per-account configuration, edited on the Settings screen.
 *
 * Lives in Postgres rather than the environment because it belongs to whoever
 * operates the tool and must be changeable without shell access. Things that
 * genuinely belong to the machine — DATABASE_URL, REDIS_URL,
 * STORE_ENCRYPTION_KEY — stay in `.env`, and Settings shows them read-only for
 * diagnosis.
 *
 * ONE ROW PER ACCOUNT. This was a single row at `id = 1` until now, which meant
 * every account in the installation shared one Amazon S3 bucket and one set of
 * AWS keys. Every function here therefore DEMANDS an owner: a signature that
 * accepts it optionally turns a missed call site into a silent leak of one
 * customer's credentials to another, where demanding it turns the same mistake
 * into a compile error.
 */

export const appSettingsSchema = z.object({
  /** Batches sent in parallel by default. */
  defaultThreads: z.coerce.number().int().min(1).max(32).default(10),

  /**
   * Products per request by default. The plugin refuses anything larger than
   * MAX_BATCH_SIZE, so this ceiling is real and not a suggestion.
   */
  defaultBatchSize: z.coerce.number().int().min(1).max(MAX_BATCH_SIZE).default(MAX_BATCH_SIZE),

  defaultMode: z.enum(IMPORT_MODES).default("standard"),
  defaultImageMode: z.enum(IMAGE_MODES).default("keep_remote"),
  historyLimit: z.coerce.number().int().min(20).max(500).default(100),

  /**
   * Currency shown beside prices. DISPLAY ONLY — see `formatMoney`.
   *
   * Validated against the offered list rather than accepted as free text, so a
   * typo cannot end up as a symbol nobody recognises on every screen. Empty is
   * valid and is the default: raw numbers, exactly as before.
   */
  displayCurrency: z
    .string()
    .trim()
    .default("")
    .refine(isKnownCurrency, "That is not a currency this app knows how to display."),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * Amazon S3 upload target.
 *
 * The secret access key is encrypted with the same envelope as site API
 * secrets and is never sent to the browser — the UI only ever learns whether
 * one is set.
 */
export const s3SettingsSchema = z.object({
  enabled: z.boolean().default(false),
  accessKeyId: z.string().trim().default(""),
  /** Write-only. Empty on save means "keep the stored key". */
  secretAccessKey: z.string().trim().default(""),
  bucket: z.string().trim().default(""),
  region: z.string().trim().default(""),
  /**
   * Public base URL that replaces the S3 endpoint in image links — a CDN or
   * custom domain in front of the bucket.
   */
  publicUrl: z.string().trim().default(""),
  /** Optional key prefix inside the bucket, e.g. `products/2026`. */
  prefix: z.string().trim().default(""),
});

export type S3Input = z.infer<typeof s3SettingsSchema>;

/** Browser-safe view: says whether a secret exists, never what it is. */
export interface S3Public {
  enabled: boolean;
  accessKeyId: string;
  secretConfigured: boolean;
  bucket: string;
  region: string;
  publicUrl: string;
  prefix: string;
}

/** Server-side view, with the secret decrypted. Never serialise this. */
export interface S3Credentials {
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  publicUrl: string;
  prefix: string;
}

/**
 * Where to say "the run has finished" — §6 C3.
 *
 * A 14,000-product run takes hours, and until now the only way to know it had
 * ended was to keep the screen open. This is a webhook rather than an email
 * because it needs no mail server and no credentials this app does not already
 * have, and because the signing scheme it uses is the one already in the codebase
 * — `verifySignature` in `lib/gop-client.ts` verifies exactly this shape.
 *
 * Empty URL means off. A separate on/off switch could disagree with the field
 * beside it, and then somebody leaves it on with an empty URL and wonders why
 * nothing arrives.
 */
export const webhookSettingsSchema = z.object({
  url: z.string().trim().default(""),
  /** Write-only. Empty on save means "keep the stored secret". */
  secret: z.string().trim().default(""),
  /**
   * Only send when something went wrong: a run that failed, was stopped, or
   * finished with failed rows.
   *
   * Off by default, and that is the answer to the question this feature exists
   * for. Silence cannot distinguish "it finished, all good" from "the worker died
   * and nobody was told" — which is the thing somebody is sitting watching the
   * screen for.
   */
  failuresOnly: z.boolean().default(false),
});

export type WebhookInput = z.infer<typeof webhookSettingsSchema>;

/** Browser-safe view: says whether a secret exists, never what it is. */
export interface WebhookPublic {
  url: string;
  secretConfigured: boolean;
  failuresOnly: boolean;
}

/** Server-side view, with the secret decrypted. Never serialise this. */
export interface WebhookTarget {
  url: string;
  /** Empty when the account set no secret — then no signature header is sent. */
  secret: string;
  failuresOnly: boolean;
}

/**
 * Telegram — the same events as the webhook, delivered to a person.
 *
 * Two fields, both required together: a bot token and a chat id. The token is a
 * credential (anyone holding it can post as that bot) so it is encrypted at rest and
 * write-only, exactly like the S3 key and the webhook secret. The chat id is not a
 * secret and is shown back, because finding it is the fiddly part of setting this up
 * and hiding it would make a working configuration unverifiable.
 *
 * Empty token or empty chat id means off. No third switch to disagree with them.
 */
export const telegramSettingsSchema = z.object({
  /** Write-only. Empty on save means "keep the stored token". */
  token: z.string().trim().default(""),
  chatId: z.string().trim().default(""),
});

export type TelegramInput = z.infer<typeof telegramSettingsSchema>;

/** Browser-safe view: says whether a token exists, never what it is. */
export interface TelegramPublic {
  tokenConfigured: boolean;
  chatId: string;
}

/** Server-side view, with the token decrypted. Never serialise this. */
export interface TelegramTarget {
  token: string;
  chatId: string;
}

export const DEFAULT_SETTINGS: AppSettings = appSettingsSchema.parse({});

/**
 * One account's row, created on first read.
 *
 * There is no seed step any more — a settings row cannot exist before the
 * account it belongs to does, so it is made the first time that account looks
 * at its own settings.
 */
async function row(ownerId: string) {
  const [found] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.ownerId, ownerId))
    .limit(1);

  if (found) {
    return found;
  }

  const [created] = await db
    .insert(settingsTable)
    .values({ ownerId })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  // Two requests for a brand-new account raced and the other one won. Its row
  // is now there; read it rather than failing the screen.
  const [again] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.ownerId, ownerId))
    .limit(1);

  return again;
}

export async function getSettings(ownerId: string): Promise<AppSettings> {
  const current = await row(ownerId);

  // safeParse rather than parse: a row written by an older build may be missing
  // a field, and that must not take the Settings screen down.
  const parsed = appSettingsSchema.safeParse({
    defaultThreads: current.defaultThreads,
    defaultBatchSize: current.defaultBatchSize,
    defaultMode: current.defaultMode,
    defaultImageMode: current.defaultImageMode,
    historyLimit: current.historyLimit,
    displayCurrency: current.displayCurrency,
  });

  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(ownerId: string, input: unknown): Promise<AppSettings> {
  const parsed = appSettingsSchema.parse(input);

  // Upsert rather than update: an account can reach Save without ever having
  // read the screen, and a silent no-op update is worse than a row appearing.
  await db
    .insert(settingsTable)
    .values({ ownerId, ...parsed })
    .onConflictDoUpdate({
      target: settingsTable.ownerId,
      set: { ...parsed, updatedAt: new Date() },
    });

  return parsed;
}

export async function getS3Public(ownerId: string): Promise<S3Public> {
  const current = await row(ownerId);

  return {
    enabled: current.s3Enabled,
    accessKeyId: current.s3AccessKeyId,
    secretConfigured: current.s3SecretEncrypted !== "",
    bucket: current.s3Bucket,
    region: current.s3Region,
    publicUrl: current.s3PublicUrl,
    prefix: current.s3Prefix,
  };
}

/**
 * Server-side credentials, or null when S3 is off or incompletely configured.
 *
 * Returning null for "half configured" is deliberate: a bucket with no region
 * would fail at upload time, deep inside a run, instead of at the moment
 * someone chose the S3 image mode.
 */
export async function getS3Credentials(ownerId: string): Promise<S3Credentials | null> {
  const current = await row(ownerId);

  if (!current.s3Enabled) {
    return null;
  }

  if (
    current.s3AccessKeyId === "" ||
    current.s3SecretEncrypted === "" ||
    current.s3Bucket === "" ||
    current.s3Region === ""
  ) {
    return null;
  }

  return {
    enabled: true,
    accessKeyId: current.s3AccessKeyId,
    secretAccessKey: decrypt(current.s3SecretEncrypted),
    bucket: current.s3Bucket,
    region: current.s3Region,
    publicUrl: current.s3PublicUrl,
    prefix: current.s3Prefix,
  };
}

export async function saveS3(ownerId: string, input: unknown): Promise<S3Public> {
  const parsed = s3SettingsSchema.parse(input);
  const current = await row(ownerId);

  // An empty secret means "leave the stored one alone" — the UI can never show
  // the existing value, so it cannot send it back either.
  const secretEncrypted =
    parsed.secretAccessKey === ""
      ? current.s3SecretEncrypted
      : encrypt(parsed.secretAccessKey);

  // Refuse a half-filled configuration rather than accepting it and failing
  // later, deep inside a run, on the first image of the first batch.
  if (parsed.enabled) {
    const missing = [
      parsed.accessKeyId === "" ? "access key ID" : null,
      secretEncrypted === "" ? "secret access key" : null,
      parsed.bucket === "" ? "bucket" : null,
      parsed.region === "" ? "region" : null,
    ].filter((field): field is string => field !== null);

    if (missing.length > 0) {
      throw new Error(`S3 is enabled but missing: ${missing.join(", ")}.`);
    }
  }

  await db
    .update(settingsTable)
    .set({
      s3Enabled: parsed.enabled,
      s3AccessKeyId: parsed.accessKeyId,
      s3SecretEncrypted: secretEncrypted,
      s3Bucket: parsed.bucket,
      s3Region: parsed.region,
      s3PublicUrl: parsed.publicUrl.replace(/\/$/, ""),
      s3Prefix: parsed.prefix.replace(/^\/+|\/+$/g, ""),
      updatedAt: new Date(),
    })
    .where(eq(settingsTable.ownerId, ownerId));

  return getS3Public(ownerId);
}

export async function getWebhookPublic(ownerId: string): Promise<WebhookPublic> {
  const current = await row(ownerId);

  return {
    url: current.notifyWebhookUrl,
    secretConfigured: current.notifyWebhookSecretEncrypted !== "",
    failuresOnly: current.notifyFailuresOnly,
  };
}

/**
 * Where to POST, or null when this account has not asked to be told.
 *
 * Read by the WORKER, which has no session: it is told which account owns the run
 * and resolves that account's target — the member's webhook even when an
 * administrator started the run on their behalf, exactly as the S3 bucket works.
 */
export async function getWebhookTarget(ownerId: string): Promise<WebhookTarget | null> {
  const current = await row(ownerId);

  if (current.notifyWebhookUrl === "") {
    return null;
  }

  return {
    url: current.notifyWebhookUrl,
    secret:
      current.notifyWebhookSecretEncrypted === ""
        ? ""
        : decrypt(current.notifyWebhookSecretEncrypted),
    failuresOnly: current.notifyFailuresOnly,
  };
}

export async function saveWebhook(ownerId: string, input: unknown): Promise<WebhookPublic> {
  const parsed = webhookSettingsSchema.parse(input);
  const current = await row(ownerId);

  const url = parsed.url.trim();

  /*
   * Refused HERE as well as at send time, so the answer arrives while somebody is
   * looking at the field they typed it into.
   *
   * This is a URL an account typed, and an account is a CUSTOMER rather than the
   * operator of the machine — so "make the server POST to this" is checked against
   * the same rule the image links are. It means a receiver on a private address is
   * refused, including in a self-hosted install where that would have been
   * convenient; the way through is a public hostname or a tunnel. Conservative on
   * purpose: the alternative is one customer being able to aim this installation at
   * whatever is reachable from inside its network.
   */
  if (url !== "") {
    const blocked = blockedReason(url);

    if (blocked !== null) {
      throw new Error(`That webhook URL cannot be used. ${blocked}`);
    }
  }

  // An empty secret means "leave the stored one alone" — the UI can never show the
  // existing value, so it cannot send it back either.
  const secretEncrypted =
    parsed.secret === "" ? current.notifyWebhookSecretEncrypted : encrypt(parsed.secret);

  await db
    .update(settingsTable)
    .set({
      notifyWebhookUrl: url,
      // Clearing the URL clears the secret with it. Leaving a secret behind for a
      // URL that no longer exists is a credential kept for no reason.
      notifyWebhookSecretEncrypted: url === "" ? "" : secretEncrypted,
      notifyFailuresOnly: parsed.failuresOnly,
      updatedAt: new Date(),
    })
    .where(eq(settingsTable.ownerId, ownerId));

  return getWebhookPublic(ownerId);
}

export async function getTelegramPublic(ownerId: string): Promise<TelegramPublic> {
  const current = await row(ownerId);

  return {
    tokenConfigured: current.notifyTelegramTokenEncrypted !== "",
    chatId: current.notifyTelegramChatId,
  };
}

/**
 * Where to send, or null when this account has not asked to be told on Telegram.
 *
 * Null for a HALF-configured pair as well, for the same reason `getS3Credentials`
 * refuses a bucket with no region: a token with nowhere to send it would fail at
 * delivery time, inside a run, rather than at the moment somebody filled the form in
 * — and this one would fail silently, because a notification that does not arrive
 * looks exactly like a run that has not finished.
 */
export async function getTelegramTarget(ownerId: string): Promise<TelegramTarget | null> {
  const current = await row(ownerId);

  if (current.notifyTelegramTokenEncrypted === "" || current.notifyTelegramChatId === "") {
    return null;
  }

  return {
    token: decrypt(current.notifyTelegramTokenEncrypted),
    chatId: current.notifyTelegramChatId,
  };
}

export async function saveTelegram(ownerId: string, input: unknown): Promise<TelegramPublic> {
  const parsed = telegramSettingsSchema.parse(input);
  const current = await row(ownerId);

  const chatId = parsed.chatId.trim();

  // An empty token means "leave the stored one alone" — the UI can never show it, so
  // it cannot send it back either.
  const tokenEncrypted =
    parsed.token === "" ? current.notifyTelegramTokenEncrypted : encrypt(parsed.token);

  // Refuse a half-filled pair rather than storing something that can only fail later,
  // silently. Clearing BOTH is how it is switched off.
  if (chatId !== "" && tokenEncrypted === "") {
    throw new Error("Telegram needs a bot token as well as a chat id.");
  }

  await db
    .update(settingsTable)
    .set({
      // Clearing the chat id clears the token with it: a credential kept for a
      // destination that no longer exists is a credential kept for no reason.
      notifyTelegramTokenEncrypted: chatId === "" ? "" : tokenEncrypted,
      notifyTelegramChatId: chatId,
      updatedAt: new Date(),
    })
    .where(eq(settingsTable.ownerId, ownerId));

  return getTelegramPublic(ownerId);
}

/**
 * The stored AWS secret access key, in plain text.
 *
 * The ONLY way a stored S3 secret leaves the database. Guarded at the route by
 * `apiRequireAdmin()` and recorded in `secret_reveal` by the same route — see
 * `app/api/admin/reveal/s3/route.ts`. Nothing else in the app may call this,
 * and nothing may log what it returns: use `mask()` from `lib/crypto.ts`
 * wherever a secret has to be referred to.
 *
 * Null when the account has no secret stored, which is different from an empty
 * one and is worth saying so.
 */
export async function revealS3Secret(ownerId: string): Promise<string | null> {
  const current = await row(ownerId);

  if (current.s3SecretEncrypted === "") {
    return null;
  }

  return decrypt(current.s3SecretEncrypted);
}

/**
 * One account's whole configuration, read by an administrator.
 *
 * Named apart from `getSettings`/`getS3Public` on purpose. Every cross-account
 * read in this codebase goes through a function whose name says it is one —
 * never through a flag on the ordinary path, because a flag that widens a query
 * is one typo away from putting a customer's bucket on another customer's
 * screen, and a reviewer cannot see a boolean at the call site.
 */
export async function settingsFor(
  userId: string,
): Promise<{ settings: AppSettings; s3: S3Public }> {
  const [appSettings, s3] = await Promise.all([getSettings(userId), getS3Public(userId)]);
  return { settings: appSettings, s3 };
}
