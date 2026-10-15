import { CrawlForm } from "./crawl-form";

/**
 * Nothing to load.
 *
 * Every other screen under `(app)` reads something from Postgres before it
 * renders — sites, presets, settings. This one has no such list: the only
 * questions on this screen are about the shop being crawled, not this
 * account's data, and `(app)/layout.tsx` has already resolved and guarded the
 * view (`requireView()`) before this page is reached.
 */
export default function CrawlPage() {
  return <CrawlForm />;
}
