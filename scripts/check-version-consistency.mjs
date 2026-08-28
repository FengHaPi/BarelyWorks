import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const plugin = readJson(".codex-plugin/plugin.json");
const readme = fs.readFileSync("README.md", "utf8");
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");

const version = pkg.version;
const expectedTag = `v${version}`;
const errors = [];

if (plugin.version !== version) {
  errors.push(`.codex-plugin/plugin.json is ${plugin.version}, expected ${version}`);
}
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  errors.push(`package-lock.json does not match package.json version ${version}`);
}
if (!readme.includes(expectedTag)) {
  errors.push(`README.md does not mention current version ${expectedTag}`);
}
if (!changelog.includes(`## [${version}]`)) {
  errors.push(`CHANGELOG.md has no public release entry for ${version}`);
}

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== expectedTag) {
  errors.push(`Git tag ${process.env.GITHUB_REF_NAME} does not match package version ${expectedTag}`);
}

if (errors.length) {
  console.error("Version consistency check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Version metadata is consistent: ${expectedTag}`);
