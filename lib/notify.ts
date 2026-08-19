/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { createHmac } from "node:crypto";

import { logJob } from "./job-log";
import { blockedReason } from "./outbound-url";
import { getWebhookTarget } from "./settings";
import { telegramRunFinished } from "./telegram";
import type { JobState } from "./jobs";

/**
 * Telling somebody a run has finished — §6 C3.
 *
 * A 14,000-product run takes hours, and until now the only way to know it had
 * ended was to keep the screen open. One POST when the run reaches a terminal
 * state closes that.
 *
 * Three properties, and each of them is a decision:
 *
 * EVERY terminal outcome, not only success. A run that failed on the account's
 * permissions, or whose staged payload had expired, ends without sending a single
 * batch — and that is precisely the case somebody sitting watching the screen
 * needs told about. Silence cannot distinguish "finished, all good" from "the
 * worker died". An account that finds that noisy sets "only when something went
 * wrong", which is a switch rather than the default.
 *
 * IT NEVER THROWS, and never delays the run. The record of what happened is in
 * Postgres before this is called; the notification is a courtesy on top. A webhook
 * that took a run down with it — or held the worker's next job while a dead
 * receiver timed out — would be worse than no webhook at all.
 *
 * ONE ATTEMPT. Deliberately unlike a batch, which now retries: a batch is work
 * that must land, and this is an announcement whose content is already durable and
 * always readable on the run's own page. Retrying would hold the lane for a
 * receiver's benefit. The attempt and its outcome are logged either way, so "we
 * were never told" is answerable.
 */

/** Deadline on the POST. Short: nothing waits for this, and nothing should. */
export const NOTIFY_TIMEOUT_MS = 5_000;

/** What the receiver is told. `event` is also the `X-TSD-Event` header. */
export interface RunFinishedPayload {
  event: "run.finished";
  /**
   * The whole thing in one sentence.
   *
   * Present so a Slack-shaped receiver works without a translator in between:
   * those expect a `text` field and ignore the rest. Costs one line and removes
   * the most likely reason somebody cannot use this at all.
   */
  text: string;
  run: {
    id: string;
    kind: string;
    status: string;
    storeLabel: string;
    sourceLabel: string;
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    deduplicated: number;
    startedAt: string | null;
    finishedAt: string | null;
    /** The run's own error or warning, in full. Never truncated. */
    error: string | null;
  };
  sentAt: string;
}

/**
 * The Telegram half, behind the same switch.
 *
 * The switch lives on the webhook settings because that is where it was, and moving it
 * would be a migration for no gain: it has always meant "how much do you want to hear
 * from this app", not "how much do you want to hear through this pipe".
 */
async function telegramIfWanted(state: JobState): Promise<void> {
  try {
    const webhook = await getWebhookTarget(state.createdBy);

    if (webhook !== null && webhook.failuresOnly && !somethingWentWrong(state)) {
      return;
    }

    await telegramRunFinished(state);
  } catch {
    // `telegramRunFinished` already swallows its own failures; this catches the
    // settings read, and a run must not fail because a preference could not be read.
  }
}

/** Whether anything about this run went wrong, for the "failures only" switch. */
function somethingWentWrong(state: JobState): boolean {
  return state.status !== "completed" || state.failed > 0;
}

function summarise(state: JobState): string {
  const what = `${state.kind} of ${state.total} item(s) to ${state.storeLabel}`;

  if (state.status !== "completed") {
    return (
      `${what} ended as ${state.status} after ${state.processed} of ${state.total}` +
      `${state.error === null ? "" : ` — ${state.error}`}`
    );
  }

  return (
    `${what} finished: ${state.succeeded} ok, ${state.failed} failed, ` +
    `${state.deduplicated} already present.`
  );
}

/**
 * POST once, log the outcome, swallow everything.
 *
 * `state` must be read AFTER the run was finished, so the counts and the status in
 * the payload are the final ones rather than the ones from before the last batch.
 */
export async function notifyRunFinished(state: JobState): Promise<void> {
  /*
   * Telegram is a second CHANNEL, not a second decision. It answers to the same
   * event and the same "only when something went wrong" switch as the webhook, so an
   * account that turned the noise down gets it turned down everywhere.
   *
   * Sent first and awaited separately: neither channel may be able to stop the other
   * from being told, and a webhook receiver that is down must not swallow the message
   * to the person's phone.
   */
  await telegramIfWanted(state);

  try {
    const target = await getWebhookTarget(state.createdBy);

    if (target === null) {
      return;
    }

    if (target.failuresOnly && !somethingWentWrong(state)) {
      return;
    }

    // Checked again at send time, not only when it was saved: a URL can have been
    // stored before this rule existed, and the rule is about what this process is
    // allowed to open.
    const blocked = blockedReason(target.url);

    if (blocked !== null) {
      await logJob(state.id, {
        level: "warn",
        stage: "notify",
        message: `The run-finished webhook was NOT sent: ${blocked}`,
      });
      return;
    }

    const payload: RunFinishedPayload = {
      event: "run.finished",
      text: summarise(state),
      run: {
        id: state.id,
        kind: state.kind,
        status: state.status,
        storeLabel: state.storeLabel,
        sourceLabel: state.sourceLabel,
        total: state.total,
        processed: state.processed,
        succeeded: state.succeeded,
        failed: state.failed,
        deduplicated: state.deduplicated,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        error: state.error,
      },
      sentAt: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-TSD-Event": payload.event,
      "X-TSD-Timestamp": timestamp,
    };

    /*
     * Signed with the scheme this codebase already has, over
     * `METHOD\nPATH\nTIMESTAMP\nBODY` — so a receiver verifies it with
     * `verifySignature()` from `lib/gop-client.ts` and nothing new has to be
     * explained to whoever writes the other end.
     *
     * The PATH rather than the whole URL, because that is what the existing scheme
     * signs and what a receiver behind a proxy can reconstruct.
     *
     * No secret means no signature header, rather than a signature over an empty
     * key that would look like protection and be none.
     */
    if (target.secret !== "") {
      const path = new URL(target.url).pathname;

      headers["X-TSD-Signature"] = createHmac("sha256", target.secret)
        .update(`POST\n${path}\n${timestamp}\n${body}`)
        .digest("hex");
    }

    const response = await fetch(target.url, {
      method: "POST",
      headers,
      body,
      // Not followed: a redirect is where a checked URL could otherwise send this
      // POST somewhere that was never checked.
      redirect: "manual",
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });

    if (!response.ok) {
      await logJob(state.id, {
        level: "warn",
        stage: "notify",
        message:
          `The run-finished webhook was sent but the receiver answered HTTP ` +
          `${response.status}. It was not sent again — this run's own page is the record.`,
        detail: { status: response.status },
      });
      return;
    }

    await logJob(state.id, {
      stage: "notify",
      message: `Told the configured webhook this run had finished (HTTP ${response.status}).`,
      // The URL is NOT logged. It is the account's own configuration and can carry a
      // token in its path — a Slack or Discord hook is exactly that.
      detail: { status: response.status, signed: target.secret !== "" },
    });
  } catch (error) {
    /*
     * Swallowed, and logged against the run.
     *
     * The run has already finished and its record is written. Rethrowing here would
     * mark a completed run's JOB as failed in BullMQ and invite a redelivery, which
     * would then find the run terminal and log a confusing "the queue offered this
     * again" — all because a receiver was down.
     */
    await logJob(state.id, {
      level: "warn",
      stage: "notify",
      message:
        `Could not tell the configured webhook this run had finished: ` +
        `${error instanceof Error ? error.message : String(error)}. It was not sent again.`,
    }).catch(() => undefined);
  }
}
