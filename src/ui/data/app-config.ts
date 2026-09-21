/**
 * Trivial build-time config reader. Kept as its own module so screens never
 * reach into `import.meta.env` directly — a single seam if config needs to
 * grow beyond a dev/prod flag.
 */
export function isDev(): boolean {
  return import.meta.env.DEV;
}
