"use client";

import { useState } from "react";

import { Alert, Button, Field, Input, Switch, Modal } from "@/components/ui";
import type { PublicStore } from "@/lib/stores";

/**
 * The add and EDIT form for a site.
 *
 * The previous build could only create and delete: changing a URL, a pin or
 * rotating a key meant deleting and recreating — and deleting takes every
 * queued run aimed at that site down with it.
 *
 * While editing, an empty API secret field means KEEP the stored key: the
 * browser never receives the current one, so there is no way to show it back.
 */
export function StoreForm({
  open,
  store,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** `null` means adding a new site. */
  store: PublicStore | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = store !== null;

  const [url, setUrl] = useState(store?.url ?? "");
  const [pin, setPin] = useState(store?.pin ?? "");
  const [apiKey, setApiKey] = useState(store?.apiKey ?? "");
  const [apiSecret, setApiSecret] = useState("");
  const [label, setLabel] = useState(store?.label ?? "");
  const [baseUrlOverride, setBaseUrlOverride] = useState(store?.baseUrlOverride ?? "");
  const [urlRewrite, setUrlRewrite] = useState(store?.urlRewrite ?? false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        url,
        pin,
        apiKey,
        label,
        baseUrlOverride,
        urlRewrite,
      };

      // Only send the secret when one was actually typed — sending an empty
      // string while editing would wipe a working key.
      if (!editing || apiSecret.trim() !== "") {
        body.apiSecret = apiSecret;
      }

      const response = await fetch(editing ? `/api/stores/${store.id}` : "/api/stores", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        setError(payload.error ?? "Could not save the site.");
        return;
      }

      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit site" : "Connect a new site"}
      description={
        editing
          ? "Changing the connection clears the previous check result — run it again afterwards."
          : "Get the API key and secret from GOP_IMPORT → Connection in wp-admin, or from setup.php."
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="save"
            loading={busy}
            disabled={url.trim() === "" || apiKey.trim() === "" || (!editing && apiSecret === "")}
            onClick={() => void submit()}
          >
            {editing ? "Save changes" : "Add the site"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Site URL" htmlFor="store-url" required>
          <Input
            id="store-url"
            value={url}
            placeholder="https://shop.com"
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>

        <Field
          label="Pin"
          htmlFor="store-pin"
          optional
          hint="Suffix of the plugin directory: wp-content/plugins/gop-import_<pin>"
        >
          <Input
            id="store-pin"
            value={pin}
            placeholder="101055"
            onChange={(event) => setPin(event.target.value)}
            className="font-mono"
          />
        </Field>

        <Field label="API key" htmlFor="store-key" required>
          <Input
            id="store-key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="API secret"
          htmlFor="store-secret"
          required={!editing}
          hint={
            editing
              ? "Leave empty to keep the stored key. A stored key can never be shown again."
              : "Encrypted with AES-256-GCM before it reaches the database, and never sent back to the browser."
          }
        >
          <Input
            id="store-secret"
            type="password"
            value={apiSecret}
            placeholder={editing ? "•••••• unchanged" : ""}
            onChange={(event) => setApiSecret(event.target.value)}
            className="font-mono text-xs"
          />
        </Field>

        <Field label="Label" htmlFor="store-label" optional>
          <Input
            id="store-label"
            value={label}
            placeholder="Main store"
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>

        <Field
          label="Plugin base URL"
          htmlFor="store-base"
          optional
          hint="Only needed when the plugin is not in its default place — a renamed wp-content, or a reverse proxy in front."
          className="sm:col-span-2"
        >
          <Input
            id="store-base"
            value={baseUrlOverride}
            placeholder="https://shop.com/wp-content/plugins/gop-import"
            onChange={(event) => setBaseUrlOverride(event.target.value)}
            className="font-mono text-xs"
          />
        </Field>

        <div className="sm:col-span-2">
          <Switch
            label="Use the /GPM/<pin> rewrite"
            description="Turn on when the host answers 403 to direct wp-content requests."
            checked={urlRewrite}
            onChange={setUrlRewrite}
          />
        </div>

        {error ? (
          <div className="sm:col-span-2">
            <Alert tone="bad" title="Could not save">
              {error}
            </Alert>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
