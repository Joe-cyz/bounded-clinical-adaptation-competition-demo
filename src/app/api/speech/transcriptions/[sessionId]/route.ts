import { DELETE as deleteSpeechTranscription } from "@/server/speech-transcription-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  return deleteSpeechTranscription(request, sessionId);
}
