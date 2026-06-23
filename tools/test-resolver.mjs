// Lets `node --test` run the TypeScript sources directly. The plugin sources use bundler-style,
// extensionless relative imports (resolved by rollup at build time); Node's ESM loader needs an
// explicit extension, so this hook maps an extensionless relative specifier to its `.ts` source.
// Wired into the `test` script via `node --import ./tools/test-resolver.mjs`.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && context.parentURL && !/\.[mc]?[jt]s$/.test(specifier)) {
			const candidate = new URL(`${specifier}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(candidate))) {
				return nextResolve(candidate.href, context);
			}
		}
		return nextResolve(specifier, context);
	},
});
