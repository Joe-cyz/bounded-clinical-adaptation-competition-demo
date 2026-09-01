import { getDatabase } from "@/server/database";
import { getCurrentSchemaVersion } from "@/infrastructure/sqlite/migrations";

export const dynamic = "force-dynamic";

export function GET(): Response {
  if (process.env.APP_RUNTIME_MODE !== "local-research") {
    return Response.json({
      ok: true,
      runtime: "public-demo",
      syntheticOnly: true,
      readOnly: true,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const database = getDatabase();
    return Response.json({
      ok: true,
      runtime: "evaluation",
      schemaVersion: getCurrentSchemaVersion(database),
      syntheticOnly: true,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, ruleId: "EVALUATION_HEALTH_UNAVAILABLE" }, { status: 503 });
  }
}
