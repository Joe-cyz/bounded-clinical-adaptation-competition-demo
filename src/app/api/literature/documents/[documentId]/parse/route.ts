import { POST as postLiteratureParse } from "@/server/literature-parse-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await context.params;
  return postLiteratureParse(request, documentId);
}
