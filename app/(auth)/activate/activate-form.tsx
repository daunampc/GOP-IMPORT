"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, Input, Panel, useToast } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { signOut } from "@/lib/auth-client";

export function ActivateForm({
  email,
  reason,
  hadKey,
}: {
  email: string;
  reason: string | null;
  hadKey: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(reason);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      const payload = (await response.json()) as {
        activated?: boolean;
        expiresAt?: string | null;
        error?: string;
      };

      if (!response.ok || !payload.activated) {
        setError(payload.error ?? "That licence key was not accepted.");
        return;
      }

      /*
       * Say when it runs out, at the moment it starts.
       *
       * A key with a term begins counting down from THIS instant, and this is the
       * only moment the person is guaranteed to be looking. Finding out on the day
       * it stops working is the alternative, and that is a support call.
       */
      if (payload.expiresAt != null) {
        toast.warn(
          "Account activated",
          `This licence runs until ${formatDateTime(payload.expiresAt)}. The countdown started just now, when you entered the key.`,
        );
      } else {
        toast.success("Account activated", "This licence does not expire.");
      }

      router.push("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Activate this account" icon="key">
      <form onSubmit={submit} className="space-y-4">
        <Alert tone={hadKey ? "warn" : "info"} title={hadKey ? "Licence no longer valid" : "A licence key is required"}>
          {hadKey
            ? `The key previously on ${email} has been revoked or has expired. Enter a replacement to continue.`
            : `Signed in as ${email}. The import screens stay locked until a licence key is activated.`}
        </Alert>

        <Field
          label="Licence key"
          htmlFor="key"
          required
          hint="Looks like GOP-XXXX-XXXX-XXXX. If it carries a time limit, that limit starts the moment you activate it here — not when it was issued."
        >
          <Input
            id="key"
            required
            autoFocus
            placeholder="GOP-XXXX-XXXX-XXXX"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="font-mono uppercase"
          />
        </Field>

        {error ? <Alert tone="bad">{error}</Alert> : null}

        <Button type="submit" variant="primary" block size="lg" loading={busy}>
          Activate
        </Button>

        <Button
          type="button"
          variant="ghost"
          block
          icon="arrow-left"
          onClick={async () => {
            await signOut();
            router.push("/sign-in");
            router.refresh();
          }}
        >
          Sign out
        </Button>
      </form>
    </Panel>
  );
}
