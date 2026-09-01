import { getEvaluationArtifact } from "../../export-utils";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { batchId } = await context.params;
  const result = getEvaluationArtifact(batchId, "BUNDLE_JSON");
  if (!result.ok) {
    return Response.json({ ruleId: result.ruleId, message: result.message }, { status: result.status });
  }
  return new Response(result.data.content, {
    status: 200,
    headers: {
      "Content-Type": result.data.contentType,
      "Content-Disposition": result.data.disposition,
      "Cache-Control": "no-store",
    },
  });
}
