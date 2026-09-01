import { POST_FOLLOW_UP as postFollowUp } from "@/server/model-reference-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  return postFollowUp(request);
}
