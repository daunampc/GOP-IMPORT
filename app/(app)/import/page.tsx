import { listPresets } from "@/lib/presets";
import { getS3Public, getSettings } from "@/lib/settings";
import { listStores, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { ImportWizard } from "./import-wizard";

// Sites and presets are read from Postgres on every visit.
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const { ownerId } = await requireView();

  const [stores, presets, settings, s3] = await Promise.all([
    listStores(ownerId),
    listPresets(ownerId),
    getSettings(ownerId),
    getS3Public(ownerId),
  ]);

  return (
    <ImportWizard
      stores={stores.map(toPublic)}
      presets={presets}
      settings={settings}
      // Read on the server so the wizard knows BEFORE anyone picks the S3 image
      // mode whether THIS ACCOUNT has a bucket configured — rather than failing
      // on the first image of the first batch, halfway into a run.
      s3Configured={s3.enabled}
    />
  );
}
