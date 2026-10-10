import { Client, TablesDB, Storage, Permission, Role } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const endpoint = "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(client);
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
      platform: "Digr Data Platform",
      company: "Digr",
      title: `نتائج استخراج ملف تيك توك الشخصي (${profileData.nickname})`,
      template: "tiktok-profile",
      jobId,
      collectedAt: new Date().toISOString(),
      rowsCount: 1,
      methodology: `تم استخراج بيانات الحساب العام @${profileData.uniqueId} بنجاح بتاريخ 2026-10-10 من المصدر الرسمي. ملاحظة منهجية: هذه البيانات عامة ومتاحة علناً.`,
    },
    profile: profileData,
    rows: [
      {
        id: profileData.id,
        username: `@${profileData.uniqueId}`,
        displayName: profileData.nickname,
        bio: profileData.signature,
        verified: "لا",
        followers: profileData.followerCount,
        following: profileData.followingCount,
        likes: profileData.heartCount,
        videosCount: profileData.videoCount,
        bioLink: profileData.bioLink,
        profileUrl: profileData.profileUrl,
        collectedDate: profileData.collectedDate,
      },
    ],
  };

  const jsonFileId = `json_${jobId}`;
  const permissions = [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))];

  const uploadFile = new File(
    [new Uint8Array(Buffer.from(JSON.stringify(finalPayload, null, 2)))],
    `digr_tiktok-profile_${jobId}.json`,
    { type: "application/json" }
  );

  try {
    await storage.deleteFile({ bucketId: "results", fileId: jsonFileId });
  } catch {}

  await storage.createFile("results", jsonFileId, uploadFile, permissions);
  console.log(`✓ Uploaded ${jsonFileId} successfully!`);

  // Verify download
  const downloaded = await storage.getFileDownload("results", jsonFileId);
  console.log(`✓ Verified download: ${downloaded.byteLength} bytes`);
}

main().catch(console.error);
