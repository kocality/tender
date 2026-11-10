// Node 18 has no global crypto.getRandomValues, so the CLI would die later with a cryptic noble error (CI-06).
// Every entry point imports this module first, so the check runs before any other module of the command.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Tender needs Node 20 or newer (found v${process.versions.node}). Install Node 24.22.2 (see .nvmrc).`);
  process.exit(1);
}
