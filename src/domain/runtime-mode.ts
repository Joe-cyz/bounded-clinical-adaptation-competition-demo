import { z } from "zod";

/**
 * The only runtime modes supported by the application. This schema is shared
 * by domain records and the server-side runtime configuration so a persisted
 * Encounter cannot introduce a second, incompatible mode vocabulary.
 */
export const appRuntimeModeSchema = z.enum(["public-demo", "local-research"]);
export type AppRuntimeMode = z.infer<typeof appRuntimeModeSchema>;
