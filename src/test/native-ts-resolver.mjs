import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const serverOnlyModule = "data:text/javascript,export {};";
const extensions = ["", ".ts", ".tsx", ".js", ".mjs"];

function existingModuleUrl(filePath) {
  for (const extension of extensions) {
    const candidate = `${filePath}${extension}`;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: serverOnlyModule, shortCircuit: true };
  }

  let candidatePath;
  if (specifier.startsWith("@/")) {
    candidatePath = resolvePath(sourceRoot, specifier.slice(2));
  } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    candidatePath = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
  }

  if (candidatePath) {
    const moduleUrl = existingModuleUrl(candidatePath);
    if (moduleUrl) return { url: moduleUrl, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
