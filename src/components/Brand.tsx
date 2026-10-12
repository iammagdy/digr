/* Official Digr logos from /public/brand — never redrawn or recolored.
   Both variants are rendered; CSS shows the one matching [data-theme]. */

export function Wordmark({ height = 28, className = "" }: { height?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} dir="ltr">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/digr-wordmark.svg" alt="Digr" height={height} style={{ height }} className="block [[data-theme=dark]_&]:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/digr-wordmark-white.svg" alt="Digr" height={height} style={{ height }} className="hidden [[data-theme=dark]_&]:block" />
    </span>
  );
}

export function Mark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} dir="ltr">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/digr-mark.svg" alt="Digr" width={size} height={size} style={{ height: size, width: size }} className="block [[data-theme=dark]_&]:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/digr-mark-white.svg" alt="Digr" width={size} height={size} style={{ height: size, width: size }} className="hidden [[data-theme=dark]_&]:block" />
    </span>
  );
}
