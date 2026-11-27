import { NextResponse } from "next/server";
import { readDeliveredWorkbook } from "../agentMission/deliveredWorkbook";
import {
  readDeliveredTable,
  deliveredShapedXlsx,
  deliveredShapedCsv,
} from "../agentMission/deliveredTable";
import { decodeFileSpec, validateFileSpec } from "../fileSpec";
import { missionDownloadName } from "../agentMission/fileNames";
import { fileResponseFromBytes } from "./fileResponse";
import { NO_RELEASABLE_RESULT_AR } from "../producedFormats";
import { FileShapeError } from "../../functions/shared/fileGenerators";

export const DELIVERED_SHAPE_TOO_LARGE_AR =
  "ملفك كبير جدًا لتنسيقه هنا. الملف الأصلي متاح للتحميل كما هو، ولم يُخصم أي رصيد.";

export async function shapedDeliveryResponse(
  adminClient: any,
  job: any,
  options: {
    format: string;
    specParam: string;
  }
): Promise<Response> {
  const { format, specParam } = options;

  if (format !== "xlsx" && format !== "csv") {
    return NextResponse.json({ success: false, error: "صيغة الملف غير مدعومة" }, { status: 400 });
  }

  const wbResult = await readDeliveredWorkbook(adminClient, { job });
  if (!wbResult.ok) {
    switch (wbResult.reason) {
      case "not_found":
        return NextResponse.json(
          { success: false, error: "الملف المطلوب غير جاهز للتحميل بعد أو انتهت صلاحيته." },
          { status: 404 }
        );
      case "not_released":
        return NextResponse.json({ success: false, error: NO_RELEASABLE_RESULT_AR }, { status: 409 });
      case "hash_mismatch":
        return NextResponse.json({ success: false, error: "تعذر قراءة بيانات هذا الطلب." }, { status: 404 });
      case "storage":
        return NextResponse.json({ success: false, error: "تعذر قراءة بيانات هذا الطلب." }, { status: 502 });
      case "too_large":
        return NextResponse.json({ success: false, error: DELIVERED_SHAPE_TOO_LARGE_AR }, { status: 413 });
    }
  }

  const table = await readDeliveredTable(wbResult.bytes);
  if ("error" in table) {
    if (table.error === "too_many_rows") {
      return NextResponse.json({ success: false, error: DELIVERED_SHAPE_TOO_LARGE_AR }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: "تعذر قراءة بيانات هذا الطلب." }, { status: 500 });
  }

  const decoded = decodeFileSpec(specParam);
  const validation = validateFileSpec(decoded, table.columns);
  if (!validation.ok) {
    return NextResponse.json({ success: false, error: validation.errorAr }, { status: 400 });
  }

  let body: Buffer;
  try {
    if (format === "xlsx") {
      body = await deliveredShapedXlsx(table, validation.spec);
    } else {
      body = await deliveredShapedCsv(table, validation.spec);
    }
  } catch (err) {
    if (err instanceof FileShapeError) {
      return NextResponse.json({ success: false, error: err.messageAr }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: "تعذر قراءة بيانات هذا الطلب." }, { status: 500 });
  }

  let downloadFileName = missionDownloadName({
    files: wbResult.mission?.files,
    kind: format,
    plan: wbResult.mission?.plan,
    requestText: wbResult.mission?.request_text,
    deliveredUnits: Number(wbResult.mission?.delivered_units) || Number(job.delivered_units) || 0,
    date: new Date(wbResult.mission?.updated_at || job.finished_at || job.created_at || Date.now()),
  });

  const ext = `.${format}`;
  const suffix = table.sheetCount > 1 ? ` - مخصص - ${table.sheetName}${ext}` : ` - مخصص${ext}`;
  downloadFileName = downloadFileName.replace(/(\.[a-z0-9]+)$/i, suffix);

  return fileResponseFromBytes(body, downloadFileName);
}
