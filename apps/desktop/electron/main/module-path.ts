import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the filesystem directory for the current ES module URL. */
export function getModuleDirectory(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}

/**
 * Resolve a build output that sits beside the main bundle.
 *
 * Vite does not keep a main-process module at one depth: a packaged build
 * inlines it into `out/main`, while `pnpm dev` splits it into
 * `out/main/chunks`. A caller that spells the target as `../preload/...`
 * therefore lands on `out/main/preload` under dev but `out/preload` in the
 * package, and the file silently fails to load. Searching upward for a
 * relative path that actually exists keeps one spelling working in both
 * modes, which matters most for the preload script: when it is missing the
 * window still paints, but every IPC call fails with no bridge.
 */
export function resolveBuildOutput(
  moduleUrl: string,
  relativePath: string,
  exists: (candidate: string) => boolean,
): string {
  let current = getModuleDirectory(moduleUrl);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, relativePath);
    if (exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Nothing matched; hand back the packaged-mode answer so the caller's own
  // error message names the path it expected.
  return join(getModuleDirectory(moduleUrl), relativePath);
}

/**
 * Find a file by its path from the repository root, walking up from
 * `moduleUrl`.
 *
 * Used for sources the dev server serves straight from the checkout rather
 * than from a bundle next to the main process.
 */
export function resolveFromModuleRoot(
  moduleUrl: string,
  relativePath: string,
  exists: (candidate: string) => boolean,
): string | null {
  let current = getModuleDirectory(moduleUrl);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, relativePath);
    if (exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
