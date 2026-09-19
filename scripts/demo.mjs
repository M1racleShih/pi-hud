import { writeFileSync } from "node:fs";
import { renderPreview } from "./preview.mjs";

// Synthetic fixtures rendered by the production renderer; not a captured Pi session.
const output = renderPreview();
const destination = process.argv[process.argv.indexOf("--write") + 1];
if (process.argv.includes("--write") && destination) {
  writeFileSync(destination, output);
  console.log(`Wrote ${destination} (${output.length} bytes)`);
} else {
  process.stdout.write(output);
}
