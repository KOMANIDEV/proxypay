import { runSnapshotJob } from "../jobs/snapshotJob";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Triggering manual snapshot...");
  try {
    await runSnapshotJob();
    console.log("Manual snapshot triggered successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Manual snapshot failed:", error);
    process.exit(1);
  }
}

main();
