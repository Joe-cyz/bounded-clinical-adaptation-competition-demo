import "server-only";

import {
  createModelReferenceService,
  MODEL_REFERENCE_ERROR_CODES,
  type ModelReferenceServiceDependencies,
} from "@/application/model-reference-service";
import {
  createClinicalReferenceProvider,
  createLiteratureAnswerProvider,
  createOfflineModelReferenceFakeFetch,
  createDeepSeekRequestBudget,
  createRealClinicalReferenceProvider,
  createRealLiteratureAnswerProvider,
  type DeepSeekRequestBudget,
  type RealDeepSeekProviderOptions,
  type SafeDeepSeekRequestObserver,
} from "@/infrastructure/providers/model-reference-provider";
import type { ClinicalReferenceProvider, LiteratureAnswerProvider } from "@/application/ports/model-reference-provider";
import { evaluateModelReferenceRealGate, MODEL_REFERENCE_REAL_RULE_IDS } from "./model-reference-runtime-config";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";

type ModelReferenceRouteEnv = Partial<Pick<NodeJS.ProcessEnv,
  "APP_RUNTIME_MODE"
  | "PWR08C_FAKE_FETCH"
  | "PWR08D_REAL_PROVIDER_ENABLED"
  | "PWR08D_REAL_REQUEST_LIMIT"
  | "DEEPSEEK_API_KEY"
>>;

export type ModelReferenceRouteDependencies = {
  env?: ModelReferenceRouteEnv;
  serviceFactory?: () => ReturnType<typeof createModelReferenceService>;
  databaseFactory?: ModelReferenceServiceDependencies["databaseFactory"];
  realProviderFactory?: (options: RealDeepSeekProviderOptions) => {
    clinicalProvider: ClinicalReferenceProvider;
    literatureProvider: LiteratureAnswerProvider;
  };
  realProviderObserver?: SafeDeepSeekRequestObserver;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

function localGate(env: ModelReferenceRouteEnv): boolean {
  return env.APP_RUNTIME_MODE === "local-research";
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("invalid");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error("invalid");
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) throw new Error("too-large");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function failure(error: unknown): { status: number; errorCode: string } {
  if (!(error instanceof PersistenceError)) return { status: 400, errorCode: MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST };
  if (error.code === persistenceErrorCodes.RUNTIME_READ_ONLY) return { status: 403, errorCode: MODEL_REFERENCE_ERROR_CODES.PUBLIC_READ_ONLY };
  if (error.code === persistenceErrorCodes.NOT_FOUND) return { status: 404, errorCode: "NOT_FOUND" };
  if (error.code === persistenceErrorCodes.CONFLICT) return { status: 409, errorCode: error.ruleId ?? MODEL_REFERENCE_ERROR_CODES.CONFLICT };
  return { status: 400, errorCode: error.ruleId ?? MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST };
}

export function createModelReferenceRouteHandlers(dependencies: ModelReferenceRouteDependencies = {}) {
  const env: ModelReferenceRouteEnv = dependencies.env ?? (process.env as ModelReferenceRouteEnv);
  let realRequestBudget: DeepSeekRequestBudget | undefined;

  function configurationFailure(ruleId: string): PersistenceError {
    return new PersistenceError(persistenceErrorCodes.VALIDATION_FAILED, "模型参考 Provider 未通过受控配置门禁。", { ruleId });
  }

  function unusedProvider(): ClinicalReferenceProvider & LiteratureAnswerProvider {
    return {
      id: "not-used",
      modelId: "not-used",
      promptVersion: "general-clinical-reference-v1",
      generate: async () => ({ ok: false, code: "PROVIDER_NOT_ENABLED" }),
    } as ClinicalReferenceProvider & LiteratureAnswerProvider;
  }

  function service(operation: "generate" | "follow-up" = "generate") {
    if (operation === "follow-up") {
      if (dependencies.serviceFactory) return dependencies.serviceFactory();
      const provider = unusedProvider();
      return createModelReferenceService({
        databaseFactory: dependencies.databaseFactory,
        runtimeMode: env.APP_RUNTIME_MODE === "local-research" ? "local-research" : "public-demo",
        env: { APP_RUNTIME_MODE: env.APP_RUNTIME_MODE },
        clinicalProvider: provider,
        literatureProvider: provider,
      });
    }

    if (env.PWR08C_FAKE_FETCH === "true") {
      const conflict = evaluateModelReferenceRealGate({
        runtimeMode: env.APP_RUNTIME_MODE,
        fakeFetchEnabled: true,
        realProviderEnabled: env.PWR08D_REAL_PROVIDER_ENABLED,
        requestLimit: env.PWR08D_REAL_REQUEST_LIMIT,
      });
      if (!conflict.ok && conflict.ruleId !== MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_DISABLED) {
        throw configurationFailure(conflict.ruleId);
      }
      if (dependencies.serviceFactory) return dependencies.serviceFactory();
      const fetchImpl = createOfflineModelReferenceFakeFetch();
      return createModelReferenceService({
        databaseFactory: dependencies.databaseFactory,
        runtimeMode: env.APP_RUNTIME_MODE === "local-research" ? "local-research" : "public-demo",
        env: { APP_RUNTIME_MODE: env.APP_RUNTIME_MODE },
        clinicalProvider: createClinicalReferenceProvider({ fetchImpl }),
        literatureProvider: createLiteratureAnswerProvider({ fetchImpl }),
      });
    }

    const preliminaryGate = evaluateModelReferenceRealGate({
      runtimeMode: env.APP_RUNTIME_MODE,
      fakeFetchEnabled: false,
      realProviderEnabled: env.PWR08D_REAL_PROVIDER_ENABLED,
      requestLimit: env.PWR08D_REAL_REQUEST_LIMIT,
    });
    if (!preliminaryGate.ok && preliminaryGate.ruleId !== MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_CREDENTIAL_MISSING) {
      if (preliminaryGate.ruleId !== MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_DISABLED) {
        throw configurationFailure(preliminaryGate.ruleId);
      }
      if (dependencies.serviceFactory) return dependencies.serviceFactory();
      return createModelReferenceService({
        databaseFactory: dependencies.databaseFactory,
        runtimeMode: env.APP_RUNTIME_MODE === "local-research" ? "local-research" : "public-demo",
        env: { APP_RUNTIME_MODE: env.APP_RUNTIME_MODE },
        clinicalProvider: createClinicalReferenceProvider(),
        literatureProvider: createLiteratureAnswerProvider(),
      });
    }
    const realGate = evaluateModelReferenceRealGate({
      runtimeMode: env.APP_RUNTIME_MODE,
      fakeFetchEnabled: false,
      realProviderEnabled: env.PWR08D_REAL_PROVIDER_ENABLED,
      requestLimit: env.PWR08D_REAL_REQUEST_LIMIT,
      apiKey: env.DEEPSEEK_API_KEY,
    });
    if (!realGate.ok) throw configurationFailure(realGate.ruleId);
    realRequestBudget ??= createDeepSeekRequestBudget(realGate.requestLimit);
    if (dependencies.serviceFactory) return dependencies.serviceFactory();
    const options: RealDeepSeekProviderOptions = {
      apiKey: realGate.apiKey,
      fetchImpl: globalThis.fetch,
      requestBudget: realRequestBudget,
      ...(dependencies.realProviderObserver === undefined ? {} : { observer: dependencies.realProviderObserver }),
    };
    const providers = dependencies.realProviderFactory?.(options) ?? {
      clinicalProvider: createRealClinicalReferenceProvider(options),
      literatureProvider: createRealLiteratureAnswerProvider(options),
    };
    return createModelReferenceService({
      databaseFactory: dependencies.databaseFactory,
      runtimeMode: env.APP_RUNTIME_MODE === "local-research" ? "local-research" : "public-demo",
      env: { APP_RUNTIME_MODE: env.APP_RUNTIME_MODE },
      clinicalProvider: providers.clinicalProvider,
      literatureProvider: providers.literatureProvider,
    });
  }

  async function post(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json({ ok: false, errorCode: "ORIGIN_REJECTED" }, 403);
    if (!localGate(env)) return json({ ok: false, errorCode: MODEL_REFERENCE_ERROR_CODES.PUBLIC_READ_ONLY }, 403);
    if (request.headers.get("content-type")?.toLowerCase().split(";", 1)[0] !== "application/json") {
      return json({ ok: false, errorCode: MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST }, 400);
    }
    try {
      return json(await service().generate(await boundedJson(request)), 200);
    } catch (error) {
      const result = failure(error);
      return json({ ok: false, errorCode: result.errorCode }, result.status);
    }
  }

  async function postFollowUp(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json({ ok: false, errorCode: "ORIGIN_REJECTED" }, 403);
    if (!localGate(env)) return json({ ok: false, errorCode: MODEL_REFERENCE_ERROR_CODES.PUBLIC_READ_ONLY }, 403);
    if (request.headers.get("content-type")?.toLowerCase().split(";", 1)[0] !== "application/json") {
      return json({ ok: false, errorCode: MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST }, 400);
    }
    try {
      return json(service("follow-up").selectFollowUp(await boundedJson(request)), 200);
    } catch (error) {
      const result = failure(error);
      return json({ ok: false, errorCode: result.errorCode }, result.status);
    }
  }

  return { post, postFollowUp };
}

const handlers = createModelReferenceRouteHandlers();
export const POST = handlers.post;
export const POST_FOLLOW_UP = handlers.postFollowUp;
