"use client";

import { useState } from "react";

import { ThemeSwitch } from "@/components/shell/theme";
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  DescriptionList,
  Field,
  Input,
  Panel,
  Select,
  Stat,
  Switch,
  useToast,
} from "@/components/ui";
import { CURRENCIES, CURRENCY_DISCLAIMER, formatDuration } from "@/lib/format";
import {
  IMAGE_MODES,
  IMAGE_MODE_LABELS,
  IMPORT_MODES,
  IMPORT_MODE_LABELS,
} from "@/lib/import-options";
import type { AppSettings, S3Public, TelegramPublic, WebhookPublic } from "@/lib/settings";
import type { RedisHealth } from "@/lib/redis";

/**
 * Settings.
 *
 * Split in two, because the two halves change in completely different ways:
 *
 *  - The EDITABLE half lives in Postgres: theme, import defaults, S3 target.
 *  - The READ-ONLY half lives in the server's `.env`: REDIS_URL,
 *    WORKER_CONCURRENCY, STORE_ENCRYPTION_KEY. The web process cannot write to
 *    `.env`, so an input for those would be a button that does nothing. They
 *    are shown for diagnosis, named exactly as the variable to edit.
 */
export function SettingsView({
  initial,
  s3: initialS3,
  webhook: initialWebhook,
  telegram: initialTelegram,
  canReveal,
  revealTarget,
  environment,
}: {
  initial: AppSettings;
  s3: S3Public;
  /** Where this account is told a run has finished. Empty URL means off. */
  webhook: WebhookPublic;
  /** The same events, on Telegram. Empty chat id means off. */
  telegram: TelegramPublic;
  /** Administrators only: read a stored secret back. Recorded when used. */
  canReveal: boolean;
  /** The account whose settings are on screen, named on the reveal record. */
  revealTarget: { id: string; email: string };
  environment: {
    workerConcurrency: string;
    encryptionKeyConfigured: boolean;
    expectedPluginVersion: string | null;
    nodeVersion: string;
  };
}) {
  const toast = useToast();

  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [redis, setRedis] = useState<RedisHealth | null>(null);
  const [checkingRedis, setCheckingRedis] = useState(false);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = (await response.json()) as { settings?: AppSettings; error?: string };

      if (!response.ok || !payload.settings) {
        toast.error("Could not save settings", payload.error);
        return;
      }

      setSettings(payload.settings);
      setDirty(false);
      toast.success("Settings saved", "Applies to import runs created from now on.");
    } finally {
      setSaving(false);
    }
  }

  async function checkRedis() {
    setCheckingRedis(true);
    try {
      const response = await fetch("/api/health/redis", { cache: "no-store" });
      const payload = (await response.json()) as { redis: RedisHealth };
      setRedis(payload.redis);

      if (payload.redis.ok) {
        toast.success("Redis is healthy", payload.redis.message);
      } else {
        toast.error("Could not reach Redis", payload.redis.message);
      }
    } catch (caught) {
      toast.error(
        "The health check itself failed",
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setCheckingRedis(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------ Appearance */}
      <Panel title="Appearance" icon="sun">
        <Field
          label="Light or dark"
          hint="Remembered in this browser. “System” follows the operating system."
        >
          <ThemeSwitch />
        </Field>
      </Panel>

      {/* ------------------------------------------------------- Import defaults */}
      <Panel
        title="Defaults for new import runs"
        icon="upload"
        description="Leaves existing runs alone"
        actions={
          <Button
            variant="primary"
            size="sm"
            icon="save"
            loading={saving}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {dirty ? "Save changes" : "Saved"}
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field
            label="Parallel batches"
            htmlFor="defaultThreads"
            hint="How many batches fly at once inside one run."
          >
            <Input
              id="defaultThreads"
              type="number"
              min={1}
              max={32}
              value={settings.defaultThreads}
              onChange={(event) => set("defaultThreads", Number(event.target.value))}
              className="tnum"
            />
          </Field>

          <Field
            label="Products per batch"
            htmlFor="defaultBatchSize"
            hint="The plugin rejects batches over 50 — a hard ceiling."
          >
            <Input
              id="defaultBatchSize"
              type="number"
              min={1}
              max={50}
              value={settings.defaultBatchSize}
              onChange={(event) => set("defaultBatchSize", Number(event.target.value))}
              className="tnum"
            />
          </Field>

          <Field label="Import mode" htmlFor="defaultMode">
            <Select
              id="defaultMode"
              value={settings.defaultMode}
              onChange={(event) =>
                set("defaultMode", event.target.value as AppSettings["defaultMode"])
              }
            >
              {IMPORT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {IMPORT_MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Image handling" htmlFor="defaultImageMode">
            <Select
              id="defaultImageMode"
              value={settings.defaultImageMode}
              onChange={(event) =>
                set("defaultImageMode", event.target.value as AppSettings["defaultImageMode"])
              }
            >
              {IMAGE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {IMAGE_MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            The currency is a DISPLAY setting and the help text has to say so
            plainly, because the obvious reading of "choose the currency" is that
            it changes the shop — and it does not, and could not: the plugin
            writes prices as plain numbers and each WooCommerce site renders them
            with its own `woocommerce_currency`. Stock WooCommerce has no
            per-product currency at all.
          */}
          <Field
            label="Currency shown beside prices"
            htmlFor="displayCurrency"
            hint={CURRENCY_DISCLAIMER}
          >
            <Select
              id="displayCurrency"
              value={settings.displayCurrency}
              onChange={(event) => set("displayCurrency", event.target.value)}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Alert tone="info" title="The currency here never reaches a site" className="mt-4">
          <p>
            It changes the preview, the review table and the results, so you can see what you are
            publishing. Prices are sent as plain numbers and each site displays them in whatever
            currency <strong>it</strong> is configured for, under WooCommerce → Settings → General.
          </p>
          <p className="mt-1">
            A price of <Code>199000</Code> shows here as <Code>₫199,000</Code> under VND and{" "}
            <Code>US$199,000.00</Code> under USD — from the identical payload, and note that the
            decimals differ because the currency does, not because the number did. Nothing chosen
            here converts anything: the number published is the number in your file.
          </p>
        </Alert>
      </Panel>

      <S3Panel initial={initialS3} canReveal={canReveal} target={revealTarget} />

      <WebhookPanel initial={initialWebhook} />

      <TelegramPanel initial={initialTelegram} />

      {/* ---------------------------------------------------------------- Redis */}
      <Panel
        title="Redis"
        icon="database"
        description="Holds the run queue and the Stop broadcast — nothing else"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            loading={checkingRedis}
            onClick={() => void checkRedis()}
          >
            Check connection
          </Button>
        }
      >
        <div className="space-y-4">
          {redis === null ? (
            <Alert tone="info" title="Not checked in this session">
              The only visible symptom of a missing Redis is that everything stops moving — runs
              never advance, new runs never start. Press “Check connection” to know for certain.
            </Alert>
          ) : (
            <>
              {redis.ok ? null : (
                <Alert tone="bad" title="Could not reach Redis">
                  <p>{redis.message}</p>
                  <p className="mt-1">
                    Check <Code>REDIS_URL</Code> in <Code>.env</Code> and whether the Redis process
                    is still running.
                  </p>
                </Alert>
              )}

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat
                  label="Status"
                  value={redis.ok ? "Healthy" : "Down"}
                  tone={redis.ok ? "ok" : "bad"}
                  icon={redis.ok ? "check-circle" : "alert-circle"}
                />
                <Stat label="Latency" value={formatDuration(redis.latencyMs)} icon="clock" />
                <Stat
                  label="Version"
                  value={redis.version ?? "—"}
                  icon="database"
                  hint={redis.version === null ? "the INFO command is blocked" : undefined}
                />
                <Stat
                  label="Memory in use"
                  value={redis.usedMemory ?? "—"}
                  icon="layers"
                  hint="Only the queue and cancel flags live here"
                />
              </div>
            </>
          )}
        </div>
      </Panel>

      {/* ---------------------------------------------------------- Environment */}
      <Panel
        title="Server environment"
        icon="settings"
        description="Read-only — edit .env and restart the processes"
      >
        <div className="space-y-4">
          {!environment.encryptionKeyConfigured ? (
            <Alert tone="bad" title="STORE_ENCRYPTION_KEY is not set">
              Without it, site API secrets and the S3 secret key cannot be encrypted before they
              reach the database. Generate one with <Code>openssl rand -hex 32</Code> and put it in{" "}
              <Code>.env</Code>.
            </Alert>
          ) : null}

          <DescriptionList
            columns={2}
            items={[
              {
                term: "WORKER_CONCURRENCY",
                value: environment.workerConcurrency,
                hint: "How many runs the worker processes at once. Read at worker startup.",
              },
              {
                term: "STORE_ENCRYPTION_KEY",
                value: environment.encryptionKeyConfigured ? (
                  <Badge tone="ok" icon="shield-check">
                    Configured
                  </Badge>
                ) : (
                  <Badge tone="bad" icon="alert-circle">
                    Not set
                  </Badge>
                ),
              },
              {
                term: "Expected plugin version",
                value: environment.expectedPluginVersion ?? "version.txt could not be read",
                hint: "Used to warn when a site is running an older build.",
              },
              { term: "Node.js", value: environment.nodeVersion },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}

/* ========================================================================== */

/**
 * Telegram, for the same notifications.
 *
 * A "Send a test message" button rather than a hope: getting a chat id is the fiddly
 * half of setting this up, and a wrong one fails silently for ever — a notification
 * that never arrives looks exactly like a night when nothing ran. Telegram's own
 * refusal is shown, because a 401 and "chat not found" are the two mistakes people
 * make and they have different fixes.
 */
function TelegramPanel({ initial }: { initial: TelegramPublic }) {
  const toast = useToast();

  const [telegram, setTelegram] = useState(initial);
  const [token, setToken] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, chatId: telegram.chatId }),
      });

      const payload = (await response.json()) as { telegram?: TelegramPublic; error?: string };

      if (!response.ok || !payload.telegram) {
        toast.error("Could not save Telegram", payload.error);
        return;
      }

      setTelegram(payload.telegram);
      setToken("");
      setDirty(false);
      toast.success(
        payload.telegram.chatId === "" ? "Telegram switched off" : "Telegram saved",
        payload.telegram.chatId === ""
          ? "Nothing will be sent to Telegram."
          : "Send a test message to check it arrives.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const response = await fetch("/api/settings/telegram/test", { method: "POST" });
      const payload = (await response.json()) as { ok?: boolean; message?: string };

      if (response.ok && payload.ok) {
        toast.success("Test message sent", payload.message);
        return;
      }

      toast.error("Telegram did not accept it", payload.message);
    } finally {
      setTesting(false);
    }
  }

  const configured = telegram.chatId !== "" && (telegram.tokenConfigured || token !== "");

  return (
    <Panel
      title="Telegram"
      icon="zap"
      description="The same run notifications, on your phone"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon="zap"
            loading={testing}
            disabled={!telegram.tokenConfigured || telegram.chatId === "" || dirty}
            onClick={() => void test()}
          >
            Send a test
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="save"
            loading={saving}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field
          label="Bot token"
          htmlFor="telegramToken"
          hint={
            telegram.tokenConfigured
              ? "A token is stored. Leave this empty to keep it; type a new one to replace it. It is never shown again."
              : "From @BotFather in Telegram: send /newbot, then copy the token it gives you."
          }
        >
          <Input
            id="telegramToken"
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setDirty(true);
            }}
            placeholder={telegram.tokenConfigured ? "•••••••• (stored)" : "123456789:AA…"}
          />
        </Field>

        <Field
          label="Chat id"
          htmlFor="telegramChatId"
          hint="Your own id, a group's, or a channel like @my_channel. Send the bot a message first — it cannot write to a chat that has never spoken to it. Clearing this switches Telegram off."
        >
          <Input
            id="telegramChatId"
            value={telegram.chatId}
            onChange={(event) => {
              setTelegram((current) => ({ ...current, chatId: event.target.value }));
              setDirty(true);
            }}
            placeholder="123456789"
          />
        </Field>

        <Alert tone={configured ? "info" : "neutral"} title="What arrives, and when">
          <p>
            One message per finished run: the site, the counts, and the file it came from.
            It follows the same <Code>Only when something went wrong</Code> switch as the
            webhook above — one answer to when you are told, two answers to where.
          </p>
        </Alert>
      </div>
    </Panel>
  );
}

/**
 * Where this account is told a run has finished — §6 C3.
 *
 * A webhook rather than an email: it needs no mail server and no credentials this
 * app does not already have, and it is signed with the scheme already in the
 * codebase, so whoever writes the receiving end verifies it with the same function
 * the plugin uses.
 *
 * The secret is write-only, exactly like the S3 one: the field is empty on load and
 * an empty field on save means "keep the stored one". Unlike the S3 secret there is
 * no reveal action at all — a value the account gave to its own receiver is one this
 * app has no reason to hand back.
 */
function WebhookPanel({ initial }: { initial: WebhookPublic }) {
  const toast = useToast();

  const [webhook, setWebhook] = useState(initial);
  const [secret, setSecret] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof WebhookPublic>(key: K, value: WebhookPublic[K]) {
    setWebhook((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings/webhook", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhook.url,
          secret,
          failuresOnly: webhook.failuresOnly,
        }),
      });

      const payload = (await response.json()) as { webhook?: WebhookPublic; error?: string };

      if (!response.ok || !payload.webhook) {
        // The message names why a URL was refused — a private address, a scheme
        // that is not http — and is worth showing whole.
        toast.error("Could not save the notification settings", payload.error);
        return;
      }

      setWebhook(payload.webhook);
      setSecret("");
      setDirty(false);
      toast.success(
        payload.webhook.url === "" ? "Notifications switched off" : "Notification webhook saved",
        payload.webhook.url === ""
          ? "Nothing will be sent when a run finishes."
          : payload.webhook.failuresOnly
            ? "It will be told only when a run fails, is stopped, or finishes with failed rows."
            : "It will be told when every run finishes.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="Tell me when a run finishes"
      icon="zap"
      description="A run of 14,000 products takes hours — this is how you find out it ended without watching the screen"
      actions={
        <Button
          variant="primary"
          size="sm"
          icon="save"
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {dirty ? "Save changes" : "Saved"}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field
          label="Webhook URL"
          htmlFor="notifyWebhookUrl"
          hint="One POST per finished run. Empty means notifications are off. A private or local address is refused — the receiver has to be reachable from this server by a public name."
        >
          <Input
            id="notifyWebhookUrl"
            value={webhook.url}
            onChange={(event) => set("url", event.target.value)}
            placeholder="https://hooks.example.com/gop-import"
          />
        </Field>

        <Field
          label="Signing secret"
          htmlFor="notifyWebhookSecret"
          hint={
            webhook.secretConfigured
              ? "A secret is stored. Leave this empty to keep it; type a new one to replace it. It is never shown again, to anybody."
              : "Optional. With one set, every delivery carries an X-TSD-Signature your receiver can verify — without one, anyone who learns the URL can post to it."
          }
        >
          <Input
            id="notifyWebhookSecret"
            type="password"
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
              setDirty(true);
            }}
            placeholder={webhook.secretConfigured ? "•••••••• (stored)" : "A secret you choose"}
          />
        </Field>

        <Field
          label="Only when something went wrong"
          hint="On, a run that finishes cleanly says nothing. Off — the default — every finished run is announced, because silence cannot tell “it finished” apart from “the worker died”."
        >
          <Switch
            checked={webhook.failuresOnly}
            onChange={(next) => set("failuresOnly", next)}
            label={webhook.failuresOnly ? "Failures only" : "Every run"}
          />
        </Field>

        <Alert tone="info" title="What arrives">
          <p>
            A JSON body with the run&rsquo;s id, kind, status and final counts, plus a{" "}
            <Code>text</Code> field holding the same thing in one sentence — so a Slack-shaped
            receiver works without anything in between. Signed over{" "}
            <Code>POST\n&lt;path&gt;\n&lt;timestamp&gt;\n&lt;body&gt;</Code>, the same scheme
            this app uses to talk to the plugin. It is sent once: if your receiver is down, the
            run&rsquo;s own page is still the record.
          </p>
        </Alert>
      </div>
    </Panel>
  );
}

/**
 * Amazon S3 target.
 *
 * The secret access key is write-only: the ordinary payload never carries it,
 * so this form starts empty and an empty box on save means "keep what is
 * stored". That is why the field says whether a secret exists rather than
 * showing dots that would look editable.
 *
 * Every account edits its OWN bucket here — that is the whole point of
 * per-account settings, and a member who cannot set their own AWS keys cannot
 * use the S3 image mode at all. This panel used to be administrators-only
 * because there was one bucket for the entire installation.
 *
 * What a member still cannot do is REVEAL a stored secret, their own included:
 * they overwrite it instead. So the only way a stored secret leaves the
 * database is one named administrator action, which is what makes the audit
 * trail worth having.
 */
function S3Panel({
  initial,
  canReveal,
  target,
}: {
  initial: S3Public;
  canReveal: boolean;
  target: { id: string; email: string };
}) {
  const toast = useToast();

  const [s3, setS3] = useState(initial);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Held in state and never in the URL, and cleared by the button that showed
  // it. A revealed secret lives exactly as long as somebody is looking at it.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  async function reveal() {
    setRevealing(true);
    try {
      // POST, not GET: a secret must never be in a query string, a browser
      // history entry or a proxy access log.
      const response = await fetch("/api/admin/reveal/s3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: target.id }),
      });

      const payload = (await response.json()) as {
        secretAccessKey?: string;
        error?: string;
      };

      if (!response.ok || typeof payload.secretAccessKey !== "string") {
        toast.error("Could not reveal the secret", payload.error);
        return;
      }

      setRevealed(payload.secretAccessKey);
      toast.info(
        "Secret revealed",
        `Recorded against ${target.email}. Every reveal is listed on the Administration screen.`,
      );
    } finally {
      setRevealing(false);
    }
  }

  function set<K extends keyof S3Public>(key: K, value: S3Public[K]) {
    setS3((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings/s3", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: s3.enabled,
          accessKeyId: s3.accessKeyId,
          secretAccessKey: secret,
          bucket: s3.bucket,
          region: s3.region,
          publicUrl: s3.publicUrl,
          prefix: s3.prefix,
        }),
      });

      const payload = (await response.json()) as { s3?: S3Public; error?: string };

      if (!response.ok || !payload.s3) {
        toast.error("Could not save the S3 settings", payload.error);
        return;
      }

      setS3(payload.s3);
      setSecret("");
      setDirty(false);
      toast.success(
        "S3 settings saved",
        payload.s3.enabled
          ? "The “Upload to Amazon S3” image mode is now available."
          : "S3 is stored but switched off.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title="Amazon S3"
      icon="image"
      description="Where images go when a run uses the S3 image mode"
      actions={
        <Button
          variant="primary"
          size="sm"
          icon="save"
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {dirty ? "Save changes" : "Saved"}
        </Button>
      }
    >
      <div className="space-y-4">

        <Field
          label="Use S3 for images"
          hint="Off means the “Upload to Amazon S3” image mode stays unavailable in the wizard."
        >
          <Switch
            checked={s3.enabled}
            onChange={(next) => set("enabled", next)}
            label={s3.enabled ? "Enabled" : "Disabled"}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Access key ID" htmlFor="s3AccessKeyId">
            <Input
              id="s3AccessKeyId"
              value={s3.accessKeyId}
              autoComplete="off"
              placeholder="AKIA…"
              onChange={(event) => set("accessKeyId", event.target.value)}
            />
          </Field>

          <Field
            label="Secret access key"
            htmlFor="s3Secret"
            hint={
              s3.secretConfigured
                ? "A secret is stored. Leave this empty to keep it, or type a new one to replace it."
                : "Not set yet."
            }
          >
            <Input
              id="s3Secret"
              type="password"
              value={secret}
              autoComplete="new-password"
              placeholder={s3.secretConfigured ? "•••••••••••••••• (stored)" : "Paste the secret"}
              onChange={(event) => {
                setSecret(event.target.value);
                setDirty(true);
              }}
            />

            {/* Reveal is an administrator's repair tool, not a way to read your
                own key back. A member replaces a secret they have lost; they do
                not retrieve it. That is what makes the audit trail mean
                something — a stored secret leaves the database by exactly one
                named action, and that action is recorded. */}
            {canReveal && s3.secretConfigured ? (
              <div className="mt-2 space-y-2">
                {revealed === null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="key"
                    loading={revealing}
                    onClick={() => void reveal()}
                  >
                    Reveal the stored secret
                  </Button>
                ) : (
                  <>
                    <Code>{revealed}</Code>
                    <div className="flex flex-wrap items-center gap-2">
                      <CopyButton value={revealed} label="Copy the secret" />
                      <Button variant="ghost" size="sm" onClick={() => setRevealed(null)}>
                        Hide it again
                      </Button>
                    </div>
                  </>
                )}

                <p className="text-2xs text-ink-subtle">
                  Revealing is recorded: your account, {target.email}, and the time.
                </p>
              </div>
            ) : null}
          </Field>

          <Field label="Bucket" htmlFor="s3Bucket">
            <Input
              id="s3Bucket"
              value={s3.bucket}
              placeholder="my-product-images"
              onChange={(event) => set("bucket", event.target.value)}
            />
          </Field>

          <Field label="Region" htmlFor="s3Region">
            <Input
              id="s3Region"
              value={s3.region}
              placeholder="ap-southeast-1"
              onChange={(event) => set("region", event.target.value)}
            />
          </Field>

          <Field
            label="Public URL"
            htmlFor="s3PublicUrl"
            hint="CDN or custom domain in front of the bucket. Empty uses the bucket's own S3 endpoint."
          >
            <Input
              id="s3PublicUrl"
              value={s3.publicUrl}
              placeholder="https://cdn.example.com"
              onChange={(event) => set("publicUrl", event.target.value)}
            />
          </Field>

          <Field
            label="Key prefix"
            htmlFor="s3Prefix"
            hint="Optional folder inside the bucket, e.g. products/2026."
          >
            <Input
              id="s3Prefix"
              value={s3.prefix}
              placeholder="products"
              onChange={(event) => set("prefix", event.target.value)}
            />
          </Field>
        </div>

        <Alert tone="info" title="Object keys are derived from the image URL">
          The same image is stored once no matter how many products reference it, and re-running a
          file uploads nothing the second time. Nothing in a key comes from the clock or a counter.
        </Alert>
      </div>
    </Panel>
  );
}
