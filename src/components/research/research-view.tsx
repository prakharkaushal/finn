"use client";

import { useParams, useSearchParams } from "next/navigation";
import { switchDataMode, useDataMode } from "@/components/data-mode";
import { useSettings } from "@/components/settings-provider";
import { isResearchView, ResearchScreen, type ResearchView as View } from "@/components/research/research-screen";
import { useResearch } from "@/components/research/use-research";

/** Wires the URL, the research stream and the watchlist into the research screen. */
export function ResearchView() {
  const params = useParams<{ symbol: string }>();
  const searchParams = useSearchParams();
  const symbol = decodeURIComponent(params?.symbol ?? "").toUpperCase();
  const { steps, report, error, loading, refresh, retry, extras, addSource, removeSource } = useResearch(symbol);
  const { settings, update } = useSettings();
  const mode = useDataMode();
  const inPortfolio = settings.portfolio.includes(symbol);
  const requested = searchParams.get("view");
  const view: View = isResearchView(requested) ? requested : "business";

  // Each view is its own history entry, so Back returns to the previous view and links can deep-link one.
  const onView = (next: View) => {
    if (next === view) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("view", next);
    window.history.pushState(null, "", `?${sp.toString()}`);
    window.scrollTo({ top: 0 });
  };

  return (
    <ResearchScreen
      symbol={symbol}
      steps={steps}
      report={report}
      error={error}
      loading={loading}
      inPortfolio={inPortfolio}
      onToggleWatch={() => update({ portfolio: inPortfolio ? settings.portfolio.filter((s) => s !== symbol) : [...settings.portfolio, symbol] })}
      onRebuild={refresh}
      onRetry={retry}
      view={view}
      onView={onView}
      extras={extras}
      onAddSource={addSource}
      onRemoveSource={removeSource}
      onUseDemo={mode?.dataMode === "live" && !mode.demoForced ? () => switchDataMode("demo") : undefined}
      onUseLive={mode?.dataMode === "demo" && !mode.demoForced ? () => switchDataMode("live") : undefined}
    />
  );
}
