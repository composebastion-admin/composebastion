import { BrandMark } from "./ui/BrandMark.js";

export function LoadingBoot() {
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="bootInner">
        <span className="bootMark">
          <BrandMark size={36} />
        </span>
        <span className="bootWord">ComposeBastion</span>
      </div>
    </div>
  );
}
