import { register } from "node:module";

register(new URL("./native-ts-resolver.mjs", import.meta.url), import.meta.url);
