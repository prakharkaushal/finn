import { notFound } from "next/navigation";
import type { ResearchReport } from "@/lib/research/types";
import { StatesGallery } from "@/components/dev/states-gallery";
import sampleReport from "@/fixtures/research-sample.json";

export const metadata = { title: "Design review", robots: { index: false } };

/** Development-only gallery of every UI state, rendered from labelled sample fixtures. */
export default function StatesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <StatesGallery report={sampleReport as unknown as ResearchReport} />;
}
