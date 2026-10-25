"use client";

import { useEffect, useState } from "react";

/**
 * The round account picture: the picture when there is one, the letters of the name otherwise. The letters stay until the picture has loaded, and
 * come back if it fails to load (an expired address); nothing here shows an address or an id.
 */
export function Avatar({ letters, url, size = 36, fontSize = 13, className = "" }: { letters: string; url?: string | null; size?: number; fontSize?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setBroken(false); setLoaded(false); }, [url]);
  return (
    <span
      data-testid="avatar"
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ac font-semibold text-onac ${className}`}
      style={{ width: size, height: size, fontSize }}
    >
      <span className={loaded && !broken ? "invisible" : undefined}>{letters}</span>
      {url && !broken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" aria-hidden="true" width={size} height={size} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />
      )}
    </span>
  );
}
