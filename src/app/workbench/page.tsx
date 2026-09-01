import { PrototypeWorkbench } from "@/components/prototype-workbench";
import { getProviderCapabilities } from "@/server/provider";

export const dynamic = "force-dynamic";

export default function WorkbenchPage() {
  return <PrototypeWorkbench providerCapabilities={getProviderCapabilities()} />;
}
