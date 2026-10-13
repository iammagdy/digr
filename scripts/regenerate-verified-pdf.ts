import { Client, Storage, Permission, Role } from "node-appwrite";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { generatePdfReport } from "../src/functions/shared/fileGenerators";

dotenv.config({ path: ".env.local" });

const endpoint = "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const storage = new Storage(client);

async function main() {
  const jobId = "6aca1d11003678efd3c5";
  const userId = "6ac9df4012266f4af846";

  const profileData = {
    id: "6902366830754153474",
    uniqueId: "iam_megz",
    nickname: "MeGz",
    signature: "",
    verified: false,
    followerCount: 1488,
    followingCount: 317,
    heartCount: 14600,
    videoCount: 0,
    avatarUrl: "",
    bioLink: "",
    profileUrl: "https://www.tiktok.com/@iam_megz",
    collectedDate: "2026-10-10",
  };

  const finalPayload = {
    metadata: {
      platform: "Diger Data Platform",
      company: "Diger",
      title: `نتائج استخراج ملف تيك توك الشخصي (${profileData.nickname})`,
      template: "tiktok-profile",
      jobId,
      collectedAt: new Date().toISOString(),
      rowsCount: 1,
      methodology: `تم استخراج بيانات الحساب العام @${profileData.uniqueId} بنجاح بتاريخ 2026-10-10 من المصدر الرسمي. ملاحظة منهجية: هذه البيانات عامة ومتاحة علناً.`,
    },
    profile: profileData,
    rows: [],
  };

  console.log("Generating updated PDF...");
  const pdfBuf = await generatePdfReport(finalPayload);
  const pdfPath = path.resolve("artifacts_test/iam_megz_6aca1d11003678efd3c5.pdf");
  fs.writeFileSync(pdfPath, pdfBuf);
  console.log(`Saved locally to ${pdfPath} (${pdfBuf.length} bytes)`);

  const pdfFileId = `pdf_${jobId}`;
  const permissions = [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))];

  try {
    await storage.deleteFile({ bucketId: "results", fileId: pdfFileId });
  } catch {}

  await storage.createFile(
    "results",
    pdfFileId,
    new File([new Uint8Array(pdfBuf)], `diger_tiktok-profile_${jobId}.pdf`, { type: "application/pdf" }),
    permissions
  );
  console.log(`✓ Uploaded updated ${pdfFileId} to Storage results bucket!`);
}

main().catch(console.error);
