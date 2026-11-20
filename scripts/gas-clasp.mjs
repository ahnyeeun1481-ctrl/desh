const usage = "사용법: node scripts/gas-clasp.mjs create|deploy|redeploy|open";
const command = process.argv[2];
const commands = new Set(["create", "deploy", "redeploy", "open"]);

if (!commands.has(command)) {
  console.error(usage);
  process.exitCode = 1;
}