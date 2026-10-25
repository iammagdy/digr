import Image from "next/image";
import { TOPUP_INSTAPAY_QR_SRC, TOPUP_INSTAPAY_URL } from "@/lib/topupConfig";

const QR_ALT_AR = "رمز الدفع عبر إنستاباي";
const QR_CAPTION_AR = "امسح الرمز من تطبيق إنستاباي";

/**
 * The link that opens InstaPay and the QR to scan from the InstaPay app. The QR is the owner's file served as it is (`unoptimized`: no re-encoding,
 * no resizing by the server), at a fixed 200 px box so nothing moves while it loads, on a white card in both themes with its own quiet zone kept:
 * no filter, no rounding of the image. The link is opened in a new tab and never hands the page to the destination.
 */
export function InstapayShortcuts() {
  return (
    <div data-testid="instapay-shortcuts" className="flex h-full flex-col items-center justify-center gap-4 rounded-[18px] border border-ln px-[18px] py-5 text-center">
      <figure className="m-0 flex flex-col items-center gap-2">
        <div className="rounded-xl bg-white p-2" style={{ colorScheme: "light" }}>
          <Image src={TOPUP_INSTAPAY_QR_SRC} alt={QR_ALT_AR} width={200} height={200} unoptimized data-testid="instapay-qr" className="block h-[200px] w-[200px] bg-white object-contain" />
        </div>
        <figcaption className="text-xs font-light text-mut">{QR_CAPTION_AR}</figcaption>
      </figure>
      <a
        href={TOPUP_INSTAPAY_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="instapay-link"
        className="flex min-h-11 items-center justify-center rounded-full border border-ln2 bg-sf px-5 text-[13px] font-semibold text-ink no-underline"
      >
        افتح إنستاباي للدفع
      </a>
    </div>
  );
}
