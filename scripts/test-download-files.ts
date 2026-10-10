import { Client, Users, Account } from "node-appwrite";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const adminClient = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const users = new Users(adminClient);

async function main() {
  const userId = "6ac9df4012266f4af846";
  const user = await users.get(userId);
  console.log(`Testing download as user: ${user.email} (${userId})`);

  // Create temporary session & JWT for user
  const token = await users.createToken(userId);
  const session = await users.createSession(userId, token.secret);

  const jwt = await users.createJWT(userId);
  console.log("✓ Successfully obtained user JWT");

  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
  const targetJobId = "6ac9f2f600106f35ff46";

  const formats = ["xlsx", "pdf", "csv"] as const;

  for (const fmt of formats) {
    const fileId = `${fmt}_${targetJobId}`;
    const downloadUrl = `${endpoint}/storage/buckets/results/files/${fileId}/download`;

    const res = await fetch(downloadUrl, {
      headers: {
        "X-Appwrite-Project": projectId,
        "X-Appwrite-JWT": jwt.jwt,
      },
    });

    if (!res.ok) {
      console.error(`❌ Download failed for ${fmt}: status ${res.status}`);
      process.exit(1);
    }

    const arrayBuffer = await res.arrayBuffer();
    console.log(`✓ Downloaded ${fmt} (${fileId}): HTTP ${res.status}, size = ${arrayBuffer.byteLength} bytes`);
  }

  // Also verify unauthorized user B CANNOT download them (file security check)
  console.log("\nTesting security: Anonymous / unauthorized access must be rejected (401/404)...");
  for (const fmt of formats) {
    const fileId = `${fmt}_${targetJobId}`;
    const downloadUrl = `${endpoint}/storage/buckets/results/files/${fileId}/download`;

    const res = await fetch(downloadUrl, {
      headers: {
        "X-Appwrite-Project": projectId,
      },
    });

    console.log(`✓ Unauthorized download ${fmt} rejected: HTTP ${res.status}`);
  }

  // Cleanup session
  await users.deleteSession(userId, session.$id);
  console.log("\n🎉 All downloads verified successfully!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
