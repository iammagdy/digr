import Image from "next/image";

type BrandLogoProps = {
  size?: "small" | "medium" | "large";
  tone?: "adaptive" | "inverse" | "light" | "dark";
  className?: string;
};

const sizeClasses = {
  small: "h-6",
  medium: "h-8",
  large: "h-9",
};

export function BrandLogo({ size = "medium", tone = "adaptive", className = "" }: BrandLogoProps) {
  const imageClassName = `block w-auto ${sizeClasses[size]} ${className}`;
  const light = <Image src="/brand/digr-wordmark.svg" alt="" width={156} height={72} unoptimized className={imageClassName} data-brand-logo-light />;
  const dark = <Image src="/brand/digr-wordmark-white.svg" alt="" width={156} height={72} unoptimized className={imageClassName} data-brand-logo-dark />;

  if (tone === "inverse") return dark;
  if (tone === "light") return light;
  if (tone === "dark") return dark;
  return <span className="inline-flex items-center" data-brand-adaptive>{light}{dark}</span>;
}
