import archiver from "archiver";
import { createWriteStream } from "node:fs";

export async function createZipFile(sourceDir: string, outputPath: string) {
  return new Promise((res, rej) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(archive.pointer() + " total bytes");
      console.log(
        "archiver has been finalized and the output fDescriptor closed.",
      );
    });
    archive.on("error", (err) => rej(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}
