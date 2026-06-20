/**
 * Dockermender "Engine Room" brand mark: a machined hex bolt-head with a
 * center slot — hardware that gets fixed/mended. Single-color via
 * `currentColor` so it inherits the brass accent from its container.
 */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M9 4 L23 4 L30 16 L23 28 L9 28 L2 16 Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect x="9" y="14" width="14" height="4" rx="2" fill="currentColor" />
    </svg>
  );
}
