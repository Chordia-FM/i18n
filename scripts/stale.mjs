// Dropping translations that describe an older version of their source string.
//
// Crowdin KEEPS a translation when its source is edited. So rewording an English string leaves
// every locale still describing the old copy, silently, with nothing in the export marking it.
// `catalog:report.helpText` sat like that in six languages: the English lost its `{name}` in a
// rewrite and the translations carried on interpolating it.
//
// The argument list is the part of that drift a machine can see. A translation whose ICU arguments
// disagree with its source cannot have been written against that source, whatever else is true of
// it. It is a weaker signal than "the prose changed" — a reword that keeps the same arguments slips
// through — but it is the half that is decidable, and it is the half that breaks at runtime.
//
// Deleting the key is the repair, not fixing it in place: a missing key falls back to English,
// which is current and correct, where a stale translation is confidently wrong. It returns on its
// own once Crowdin re-translates the new source.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// The same scanner the catalog check uses, so the pull drops exactly what the gate would reject
// rather than the two disagreeing about what counts as a placeholder.
import { placeholders } from "./check-catalogs.mjs";

/**
 * Look up the source string for `ns` + a dotted key.
 *
 * Cached per namespace, because the alternative is re-parsing `en/common.json` once per key.
 */
export function makeSourceLookup(root, source) {
	const cache = new Map();
	return (ns, dotted) => {
		if (!cache.has(ns)) {
			try {
				cache.set(ns, JSON.parse(readFileSync(join(root, source, ns), "utf8")));
			} catch {
				cache.set(ns, {});
			}
		}
		let node = cache.get(ns);
		for (const part of dotted.split(".")) {
			if (!node || typeof node !== "object") return undefined;
			node = node[part];
		}
		return typeof node === "string" ? node : undefined;
	};
}

/**
 * Delete every leaf whose placeholders disagree with the source, in place.
 *
 * Returns the dotted keys removed. A key the source does not have at all is left alone: that is a
 * different problem (`key not in source`) and the catalog check already reports it, so removing it
 * here would hide it.
 */
export function pruneStale(node, ns, lookup, prefix = "", out = []) {
	for (const [k, v] of Object.entries(node)) {
		const dotted = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === "object" && !Array.isArray(v)) {
			pruneStale(v, ns, lookup, dotted, out);
			if (Object.keys(v).length === 0) delete node[k];
		} else if (typeof v === "string") {
			const src = lookup(ns, dotted);
			if (src === undefined) continue;
			const want = placeholders(src);
			const got = placeholders(v);
			const mismatched =
				[...want].some((p) => !got.has(p)) || [...got].some((p) => !want.has(p));
			if (mismatched) {
				delete node[k];
				out.push(dotted);
			}
		}
	}
	return out;
}
