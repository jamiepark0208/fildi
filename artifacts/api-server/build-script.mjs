import { createRequire } from "node:module";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const [,, entry] = process.argv;
if (!entry) { console.error("Usage: node build-script.mjs <src/scripts/foo.ts>"); process.exit(1); }

await build({
  entryPoints: [entry],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: "dist/scripts",
  outExtension: { ".js": ".mjs" },
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  external: ["*.node","sharp","better-sqlite3","argon2","bcrypt","fsevents","re2","farmhash","xxhash-addon","bufferutil","utf-8-validate"],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
  },
  logLevel: "info",
});
