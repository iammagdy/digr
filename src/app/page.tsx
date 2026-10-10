"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface DemoState {
  step: "typing" | "plan" | "extracting" | "ready";
  typedText: string;
}

export default function LandingPage() {
  // Interactive Live Demo State
  const [demoState, setDemoState] = useState<DemoState>({
    step: "typing",
    typedText: "",
  });
  const [activeFaq, setActiveFaq] = useState<number | null>(null);

  const fullPromptText = "استخرج لي بيانات حساب @unicef على تيك توك مع الإحصائيات العامة";

  // Simulate typing sequence for the interactive hero demo
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (demoState.step === "typing") {
      if (demoState.typedText.length < fullPromptText.length) {
        timer = setTimeout(() => {
          setDemoState((prev) => ({
            ...prev,
            typedText: fullPromptText.slice(0, prev.typedText.length + 1),
          }));
        }, 35);
      } else {
        timer = setTimeout(() => {
          setDemoState((prev) => ({ ...prev, step: "plan" }));
        }, 600);
      }
    }
    return () => clearTimeout(timer);
  }, [demoState.step, demoState.typedText, fullPromptText]);

  const handleStartExtraction = () => {
    setDemoState((prev) => ({ ...prev, step: "extracting" }));
    setTimeout(() => {
      setDemoState((prev) => ({ ...prev, step: "ready" }));
    }, 1200);
  };

  const handleResetDemo = () => {
    setDemoState({
      step: "typing",
      typedText: "",
    });
  };

  const toggleFaq = (index: number) => {
    setActiveFaq(activeFaq === index ? null : index);
  };

  return (
    <div className="min-h-screen flex flex-col bg-sand-50 text-ink-800">
      {/* Top Header Navigation */}
      <header className="sticky top-0 z-30 border-b border-sand-200/80 bg-sand-50/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 sm:px-6 h-16">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink-900">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-900 text-sm font-semibold text-white">
                دِ
              </span>
              <span>Digr</span>
            </Link>

            <nav className="hidden md:flex items-center gap-6 text-sm text-ink-600 font-medium">
              <a href="#how-it-works" className="hover:text-ink-900 transition-colors">
                كيف تعمل المنصة
              </a>
              <a href="#pricing" className="hover:text-ink-900 transition-colors">
                الأسعار والنقاط
              </a>
              <a href="#faq" className="hover:text-ink-900 transition-colors">
                الأسئلة الشائعة
              </a>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="touch-target inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-ink-700 hover:text-ink-900 transition-colors"
            >
              تسجيل الدخول
            </Link>
            <Link
              href="/register"
              className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-ink-800 transition-all active:scale-[0.98]"
            >
              إنشاء حساب
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative overflow-hidden pt-12 pb-16 sm:pt-20 sm:pb-24 border-b border-sand-200/70">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
              {/* Value Proposition */}
              <div className="lg:col-span-6 space-y-6 text-right">
                <div className="inline-flex items-center gap-2 rounded-full border border-sand-300/80 bg-sand-100/80 px-3.5 py-1 text-xs font-medium text-ink-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span>منصة عربية ذكية لاستخراج البيانات العامة</span>
                </div>

                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-ink-900 leading-[1.25]">
                  بيانات عامة موثوقة وجاهزة للتحليل في متناول يدك
                </h1>

                <p className="text-base sm:text-lg text-ink-600 leading-relaxed max-w-xl">
                  صُممت دِجر لمساعدة الباحثين، المحللين، وطلاب الدراسات العليا على جمع البيانات العامة من المنصات الرقمية. صف حاجتك بالعربية، راجع الخطة والتكلفة بالنقاط، واستلم ملفاتك بجداول Excel وتقارير PDF مع دليل المتغيرات ومنهجية الجمع.
                </p>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
                  <Link
                    href="/register"
                    className="touch-target inline-flex items-center justify-center rounded-xl bg-ink-900 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-ink-800 transition-all text-center"
                  >
                    ابدأ تجربتك الآن
                  </Link>
                  <a
                    href="#live-demo"
                    className="touch-target inline-flex items-center justify-center rounded-xl border border-sand-300 bg-white px-6 py-3.5 text-base font-medium text-ink-700 hover:bg-sand-100 transition-colors text-center"
                  >
                    معاينة حية للمساعد
                  </a>
                </div>

                {/* Reassurance pills */}
                <div className="grid grid-cols-3 gap-2 pt-4 border-t border-sand-200/70 text-xs text-ink-600">
                  <div className="flex flex-col">
                    <span className="font-semibold text-ink-900">تسعير بالنقاط</span>
                    <span className="text-[11px] text-ink-500">1 نقطة = 0.10 ج.م</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-semibold text-ink-900">حجز مؤمن</span>
                    <span className="text-[11px] text-ink-500">خصم فقط عند التسليم</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-semibold text-ink-900">شحن Instapay</span>
                    <span className="text-[11px] text-ink-500">مباشر وفوري بمصر</span>
                  </div>
                </div>
              </div>

              {/* Interactive Live Demo Window */}
              <div id="live-demo" className="lg:col-span-6">
                <div className="rounded-2xl border border-sand-300/90 bg-white shadow-sm overflow-hidden">
                  {/* Window Bar */}
                  <div className="flex items-center justify-between border-b border-sand-200 bg-sand-100/60 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full bg-sand-300" />
                      <span className="h-3 w-3 rounded-full bg-sand-300" />
                      <span className="h-3 w-3 rounded-full bg-sand-300" />
                      <span className="mr-2 text-xs font-medium text-ink-600">تجربة تفاعلية للمساعد الذكي</span>
                    </div>

                    <button
                      onClick={handleResetDemo}
                      className="text-xs text-ink-500 hover:text-ink-900 font-medium transition-colors"
                      title="إعادة تشغيل المحاكاة"
                    >
                      إعادة العرض ⟳
                    </button>
                  </div>

                  {/* Demo Content Area */}
                  <div className="p-5 space-y-4 min-h-[380px] flex flex-col justify-between">
                    {/* Conversation Sequence */}
                    <div className="space-y-4">
                      {/* User Request Bubble */}
                      <div className="flex flex-col items-start">
                        <span className="text-[11px] font-medium text-ink-400 mb-1">طلب الباحث</span>
                        <div className="rounded-2xl rounded-tr-xs bg-ink-900 px-4 py-2.5 text-sm text-white max-w-[90%] shadow-2xs">
                          {demoState.typedText}
                          {demoState.step === "typing" && (
                            <span className="inline-block w-1.5 h-4 mr-1 bg-white animate-pulse align-middle" />
                          )}
                        </div>
                      </div>

                      {/* Assistant Plan Card (Appears after typing) */}
                      {demoState.step !== "typing" && (
                        <div className="flex flex-col items-end animate-in fade-in slide-in-from-bottom-2 duration-300">
                          <span className="text-[11px] font-medium text-ink-400 mb-1">المساعد الذكي — خطة العمل المعتمدة</span>
                          <div className="w-full rounded-2xl border border-sand-200 bg-sand-50/70 p-4 text-right space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-ink-900">خطة استخراج ملف تيك توك</span>
                              <span className="rounded-full bg-amber-100 border border-amber-200 px-2.5 py-0.5 text-xs font-bold text-amber-800">
                                2 نقطة (0.20 ج.م)
                              </span>
                            </div>

                            <p className="text-xs text-ink-600 leading-relaxed">
                              استخراج البيانات الشاملة للحساب العام <strong>@unicef</strong>: المتابعين، الإعجابات، حالة التوثيق، والرابط التعريفي.
                            </p>

                            <div className="flex items-center gap-2 text-xs text-ink-500">
                              <span>الصيغ المستلمة:</span>
                              <span className="rounded bg-white px-2 py-0.5 border border-sand-200 font-mono text-[11px]">Excel (.xlsx)</span>
                              <span className="rounded bg-white px-2 py-0.5 border border-sand-200 font-mono text-[11px]">PDF (.pdf)</span>
                              <span className="rounded bg-white px-2 py-0.5 border border-sand-200 font-mono text-[11px]">CSV (.csv)</span>
                            </div>

                            {/* Execution Action Button */}
                            {demoState.step === "plan" && (
                              <button
                                onClick={handleStartExtraction}
                                className="touch-target w-full rounded-xl bg-ink-900 px-4 py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-ink-800 transition-all flex items-center justify-center gap-2"
                              >
                                <span>بدء الاستخراج وتجهيز الملفات</span>
                                <span className="text-sand-400">←</span>
                              </button>
                            )}

                            {/* Extracting Indicator */}
                            {demoState.step === "extracting" && (
                              <div className="rounded-xl border border-blue-200 bg-blue-50/80 p-3 text-center space-y-2">
                                <div className="flex items-center justify-center gap-2 text-xs font-medium text-blue-700">
                                  <span className="h-2 w-2 rounded-full bg-blue-600 animate-ping" />
                                  <span>جاري جمع البيانات وإنشاء الملفات الحسابية...</span>
                                </div>
                              </div>
                            )}

                            {/* Completed Result Card */}
                            {demoState.step === "ready" && (
                              <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-3 text-right space-y-2.5 animate-in fade-in duration-300">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-bold text-emerald-800">✓ اكتمل الاستخراج بنجاح (سجل 1)</span>
                                  <span className="text-[11px] text-emerald-700">خصم فعلي: 2 نقطة</span>
                                </div>

                                {/* Mini Table Preview */}
                                <div className="rounded-lg bg-white border border-sand-200 p-2 overflow-x-auto text-[11px]">
                                  <table className="w-full text-right">
                                    <thead>
                                      <tr className="border-b border-sand-100 text-ink-400 font-normal">
                                        <th className="pb-1">المعرف</th>
                                        <th className="pb-1">المتابعون</th>
                                        <th className="pb-1">الإعجابات</th>
                                        <th className="pb-1">التوثيق</th>
                                      </tr>
                                    </thead>
                                    <tbody className="font-mono text-ink-800">
                                      <tr>
                                        <td className="pt-1 font-semibold">@unicef</td>
                                        <td className="pt-1">1,240,500</td>
                                        <td className="pt-1">18,920,100</td>
                                        <td className="pt-1 text-emerald-600">موثق ✓</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>

                                {/* Download Action Buttons */}
                                <div className="flex items-center gap-2 pt-1">
                                  <span className="text-[11px] text-ink-500">تحميل النتيجة:</span>
                                  <button
                                    onClick={() => alert("في النسخة الحية يمكنك تنزيل ملف Excel الكامل مع ورقة الدليل ومنهجية الجمع.")}
                                    className="rounded-md bg-emerald-700 hover:bg-emerald-800 text-white px-2.5 py-1 text-[11px] font-semibold transition-colors"
                                  >
                                    Excel (.xlsx)
                                  </button>
                                  <button
                                    onClick={() => alert("في النسخة الحية يمكنك تنزيل تقرير PDF التنفيذي الجاهز للطباعة.")}
                                    className="rounded-md bg-rose-700 hover:bg-rose-800 text-white px-2.5 py-1 text-[11px] font-semibold transition-colors"
                                  >
                                    PDF (.pdf)
                                  </button>
                                  <button
                                    onClick={() => alert("في النسخة الحية يمكنك تنزيل ملف CSV المرمّز بـ UTF-8 BOM.")}
                                    className="rounded-md bg-sky-700 hover:bg-sky-800 text-white px-2.5 py-1 text-[11px] font-semibold transition-colors"
                                  >
                                    CSV (.csv)
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="pt-2 text-center text-xs text-ink-400 border-t border-sand-100">
                      هذا العرض التفاعلي يحاكي تماماً تدفق العمل الحقيقي داخل منصة Digr
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="py-16 sm:py-20 border-b border-sand-200/70 bg-white">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="text-center max-w-2xl mx-auto mb-12">
              <span className="text-xs font-bold text-amber-points tracking-wider">خطوات واضحة وبسيطة</span>
              <h2 className="text-2xl sm:text-3xl font-bold text-ink-900 mt-2">
                كيف تحصل على بياناتك في ثلاث خطوات؟
              </h2>
              <p className="text-sm sm:text-base text-ink-600 mt-3">
                لا قوالب معقدة ولا واجهات برمجية مشتتة. اكتب ما تحتاجه بلغتك اليومية، ودع المنصة تتولى الباقي.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Step 1 */}
              <div className="rounded-2xl border border-sand-200 bg-sand-50/60 p-6 space-y-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink-900 text-white font-bold text-sm">
                  1
                </div>
                <h3 className="text-lg font-bold text-ink-900">صف حاجتك باللغة الطبيعية</h3>
                <p className="text-sm text-ink-600 leading-relaxed">
                  اكتب في محادثة المساعد الحساب أو الموضوع أو الكلمات المفتاحية التي تود دراستها. المساعد الذكي يحلل طلبك ويحدد المصادر العامة المناسبة.
                </p>
              </div>

              {/* Step 2 */}
              <div className="rounded-2xl border border-sand-200 bg-sand-50/60 p-6 space-y-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink-900 text-white font-bold text-sm">
                  2
                </div>
                <h3 className="text-lg font-bold text-ink-900">راجع واعتمد الخطة والتكلفة</h3>
                <p className="text-sm text-ink-600 leading-relaxed">
                  يعرض المساعد بطاقة خطة شفافة تبين سقف السجلات، السعر بالنقاط، والصيغ. يمكنك تعديل الخطة بالدردشة أو مباشرة من البطاقة قبل خصم أي نقطة.
                </p>
              </div>

              {/* Step 3 */}
              <div className="rounded-2xl border border-sand-200 bg-sand-50/60 p-6 space-y-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink-900 text-white font-bold text-sm">
                  3
                </div>
                <h3 className="text-lg font-bold text-ink-900">استلم ملفات جاهزة للتحليل</h3>
                <p className="text-sm text-ink-600 leading-relaxed">
                  يبدأ الاستخراج فور موافقتك. فور الانتهاء تُسلّم لك حزمة متكاملة: ملف Excel احترافي مع دليل المتغيرات، تقرير PDF تنفيذي، وملف CSV.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Transparent Pricing Section */}
        <section id="pricing" className="py-16 sm:py-20 border-b border-sand-200/70">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="rounded-3xl border border-sand-300 bg-white p-8 sm:p-12 shadow-xs">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
                <div className="lg:col-span-7 space-y-4 text-right">
                  <span className="text-xs font-bold text-amber-points tracking-wider">تسعير عادل وشفاف</span>
                  <h2 className="text-2xl sm:text-3xl font-bold text-ink-900">
                    ادفع فقط مقابل ما يُسلّم فعلياً
                  </h2>
                  <p className="text-sm sm:text-base text-ink-600 leading-relaxed">
                    لا اشتراكات شهرية إجبارية ولا باقات تلزمك بما لا تحتاجه. يتم الحساب بنقاط رصيد مسبقة الدفع، مع ضمان استرداد فوري لأي حجز زائد في حال سُلّم عدد سجلات أقل من السقف المحدد.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                    <div className="rounded-xl border border-sand-200 bg-sand-50 p-4">
                      <span className="text-xs text-ink-500 font-medium">سعر النقطة المعتمد:</span>
                      <p className="text-xl font-bold text-ink-900 mt-1">1 نقطة = 0.10 جنيه مصري</p>
                      <p className="text-xs text-ink-500 mt-0.5">10 جنيهات تمنحك 100 نقطة رصيد</p>
                    </div>

                    <div className="rounded-xl border border-sand-200 bg-sand-50 p-4">
                      <span className="text-xs text-ink-500 font-medium">وسيلة الدفع:</span>
                      <p className="text-xl font-bold text-ink-900 mt-1">Instapay</p>
                      <p className="text-xs text-ink-500 mt-0.5">شحن فوري ومتاح من أي بنك داخل مصر</p>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-5 rounded-2xl border border-sand-200 bg-sand-50/80 p-6 space-y-4">
                  <h3 className="font-bold text-ink-900 text-sm">مزايا حزمة البيانات المستلمة:</h3>
                  <ul className="space-y-3 text-xs sm:text-sm text-ink-700">
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-bold">✓</span>
                      <span><strong>ملف Excel متعدد الأوراق:</strong> ورقة البيانات الخام + ورقة دليل المتغيرات ومنهجية الجمع.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-bold">✓</span>
                      <span><strong>تقرير تنفيذي بصيغة PDF:</strong> إحصائيات بصرية وجداول ملخصة جاهزة للطباعة والعرض.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-bold">✓</span>
                      <span><strong>ملف CSV نظيف:</strong> متوافق مع R و SPSS و Python و Pandas.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-bold">✓</span>
                      <span><strong>حماية الرصيد:</strong> حجز مبدئي مؤمن، والخصم النهائي دقيق حسب السجلات المسلمة.</span>
                    </li>
                  </ul>

                  <div className="pt-2">
                    <Link
                      href="/register"
                      className="touch-target w-full inline-flex items-center justify-center rounded-xl bg-ink-900 px-4 py-3 text-sm font-semibold text-white hover:bg-ink-800 transition-all text-center"
                    >
                      إنشاء حساب مجاني وبدء الشحن
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ Section */}
        <section id="faq" className="py-16 sm:py-20 bg-white">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 text-right">
            <div className="text-center max-w-xl mx-auto mb-10">
              <span className="text-xs font-bold text-amber-points tracking-wider">إجابات واضحة</span>
              <h2 className="text-2xl sm:text-3xl font-bold text-ink-900 mt-2">الأسئلة الشائعة</h2>
            </div>

            <div className="space-y-3">
              {[
                {
                  q: "هل استخراج البيانات العامة عبر Digr قانوني؟",
                  a: "نعم تماماً. تقوم المنصة حصراً بجمع وإعادة ترتيب البيانات العامة المتاحة علناً للجميع على شبكة الإنترنت بدون اختراق أو تجاوز لخصوصية المستخدمين، بما يتوافق مع المعايير الأخلاقية والأكاديمية للبحث العلمي.",
                },
                {
                  q: "كيف يتم حساب تكلفة طلب البيانات بالنقاط؟",
                  a: "يقوم المساعد الذكي بحساب التكلفة مسبقاً بناءً على عدد السجلات ونوع المنصة. 1 نقطة تعادل 0.10 جنيه مصري. يتم حجز رصيد الطلب مؤقتاً، ولا يتم الخصم الفعلي إلا بعد تسليم السجلات، وأي فائض يُرد لمحفظتك فوراً.",
                },
                {
                  q: "ما هي الصيغ والملفات التي أستلمها عند اكتمال الطلب؟",
                  a: "لكل طلب مكتمل تستلم 3 ملفات متكاملة: ملف Excel (.xlsx) يحتوي على ورقتين (البيانات والدليل المنهجي)، ملف PDF (.pdf) يحوي ملخصاً تنفيذياً ورسوماً إحصائية، وملف CSV (.csv) بترميز UTF-8 لدعم التحليل الإحصائي البرمجي.",
                },
                {
                  q: "كيف يتم شحن الرصيد عن طريق تطبيق Instapay؟",
                  a: "من صفحة شحن الرصيد داخل المنصة، تجد عنوان الدفع ورقم الهاتف المعتمدين لـ Digr. بعد التحويل من تطبيق انستاباي، تضع رقم العملية المرجعي وصورة الإيصال، وتتم مراجعته واعتماد الرصيد لمحفظتك خلال دقائق.",
                },
              ].map((item, idx) => (
                <div
                  key={idx}
                  className="rounded-2xl border border-sand-200 bg-sand-50/50 overflow-hidden transition-all"
                >
                  <button
                    onClick={() => toggleFaq(idx)}
                    className="touch-target w-full flex items-center justify-between p-5 text-right font-semibold text-sm sm:text-base text-ink-900 hover:text-ink-700 transition-colors"
                  >
                    <span>{item.q}</span>
                    <span className="text-lg font-mono text-ink-400">
                      {activeFaq === idx ? "−" : "+"}
                    </span>
                  </button>

                  {activeFaq === idx && (
                    <div className="px-5 pb-5 text-xs sm:text-sm text-ink-600 leading-relaxed border-t border-sand-200/60 pt-3">
                      {item.a}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-sand-200 bg-sand-100/50 py-10">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-500">
          <div className="flex items-center gap-3">
            <span className="font-bold text-ink-900">Digr</span>
            <span>—</span>
            <span>بيانات جاهزة للتحليل للباحثين والإحصائيين</span>
          </div>

          <div className="flex items-center gap-6">
            <Link href="/login" className="hover:text-ink-900 transition-colors">
              تسجيل الدخول
            </Link>
            <Link href="/register" className="hover:text-ink-900 transition-colors">
              حساب جديد
            </Link>
            <span>© {new Date().getFullYear()} Digr. جميع الحقوق محفوظة.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
