import { Client, TablesDB, Storage, Permission, Role } from "node-appwrite";
import * as dotenv from "dotenv";
import {
  generateExcelReport,
  generatePdfReport,
  generateCsvReport,
} from "../src/functions/shared/fileGenerators";

dotenv.config({ path: ".env.local" });

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
  .setKey(process.env.APPWRITE_API_KEY!);

const tables = new TablesDB(client);
const storage = new Storage(client);

const TARGET_JOB_ID = "6ac9f2f600106f35ff46";

async function main() {
  console.log(`🚀 Starting retroactive file generation for job ${TARGET_JOB_ID}...`);

  // 1. Fetch job row
  const job: any = await tables.getRow({
    databaseId: "digr",
    tableId: "jobs",
    rowId: TARGET_JOB_ID,
  });

  console.log(`Found job: status=${job.status}, template=${job.templateSlug}, user=${job.userId}`);

  // 2. Download existing result payload from old file
  const oldFileId = job.resultFileId || "6ac9f2fc002eb79e53ef";
  console.log(`Fetching existing collected data from file ${oldFileId}...`);
  const rawPayload: any = await storage.getFileDownload({
    bucketId: "results",
    fileId: oldFileId,
  });

  console.log("Raw payload loaded successfully. Keys:", Object.keys(rawPayload));

  // 3. Generate XLSX, PDF, CSV buffers
  console.log("Generating white-label Excel (.xlsx) report...");
  const xlsxBuffer = await generateExcelReport(rawPayload);

  console.log("Generating white-label PDF (.pdf) report...");
  const pdfBuffer = await generatePdfReport(rawPayload);

  console.log("Generating white-label CSV (.csv) report...");
  const csvBuffer = generateCsvReport(rawPayload);

  console.log(`Sizes: XLSX=${xlsxBuffer.length}B, PDF=${pdfBuffer.length}B, CSV=${csvBuffer.length}B`);

  const xlsxFileId = `xlsx_${TARGET_JOB_ID}`;
  const pdfFileId = `pdf_${TARGET_JOB_ID}`;
  const csvFileId = `csv_${TARGET_JOB_ID}`;

  const permissions = [
    Permission.read(Role.user(job.userId)),
    Permission.read(Role.label("admin")),
  ];

  // 4. Upload files to results bucket (idempotently delete if already exists)
  const filesToUpload = [
    {
      id: xlsxFileId,
      name: `diger_${job.templateSlug}_${TARGET_JOB_ID}.xlsx`,
      buffer: xlsxBuffer,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      id: pdfFileId,
      name: `diger_${job.templateSlug}_${TARGET_JOB_ID}.pdf`,
      buffer: pdfBuffer,
      type: "application/pdf",
    },
    {
      id: csvFileId,
      name: `diger_${job.templateSlug}_${TARGET_JOB_ID}.csv`,
      buffer: csvBuffer,
      type: "text/csv; charset=utf-8",
    },
  ];

  for (const f of filesToUpload) {
    try {
      await storage.deleteFile({ bucketId: "results", fileId: f.id });
      console.log(`Deleted pre-existing file ${f.id}`);
    } catch {
      // File didn't exist yet, that's fine
    }

    const uploadFile = new File([f.buffer], f.name, { type: f.type });
    await storage.createFile(
      "results",
      f.id,
      uploadFile,
      permissions
    );
    console.log(`✓ Uploaded ${f.id} (${f.name})`);
  }

  // 5. Update job row with new primary resultFileId
  await tables.updateRow({
    databaseId: "digr",
    tableId: "jobs",
    rowId: TARGET_JOB_ID,
    data: {
      resultFileId: xlsxFileId,
    },
  });
  console.log(`✓ Updated job ${TARGET_JOB_ID} resultFileId to ${xlsxFileId}`);

  console.log("\n🎉 All 3 readable files uploaded and linked successfully!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
