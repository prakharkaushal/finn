"use client";

import { useMemo } from "react";
import type { InboxQuery } from "@/lib/inbox/params";
import { switchDataMode, useDataMode } from "@/components/data-mode";
import { useSettings } from "@/components/settings-provider";
import { InboxScreen } from "@/components/inbox/inbox-screen";
import { useInbox } from "@/components/inbox/use-inbox";
import { PageFrame } from "@/components/shell";
import { ButtonLink, EmptyState } from "@/components/ui";

/** Wires settings and live data into the inbox screen. */
export function InboxView() {
  const { ready, settings, update, done, markDone, undoDone } = useSettings();
  const query: InboxQuery | null = useMemo(
    () =>
      ready && settings.portfolio.length
        ? { symbols: settings.portfolio, windowKey: settings.windowKey, thresholds: settings.thresholds, alertCategories: settings.alertCategories }
        : null,
    [ready, settings],
  );
  const { data, error, loading, refresh } = useInbox(query);
  const mode = useDataMode();
  const canUseDemo = mode?.dataMode === "live" && !mode.demoForced;

  if (ready && settings.portfolio.length === 0) {
    return (
      <PageFrame>
        <h1 className="sr-only">Inbox</h1>
        <div className="mt-10">
          <EmptyState title="Your portfolio is empty" action={<ButtonLink href="/settings" variant="primary">Add companies</ButtonLink>}>
            Add NSE companies and FINN will watch their filings and end-of-day prices for you.
          </EmptyState>
        </div>
      </PageFrame>
    );
  }

  return (
    <InboxScreen
      data={data}
      error={error}
      loading={loading}
      windowKey={settings.windowKey}
      onWindowChange={(windowKey) => update({ windowKey })}
      portfolioSize={settings.portfolio.length}
      thresholds={settings.thresholds}
      done={done}
      onDone={markDone}
      onUndo={undoDone}
      onRefresh={refresh}
      onUseDemo={canUseDemo ? () => switchDataMode("demo") : undefined}
    />
  );
}
