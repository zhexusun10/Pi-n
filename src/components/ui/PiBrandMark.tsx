import React from "react";

interface PiBrandMarkProps {
  width?: number;
  height?: number;
  className?: string;
  monochrome?: boolean;
}

/**
 * Compact `pi^n` pixel mark derived from `assets/icon-dots.svg` (Concept 02):
 * Pi's three Bauhaus blocks paired with a tight superscript `n`, or a crisp
 * monochrome `currentColor` variant for typographic lockups.
 */
export const PiBrandMark: React.FC<PiBrandMarkProps> = ({
  width = 24,
  height = 20,
  className = "brand-mark",
  monochrome = false,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="42 80 428 352"
    aria-hidden="true"
    focusable="false"
  >
    <path fill={monochrome ? "currentColor" : "var(--pi-coral, #F09082)"} d="M42 80H306V256H218V168H42Z" />
    <path fill={monochrome ? "currentColor" : "var(--pi-blue, #4D9ABF)"} d="M42 168H130V256H218V344H130V432H42Z" />
    <path fill={monochrome ? "currentColor" : "var(--pi-yellow, #F1BE58)"} d="M306 256H394V432H306Z" />
    <path className={monochrome ? undefined : "brand-mark-exp"} fill={monochrome ? "currentColor" : undefined} d="M350 80H430V120H390V200H350Z" />
    <path className={monochrome ? undefined : "brand-mark-exp"} fill={monochrome ? "currentColor" : undefined} d="M430 120H470V200H430Z" />
  </svg>
);
