import path from "node:path";
import util from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { unstable_dev } from "wrangler";

let output = "";
function spyOnConsoleMethod(name: keyof typeof console) {
	vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
		output += util.format(...args) + "\n";
	});
}
beforeEach(() => {
	spyOnConsoleMethod("error");
});
afterEach(() => {
	vi.restoreAllMocks();
	output = "";
});

it("logs startup errors", async () => {
	try {
		const worker = await unstable_dev(
			path.resolve(__dirname, "..", "src", "nodejs-compat.ts"),
			{
				config: path.resolve(__dirname, "..", "wrangler.logging.toml"),
				// Intentionally omitting `compatibilityFlags: ["nodejs_compat"]`
				experimental: { disableExperimentalWarning: true },
			}
		);
		await worker.stop();
		expect.fail("Expected unstable_dev() to fail");
	} catch {}
	expect(output).toMatchInlineSnapshot(`
		"[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mservice core:user:local-mode-tests: Uncaught Error: No such module "node:buffer".[0m

		    imported from "nodejs-compat.js"


		[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mError reloading local server: MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start. There is likely additional logging output above.[0m

		      at Miniflare.#assembleAndUpdateConfig (/Users/penalosa/dev/wrangler2/packages/miniflare/src/index.ts:1304:10)
		      at processTicksAndRejections (node:internal/process/task_queues:96:5)
		      at Mutex.runWith (/Users/penalosa/dev/wrangler2/packages/miniflare/src/workers/shared/sync.ts:66:45)
		      at Miniflare.#waitForReady (/Users/penalosa/dev/wrangler2/packages/miniflare/src/index.ts:1386:3)
		      at EventTarget.#onBundleUpdate (/Users/penalosa/dev/wrangler2/packages/wrangler/import_meta_url.js:109246:20)
		      at Mutex.runWith (/Users/penalosa/dev/wrangler2/packages/miniflare/src/workers/shared/sync.ts:66:45) {
		    code: 'ERR_RUNTIME_FAILURE',
		    cause: undefined
		  }


		"
	`);
});
