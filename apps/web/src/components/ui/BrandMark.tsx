/**
 * ComposeBastion brand mark: a battlemented bastion shield guarding two stacked
 * Compose layers — a stronghold for your fleet. Single-color via `currentColor`
 * so it inherits the brass accent from its container.
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
        d="M6 5 H10 V8 H14 V5 H18 V8 H22 V5 H26 V16 C26 22 22 26 16 29 C10 26 6 22 6 16 Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect x="10.5" y="12.6" width="11" height="2.7" rx="1.35" fill="currentColor" />
      <rect x="10.5" y="17.2" width="11" height="2.7" rx="1.35" fill="currentColor" />
    </svg>
  );
}
