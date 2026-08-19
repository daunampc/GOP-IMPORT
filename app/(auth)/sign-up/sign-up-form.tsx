"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, Input, Panel } from "@/components/ui";

export function SignUpForm({ firstUser }: { firstUser: boolean }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, licenseKey }),
      });

      const payload = (await response.json()) as {
        activated?: boolean;
        firstUser?: boolean;
        needsKey?: boolean;
        error?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? "Could not create the account.");
        return;
      }

      /*
       * Created but not activated — the ordinary path for everybody but the first
       * account. On to `/activate`, carrying the reason when there was one (a
       * mistyped key), and with no reason when they simply had no key to give.
       *
       * Not treated as a failure: the account is real and the password they chose
       * works. Only the licence is missing, and that is the next screen's job.
       */
      if (payload.needsKey === true || payload.activated === false) {
        const reason = payload.error ?? "";
        router.push(reason === "" ? "/activate" : `/activate?reason=${encodeURIComponent(reason)}`);
        router.refresh();
        return;
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
    <Panel title={firstUser ? "Create administrator" : "Create account"} icon="plus">
      <form onSubmit={submit} className="space-y-4">
        {firstUser ? (
          <Alert tone="info" title="This is the first account">
            It becomes the administrator: the only role that can issue licence keys.
            No key is needed to create it.
          </Alert>
        ) : (
          <Alert tone="info" title="You do not need a licence key to sign up">
            Create the account first. The next screen asks for an activation key, and
            every screen stays locked until you enter one — so if you do not have a key
            yet, ask your administrator and come back to it.
          </Alert>
        )}

        <Field label="Name" htmlFor="name">
          <Input
            id="name"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          hint="At least 10 characters."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {/*
          Optional, and labelled as such. Kept rather than removed because somebody
          who already has a key should not have to go through two screens to use it
          — but leaving it blank is now a perfectly ordinary way to sign up, and the
          hint says so instead of leaving people hunting for a key they do not need
          yet.
        */}
        {!firstUser ? (
          <Field
            label="Licence key"
            htmlFor="licenseKey"
            hint="Optional. Leave it blank if you do not have one yet — you can enter it on the next screen."
          >
            <Input
              id="licenseKey"
              placeholder="GOP-XXXX-XXXX-XXXX"
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value)}
              className="font-mono uppercase"
            />
          </Field>
        ) : null}

        {error ? <Alert tone="bad">{error}</Alert> : null}

        <Button type="submit" variant="primary" block size="lg" loading={busy}>
          {firstUser ? "Create administrator" : "Create account"}
        </Button>

        <p className="text-center text-xs text-ink-subtle">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-accent-fg hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </Panel>
  );
}
