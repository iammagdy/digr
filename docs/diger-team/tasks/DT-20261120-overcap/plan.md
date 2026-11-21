# الحجز ضمن الرصيد والحد الأقصى

أثبت اختبار الجودة أن رصيد ٢٬٦٦٨ نقطة لا يغطي الحجز المعروض بقيمة ٢٬٩٨٠ نقطة. يحسب الخادم العدد المناسب من الخطة المحفوظة، ويعيد التحقق من الرصيد وسعر الحجز قبل اعتمادها. لا يغيّر اختيار العدد الرصيد. إذا تغيّرت الخطة أو الرصيد، يطلب التطبيق مراجعة السعر المعروض قبل الاعتماد.

- Approval design inherited from [PR #608](https://github.com/iammagdy/digr/pull/608) at `b28ea11607b5c44533844b4ce6e83a86a0a053dc`. Implementation base `4dcdb14c718515535c946a7a8a5100e617247489` has the same tree and inherits T2 from `a31808c59e174283f6a456930a4bb2fc1e6584e6`.
- The synthetic two-stage case compares the displayed 2,980-point hold with 2,698 for nine and 2,417 for eight. The live evidence does not establish an exact maximum for the original request.
- The plan version and server-issued offer must match before saving. A later click must approve the new version. A verified locked preview cannot enter quote creation. An uncertain approval is resolved using the existing atomic quote/job link.
- D-0170 through D-0172 define the reviewed file scope. Pre-push review and QA apply to the exact final commit. Roll back through Commander by reverting this PR while leaving #608 in place.
