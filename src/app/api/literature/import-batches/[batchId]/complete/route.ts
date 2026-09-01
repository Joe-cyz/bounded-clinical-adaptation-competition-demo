import { COMPLETE as completeLiteratureImportBatch } from "@/server/literature-import-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { batchId } = await context.params;
  return completeLiteratureImportBatch(request, batchId);
}
