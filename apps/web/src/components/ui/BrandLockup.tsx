import { BrandMark } from "./BrandMark.js";

type BrandLockupProps = {
  tagline?: string;
  titleAs?: "strong" | "h1";
};

/**
 * Horizontal brand lockup: bolt-head mark in a machined tile + wordmark and a
 * monospace tagline. Used on the auth screen and as the marketing lockup.
 */
export function BrandLockup({ tagline = "Multi-host Docker ops", titleAs = "strong" }: BrandLockupProps) {
  const Title = titleAs;

  return (
    <div className="brandLockup">
      <span className="brandLockupTile" aria-hidden>
        <BrandMark size={30} />
      </span>
      <span className="brandLockupText">
        <Title className="brandLockupTitle">ComposeBastion</Title>
        <small>{tagline}</small>
      </span>
    </div>
  );
}
