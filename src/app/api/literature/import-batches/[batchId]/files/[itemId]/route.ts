import { PUT as putLiteratureFile } from "@/server/literature-import-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PUT(
  request: Request,
  context: { params: Promise<{ batchId: string; itemId: string }> },
): Promise<Response> {
  const { batchId, itemId } = await context.params;
  return putLiteratureFile(request, batchId, itemId);
}
