import { POST as postLiteratureImportBatch } from "@/server/literature-import-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  return postLiteratureImportBatch(request);
}
