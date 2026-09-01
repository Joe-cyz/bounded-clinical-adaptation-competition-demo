import { POST as postSpeechTranscription } from "@/server/speech-transcription-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  return postSpeechTranscription(request);
}
