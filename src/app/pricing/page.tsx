import { pointsAr } from "@/lib/pointsFormat";
import Link from "next/link";
import CapacityCalculator from "@/components/pricing/CapacityCalculator";
import { toArabicDigits } from "@/lib/arabicDigits";
import { minimumLineAr } from "@/lib/missionPricing";
import { CAPACITY_AMOUNTS_EGP, PEOPLE_PRICE_POINTS, PRICING_FAQ_AR, buildPriceRows, capacityForAmount, capacityLineAr, peoplePerRequestLineAr, pointsForAmountEgp } from "@/lib/pricingPage";
import { unitPriceLabelAr } from "@/lib/pointsFormat";

export const metadata = { title: "الأسعار", description: "كم يكلّف جمع البيانات في ديجر: سعر كل نوع بالنقاط، وما يغطيه كل مبلغ، وحدود الطلب الواحد." };

export default function PricingPage() {
  const rows = buildPriceRows();
  const peopleLine = peoplePerRequestLineAr();
  const capacity = CAPACITY_AMOUNTS_EGP.map((amount) => ({ amount, points: pointsForAmountEgp(amount), lines: capacityForAmount(amount) }));
  return (
    <main dir="rtl" lang="ar" className="min-h-dvh bg-bg px-5 py-12 font-sans text-ink">
      <div className="mx-auto flex max-w-[960px] flex-col gap-10">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ln pb-6">
          <div>
            <Link href="/" className="text-sm text-mut no-underline hover:text-ink">ديجر — الصفحة الرئيسية</Link>
            <h1 className="mb-0 mt-2 font-display text-[40px] font-medium leading-[1.2] text-ink">تدفع على ما يصلك فعلًا</h1>
            <p className="mb-0 mt-3 max-w-[620px] text-[15px] font-light leading-[2] text-ink2">رصيدك بالنقاط، ونقطة واحدة تساوي ٠٫١٠ ج.م. لا يُخصم شيء قبل موافقتك على الخطة، ولا يُخصم إلا مقابل السجلات المطابقة التي وصلتك. {minimumLineAr()}</p>
          </div>
          <Link href="/register" className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline">ابدأ بحسابك المجاني</Link>
        </header>

        <section aria-labelledby="capacity-title" className="flex flex-col gap-4">
          <h2 id="capacity-title" className="m-0 font-display text-[26px] font-medium">كم يغطي مبلغك؟</h2>
          <p className="m-0 text-sm font-light leading-[1.9] text-mut">الأرقام «حتى حوالي»: عدد السجلات التي يغطيها المبلغ بسعر السجل المُسلَّم، دون احتياطي الحجز. عند الموافقة يُحجز مؤقتًا احتياطي إضافي، وما لا يُستخدم منه حجز مؤقت مُحرَّر.</p>
          <div className="overflow-x-auto rounded-[20px] border border-ln bg-sf">
            <table data-testid="capacity-table" className="w-full min-w-[640px] border-collapse text-right text-[13px]">
              <thead>
                <tr className="border-b border-ln bg-sf2 text-ink">
                  <th className="px-4 py-3 font-semibold">النوع</th>
                  {capacity.map((column) => <th key={column.amount} className="px-4 py-3 font-semibold">{toArabicDigits(column.amount)} ج.م</th>)}
                </tr>
              </thead>
              <tbody>
                {capacity[0].lines.map((line, index) => (
                  <tr key={line.id} className="border-b border-ln last:border-0">
                    <td className="px-4 py-3 font-medium text-ink">{line.labelAr}</td>
                    {capacity.map((column) => <td key={column.amount} className="px-4 py-3 font-light text-ink2">{capacityLineAr(column.lines[index])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p data-testid="people-per-request-capacity" className="m-0 text-sm font-light leading-[1.9] text-mut">صنّاع القرار: {peopleLine}</p>
          <CapacityCalculator />
        </section>

        <section aria-labelledby="prices-title" className="flex flex-col gap-4">
          <h2 id="prices-title" className="m-0 font-display text-[26px] font-medium">سعر كل نوع</h2>
          <div className="overflow-x-auto rounded-[20px] border border-ln bg-sf">
            <table data-testid="price-table" className="w-full border-collapse text-right text-[13px]">
              <thead>
                <tr className="border-b border-ln bg-sf2 text-ink"><th className="px-4 py-3 font-semibold">النوع</th><th className="px-4 py-3 font-semibold">السعر</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-ln"><td className="px-4 py-3 font-medium text-ink">{row.labelAr}</td><td className="px-4 py-3 font-light text-ink2">{unitPriceLabelAr(row.unitPricePoints, row.unitLabelAr)}</td></tr>
                ))}
                <tr><td className="px-4 py-3 font-medium text-ink">صنّاع قرار</td><td className="px-4 py-3 font-light text-ink2">{pointsAr(PEOPLE_PRICE_POINTS.basePerson, toArabicDigits)} للشخص، و{toArabicDigits(PEOPLE_PRICE_POINTS.workEmail)} للبريد المهني، و{toArabicDigits(PEOPLE_PRICE_POINTS.phone)} للهاتف، عند توفرها فقط</td></tr>
              </tbody>
            </table>
          </div>
          <p data-testid="people-per-request-price" className="m-0 text-sm font-light leading-[1.9] text-mut">صنّاع القرار: {peopleLine}</p>
          <p className="m-0 text-sm font-light leading-[1.9] text-mut">هذه أسعار النقاط الحالية. الرقم النهائي لطلبك يظهر في خطتك قبل أن توافق. <Link href="/calculator" className="text-ink">جرّب الحاسبة على طلبك</Link>.</p>
        </section>

        <section aria-labelledby="limits-title" className="flex flex-col gap-3 rounded-[20px] border border-ln bg-sf2 p-6">
          <h2 id="limits-title" className="m-0 text-[18px] font-semibold">حدود نذكرها بصراحة</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm font-light leading-[1.9] text-ink2">
            <li>— لكل طلب حد أقصى للمبلغ المحجوز؛ الأحجام الكبيرة تُنفَّذ على أكثر من طلب.</li>
            <li>— قد يصلك أقل مما طلبت إن لم تتوفر سجلات كافية في المصدر، وتدفع مقابل ما وصل فقط.</li>
            <li>— نجمع من المصادر المتاحة علنًا فقط، ولا نصل إلى محتوى خاص.</li>
          </ul>
        </section>

        <section aria-labelledby="faq-title" className="flex flex-col gap-4">
          <h2 id="faq-title" className="m-0 font-display text-[26px] font-medium">أسئلة عن الأسعار</h2>
          {PRICING_FAQ_AR.map(([question, answer]) => (
            <div key={question} className="border-b border-ln pb-4">
              <h3 className="m-0 text-[16px] font-medium text-ink">{question}</h3>
              <p className="mb-0 mt-2 text-sm font-light leading-[1.9] text-mut">{answer}</p>
            </div>
          ))}
        </section>

        <div className="text-center">
          <Link href="/register" className="inline-flex min-h-12 items-center rounded-full bg-ac px-7 text-[15px] text-onac no-underline">ابدأ طلبك الأول</Link>
        </div>
      </div>
    </main>
  );
}
