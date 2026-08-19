import { ButtonLink, EmptyState, Panel } from "@/components/ui";

export default function NotFound() {
  return (
    <Panel title="Not found" icon="search">
      <EmptyState
        icon="search"
        title="There is nothing at this address"
        description="Runs and previews both expire — runs after 7 days, previews after an hour. Past that the data has been cleaned up, which is ordinary behaviour rather than a fault."
        action={
          <ButtonLink href="/" variant="primary" icon="dashboard">
            Back to the dashboard
          </ButtonLink>
        }
        secondary={
          <ButtonLink href="/process" variant="secondary" icon="activity">
            Open activity
          </ButtonLink>
        }
      />
    </Panel>
  );
}
