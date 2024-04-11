import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { URLSearchParams } from "node:url";
import { fetchResult } from "../cfetch";
import { printBindings } from "../config";
import { bundleWorker } from "../deployment-bundle/bundle";
import { printBundleSize } from "../deployment-bundle/bundle-reporter";
import { getBundleType } from "../deployment-bundle/bundle-type";
import { createWorkerUploadForm } from "../deployment-bundle/create-worker-upload-form";
import {
	findAdditionalModules,
	writeAdditionalModules,
} from "../deployment-bundle/find-additional-modules";
import {
	createModuleCollector,
	getWrangler1xLegacyModuleReferences,
} from "../deployment-bundle/module-collection";
import { loadSourceMaps } from "../deployment-bundle/source-maps";
import { UserError } from "../errors";
import { logger } from "../logger";
import { getMetricsUsageHeaders } from "../metrics";
import { isNavigatorDefined } from "../navigator-user-agent";
import { getWranglerTmpDir } from "../paths";
import { getQueue } from "../queues/client";
import type { FetchError } from "../cfetch";
import type { Config } from "../config";
import type { Rule } from "../config/environment";
import type { Entry } from "../deployment-bundle/entry";
import type {
	CfModule,
	CfPlacement,
	CfWorkerInit,
} from "../deployment-bundle/worker";

type Props = {
	config: Config;
	accountId: string | undefined;
	entry: Entry;
	rules: Config["rules"];
	name: string | undefined;
	env: string | undefined;
	compatibilityDate: string | undefined;
	compatibilityFlags: string[] | undefined;
	vars: Record<string, string> | undefined;
	defines: Record<string, string> | undefined;
	jsxFactory: string | undefined;
	jsxFragment: string | undefined;
	tsconfig: string | undefined;
	minify: boolean | undefined;
	outDir: string | undefined;
	dryRun: boolean | undefined;
	noBundle: boolean | undefined;
	keepVars: boolean | undefined;
	uploadSourceMaps: boolean | undefined;
	projectRoot: string | undefined;
};

export default async function deploy(props: Props): Promise<void> {
	// TODO: warn if git/hg has uncommitted changes
	const { config, accountId, name } = props;

	if (!(props.compatibilityDate || config.compatibility_date)) {
		const compatibilityDateStr = `${new Date().getFullYear()}-${(
			new Date().getMonth() +
			1 +
			""
		).padStart(2, "0")}-${(new Date().getDate() + "").padStart(2, "0")}`;

		throw new UserError(`A compatibility_date is required when publishing. Add the following to your wrangler.toml file:.
    \`\`\`
    compatibility_date = "${compatibilityDateStr}"
    \`\`\`
    Or you could pass it in your terminal as \`--compatibility-date ${compatibilityDateStr}\`
See https://developers.cloudflare.com/workers/platform/compatibility-dates for more information.`);
	}

	const jsxFactory = props.jsxFactory || config.jsx_factory;
	const jsxFragment = props.jsxFragment || config.jsx_fragment;
	const keepVars = props.keepVars || config.keep_vars;

	const minify = props.minify ?? config.minify;

	const compatibilityFlags =
		props.compatibilityFlags ?? config.compatibility_flags;
	const nodejsCompat = compatibilityFlags.includes("nodejs_compat");

	// Warn if user tries minify or node-compat with no-bundle
	if (props.noBundle && minify) {
		logger.warn(
			"`--minify` and `--no-bundle` can't be used together. If you want to minify your Worker and disable Wrangler's bundling, please minify as part of your own bundling process."
		);
	}

	assert(
		name,
		'You need to provide a name when publishing a worker. Either pass it as a cli arg with `--name <name>` or in your config file as `name = "<name>"`'
	);

	if (props.outDir) {
		// we're using a custom output directory,
		// so let's first ensure it exists
		mkdirSync(props.outDir, { recursive: true });
		// add a README
		const readmePath = path.join(props.outDir, "README.md");
		writeFileSync(
			readmePath,
			`This folder contains the built output assets for the worker "${name}" generated at ${new Date().toISOString()}.`
		);
	}

	const destination =
		props.outDir ?? getWranglerTmpDir(props.projectRoot, "deploy");

	const start = Date.now();
	const workerUrl = `/accounts/${accountId}/workflows/${name}`;

	let deploymentId: string | null = null;

	try {
		if (props.noBundle) {
			// if we're not building, let's just copy the entry to the destination directory
			const destinationDir =
				typeof destination === "string" ? destination : destination.path;
			mkdirSync(destinationDir, { recursive: true });
			writeFileSync(
				path.join(destinationDir, path.basename(props.entry.file)),
				readFileSync(props.entry.file, "utf-8")
			);
		}

		const entryDirectory = path.dirname(props.entry.file);
		const moduleCollector = createModuleCollector({
			wrangler1xLegacyModuleReferences: getWrangler1xLegacyModuleReferences(
				entryDirectory,
				props.entry.file
			),
			entry: props.entry,
			// `moduleCollector` doesn't get used when `props.noBundle` is set, so
			// `findAdditionalModules` always defaults to `false`
			findAdditionalModules: config.find_additional_modules ?? false,
			rules: props.rules,
			preserveFileNames: config.preserve_file_names ?? false,
		});
		const uploadSourceMaps =
			props.uploadSourceMaps ?? config.upload_source_maps;

		const {
			modules,
			dependencies,
			resolvedEntryPointPath,
			bundleType,
			...bundle
		} = props.noBundle
			? await noBundleWorker(props.entry, props.rules, props.outDir)
			: await bundleWorker(
					props.entry,
					typeof destination === "string" ? destination : destination.path,
					{
						bundle: true,
						additionalModules: [],
						moduleCollector,
						serveAssetsFromWorker: false,
						doBindings: config.durable_objects.bindings,
						jsxFactory,
						jsxFragment,
						tsconfig: props.tsconfig ?? config.tsconfig,
						minify,
						sourcemap: uploadSourceMaps,
						legacyNodeCompat: undefined,
						nodejsCompat,
						define: { ...config.define, ...props.defines },
						checkFetch: false,
						assets: config.assets,
						// enable the cache when publishing
						bypassAssetCache: false,
						// We want to know if the build is for development or publishing
						// This could potentially cause issues as we no longer have identical behaviour between dev and deploy?
						targetConsumer: "deploy",
						local: false,
						projectRoot: props.projectRoot,
						defineNavigatorUserAgent: isNavigatorDefined(
							props.compatibilityDate ?? config.compatibility_date,
							props.compatibilityFlags ?? config.compatibility_flags
						),
					}
			  );

		// Add modules to dependencies for size warning
		for (const module of modules) {
			const modulePath =
				module.filePath === undefined
					? module.name
					: path.relative("", module.filePath);
			const bytesInOutput =
				typeof module.content === "string"
					? Buffer.byteLength(module.content)
					: module.content.byteLength;
			dependencies[modulePath] = { bytesInOutput };
		}

		// Add modules to dependencies for size warning
		for (const module of modules) {
			const modulePath =
				module.filePath === undefined
					? module.name
					: path.relative("", module.filePath);
			const bytesInOutput =
				typeof module.content === "string"
					? Buffer.byteLength(module.content)
					: module.content.byteLength;
			dependencies[modulePath] = { bytesInOutput };
		}

		const content = readFileSync(resolvedEntryPointPath, {
			encoding: "utf-8",
		});

		const bindings: CfWorkerInit["bindings"] = {
			kv_namespaces: config.kv_namespaces,
			send_email: config.send_email,
			vars: { ...config.vars, ...props.vars },
			wasm_modules: undefined,
			browser: config.browser,
			ai: config.ai,
			version_metadata: config.version_metadata,
			text_blobs: undefined,
			data_blobs: undefined,
			durable_objects: config.durable_objects,
			queues: config.queues.producers?.map((producer) => {
				return { binding: producer.binding, queue_name: producer.queue };
			}),
			r2_buckets: config.r2_buckets,
			d1_databases: config.d1_databases,
			vectorize: config.vectorize,
			constellation: config.constellation,
			hyperdrive: config.hyperdrive,
			services: config.services,
			analytics_engine_datasets: config.analytics_engine_datasets,
			dispatch_namespaces: config.dispatch_namespaces,
			mtls_certificates: config.mtls_certificates,
			logfwdr: undefined,
			unsafe: {
				bindings: config.unsafe.bindings,
				metadata: config.unsafe.metadata,
				capnp: config.unsafe.capnp,
			},
		};

		// The upload API only accepts an empty string or no specified placement for the "off" mode.
		const placement: CfPlacement | undefined =
			config.placement?.mode === "smart" ? { mode: "smart" } : undefined;

		const entryPointName = path.basename(resolvedEntryPointPath);
		const main: CfModule = {
			name: entryPointName,
			filePath: resolvedEntryPointPath,
			content: content,
			type: bundleType,
		};
		const worker: CfWorkerInit = {
			name,
			main,
			bindings,
			migrations: undefined,
			modules,
			sourceMaps: uploadSourceMaps
				? loadSourceMaps(main, modules, bundle)
				: undefined,
			compatibility_date: props.compatibilityDate ?? config.compatibility_date,
			compatibility_flags: compatibilityFlags,
			usage_model: config.usage_model,
			keepVars,
			keepSecrets: keepVars, // keepVars implies keepSecrets
			logpush: undefined,
			placement,
			tail_consumers: config.tail_consumers,
			limits: config.limits,
		};

		// As this is not deterministic for testing, we detect if in a jest environment and run asynchronously
		// We do not care about the timing outside of testing
		const bundleSizePromise = printBundleSize(
			{ name: path.basename(resolvedEntryPointPath), content: content },
			modules
		);
		if (process.env.JEST_WORKER_ID !== undefined) await bundleSizePromise;
		else void bundleSizePromise;

		const withoutStaticAssets = {
			...bindings,
			kv_namespaces: config.kv_namespaces,
			text_blobs: config.text_blobs,
		};

		// mask anything that was overridden in cli args
		// so that we don't log potential secrets into the terminal
		const maskedVars = { ...withoutStaticAssets.vars };
		for (const key of Object.keys(maskedVars)) {
			if (maskedVars[key] !== config.vars[key]) {
				// This means it was overridden in cli args
				// so let's mask it
				maskedVars[key] = "(hidden)";
			}
		}

		printBindings({ ...withoutStaticAssets, vars: maskedVars });

		if (!props.dryRun) {
			await ensureQueuesExist(config);

			// Upload the script so it has time to propagate.
			// We can also now tell whether available_on_subdomain is set
			const result = await fetchResult<{
				id: string;
				name: string;
				created_on: string;
				modified_on: string;
				version: { id: string };
			}>(
				workerUrl,
				{
					method: "PUT",
					body: createWorkerUploadForm(worker),
					headers: await getMetricsUsageHeaders(config.send_metrics),
				},
				new URLSearchParams({
					include_subdomain_availability: "true",
					// pass excludeScript so the whole body of the
					// script doesn't get included in the response
					excludeScript: "true",
				})
			);

			deploymentId = result.version.id;
		}
	} finally {
		if (typeof destination !== "string") {
			// this means we're using a temp dir,
			// so let's clean up before we proceed
			destination.remove();
		}
	}

	if (props.dryRun) {
		logger.log(`--dry-run: exiting now.`);
		return;
	}

	const uploadMs = Date.now() - start;

	logger.log("Uploaded", name, formatTime(uploadMs));

	logger.log("New Version ID:", deploymentId);
}

function formatTime(duration: number) {
	return `(${(duration / 1000).toFixed(2)} sec)`;
}

async function ensureQueuesExist(config: Config) {
	const producers = (config.queues.producers || []).map(
		(producer) => producer.queue
	);
	const consumers = (config.queues.consumers || []).map(
		(consumer) => consumer.queue
	);

	const queueNames = producers.concat(consumers);
	for (const queue of queueNames) {
		try {
			await getQueue(config, queue);
		} catch (err) {
			const queueErr = err as FetchError;
			if (queueErr.code === 11000) {
				// queue_not_found
				throw new UserError(
					`Queue "${queue}" does not exist. To create it, run: wrangler queues create ${queue}`
				);
			}
			throw err;
		}
	}
}

async function noBundleWorker(
	entry: Entry,
	rules: Rule[],
	outDir: string | undefined
) {
	const modules = await findAdditionalModules(entry, rules);
	if (outDir) {
		await writeAdditionalModules(modules, outDir);
	}

	const bundleType = getBundleType(entry.format, entry.file);
	return {
		modules,
		dependencies: {} as { [path: string]: { bytesInOutput: number } },
		resolvedEntryPointPath: entry.file,
		bundleType,
	};
}
