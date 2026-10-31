import { Suspense } from "react";
import { ResearchView } from "@/components/research/research-view";
import { Skeleton } from "@/components/ui";

// The symbol comes from the URL at request time, so the view streams in behind a boundary.
export default function ResearchPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-2xl px-4 pt-16">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-7 w-64" />
        </main>
      }
    >
      <ResearchView />
    </Suspense>
  );
}
