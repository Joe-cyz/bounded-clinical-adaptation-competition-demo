import { ResearchOverview } from "@/components/research-overview";
import { getProviderCapabilities } from "@/server/provider";

export const dynamic = "force-dynamic";

export default function ResearchPage() {
  const providerCapabilities = getProviderCapabilities();
  return <ResearchOverview publicDemoReadOnly={providerCapabilities.publicDemoReadOnly} />;
}
