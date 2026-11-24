import Image from "next/image";

/** Official H-Pharmacy logo (public/h-pharmacy-logo.png, 985 × 503), shown uncropped. */
export const LOGO = { src: "/h-pharmacy-logo.png", width: 985, height: 503 } as const;

/**
 * Header branding: the full logo at its natural aspect ratio, plus an
 * optional area label ("Customer support", "Support inbox").
 * `className` sets the logo height; the width follows the image's ratio.
 */
export function Brand({
  subtitle,
  className = "h-11",
  subtitleOnMobile = true,
}: {
  subtitle?: React.ReactNode;
  className?: string;
  /** Header use: hide the label on phones so the full logo has the room. */
  subtitleOnMobile?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Image
        src={LOGO.src}
        width={LOGO.width}
        height={LOGO.height}
        alt="H-Pharmacy"
        priority
        unoptimized
        className={`w-auto max-w-none shrink-0 ${className}`}
      />
      {subtitle ? (
        <span className={`${subtitleOnMobile ? "" : "hidden sm:block"} min-w-0 truncate border-l border-line pl-2.5 text-xs leading-tight text-muted`}>{subtitle}</span>
      ) : null}
    </div>
  );
}
