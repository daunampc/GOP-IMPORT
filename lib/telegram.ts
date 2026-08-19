/*
 * Do NOT import "server-only" here — the worker sends these.
 */

import { logJob } from "./job-log";
import { getTelegramTarget } from "./settings";
import type { JobState } from "./jobs";

/**
 * Telling a PERSON a run has finished.
 *
 * The webhook reaches a system; this reaches whoever is not watching the screen at
 * 02:00. Same events, same "only when something went wrong" switch — one answer to
 * "when am I told", two answers to "where" — so nothing here decides what is worth
 * announcing. `lib/notify.ts` owns that, and calls this.
 *
 * The same three rules as the webhook, for the same reasons: it never throws, it never
 * delays a run, and it is sent ONCE. A notification whose content is already durable
 * on the run's own page is not worth holding a worker lane for.
 */

/** Deadline on the call. Short: nothing waits for this. */
export const TELEGRAM_TIMEOUT_MS = 5_000;

/**
 * Telegram's API base, overridable so the test suite can point at a fixture.
 *
 * The suites cannot call the real api.telegram.org — it needs a live bot and would
 * make the tests depend on somebody else's uptime — and a delivery asserted against a
 * fake nobody can inspect is not asserted at all. So the base URL is a seam, unset in
 * production.
 */
function apiBase(): string {
  const raw = (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").trim();
  return raw.replace(/\/$/, "");
}

/**
 * Telegram renders `*bold*` and `_italic_` in Markdown mode, so a product name
 * containing an asterisk or an underscore would either break the formatting or
 * silently italicise half the message. Sent as PLAIN text instead: the numbers are
 * what matters and a catalogue is full of those characters.
 */
function line(state: JobState): string {
  const what = `${state.kind} · ${state.storeLabel}`;

  if (state.status !== "completed") {
    return (
      `${state.status === "failed" ? "❌" : "⚠️"} ${what}\n` +
      `${state.status.toUpperCase()} after ${state.processed} of ${state.total}` +
      `${state.error === null ? "" : `\n${state.error}`}`
    );
  }

  const failed = state.failed > 0;

  return (
    `${failed ? "⚠️" : "✅"} ${what}\n` +
    `${state.succeeded} ok · ${state.failed} failed · ${state.deduplicated} already there ` +
    `(of ${state.total})\n${state.sourceLabel}`
  );
}

/**
 * Send it, log the outcome, swallow everything.
 *
 * `state` must be the state read AFTER the run finished, so the counts are final.
 */
export async function telegramRunFinished(state: JobState): Promise<void> {
  try {
    const target = await getTelegramTarget(state.createdBy);

    if (target === null) {
      return;
    }

    const response = await fetch(`${apiBase()}/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text: line(state),
        // A run's own page is where the detail is; the message is the nudge.
        disable_web_page_preview: true,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      /*
       * Telegram answers 400 with a description worth reading — "chat not found" is
       * what an unfinished setup looks like, and it is the difference between "we sent
       * nothing" and "we sent it and nobody was listening". Read at most 300
       * characters of it, and never echo the token: it is in the URL, not the body.
       */
      const detail = await response.text().then(
        (body) => body.replace(/\s+/g, " ").slice(0, 300),
        () => "",
      );

      await logJob(state.id, {
        level: "warn",
        stage: "notify",
        message:
          `Telegram refused the message (HTTP ${response.status})` +
          `${detail === "" ? "" : `: ${detail}`}. It was not sent again.`,
        detail: { status: response.status },
      });
      return;
    }

    await logJob(state.id, {
      stage: "notify",
      // Never the token, and never the chat id: one is a credential and the other
      // identifies a person's account.
      message: "Told Telegram this run had finished.",
      detail: { status: response.status },
    });
  } catch (error) {
    await logJob(state.id, {
      level: "warn",
      stage: "notify",
      message:
        `Could not reach Telegram: ${error instanceof Error ? error.message : String(error)}. ` +
        `It was not sent again.`,
    }).catch(() => undefined);
  }
}

/**
 * The "send a test message" button on the Settings screen.
 *
 * Worth its own path rather than making somebody start a run to find out: getting a
 * chat id is the fiddly half of setting Telegram up, and a configuration that is
 * silently wrong looks exactly like a quiet night.
 *
 * Returns the failure rather than logging it — there is no run to log against, and
 * the person is standing in front of the screen waiting for an answer.
 */
export async function telegramTest(
  ownerId: string,
): Promise<{ ok: boolean; message: string }> {
  const target = await getTelegramTarget(ownerId);

  if (target === null) {
    return { ok: false, message: "Fill in both the bot token and the chat id first." };
  }

  try {
    const response = await fetch(`${apiBase()}/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text: "✅ GOP_IMPORT is connected. This is where your run notifications will arrive.",
        disable_web_page_preview: true,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, message: "Sent — check Telegram." };
    }

    const detail = await response.text().then(
      (body) => body.replace(/\s+/g, " ").slice(0, 300),
      () => "",
    );

    return {
      ok: false,
      message:
        `Telegram refused it (HTTP ${response.status})${detail === "" ? "" : `: ${detail}`}. ` +
        `A 401 means the token is wrong; "chat not found" means the chat id is, or the bot ` +
        `has not been started in that chat yet.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach Telegram: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
