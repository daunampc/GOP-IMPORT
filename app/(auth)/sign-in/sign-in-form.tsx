"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, Input, Panel } from "@/components/ui";
import { signIn } from "@/lib/auth-client";

export function SignInForm({
  needsSetup,
  reason,
}: {
  needsSetup: boolean;
  reason: string | null;
}) {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await signIn.email({ email, password });

      if (result.error) {
        // Deliberately vague: saying which half was wrong tells an attacker
        // which addresses have accounts.
        setError(result.error.message ?? "Email or password is incorrect.");
        return;
      }

      // Full navigation, not a client push: the layout guard has to re-run on
      // the server now that a session cookie exists.
      router.push("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (needsSetup) {
    return (
      <Panel title="First run" icon="shield-check">
        <div className="space-y-4">
          <Alert tone="info" title="No accounts exist yet">
            The first account created becomes the administrator and is the only one
            that can issue licence keys. It does not need a key itself.
          </Alert>
          <Link href="/sign-up" className="block">
            <Button variant="primary" block icon="plus">
              Create the administrator account
            </Button>
          </Link>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Sign in" icon="key">
      <form onSubmit={submit} className="space-y-4">
        {reason === "disabled" ? (
          <Alert tone="bad" title="This account is disabled">
            Ask an administrator to re-enable it.
          </Alert>
        ) : null}

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

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {error ? <Alert tone="bad">{error}</Alert> : null}

        <Button type="submit" variant="primary" block size="lg" loading={busy}>
          Sign in
        </Button>

        <p className="text-center text-xs text-ink-subtle">
          Have a licence key but no account?{" "}
          <Link href="/sign-up" className="text-accent-fg hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </Panel>
  );
}
