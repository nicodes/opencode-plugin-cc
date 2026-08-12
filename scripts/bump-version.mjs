#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const files = [
  { path: "package.json", fields: [["version"]] },
  { path: "plugins/opencode/.claude-plugin/plugin.json", fields: [["version"]] },
  { path: ".claude-plugin/marketplace.json", fields: [["metadata", "version"], ["plugins", 0, "version"]] }
];

function valueAt(object, field) {
  return field.reduce((value, key) => value?.[key], object);
}

function setAt(object, field, value) {
  const parent = field.slice(0, -1).reduce((current, key) => current[key], object);
  parent[field.at(-1)] = value;
}

function read(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const rootIndex = args.indexOf("--root");
  const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd());
  const positional = args.filter((arg, index) => !arg.startsWith("-") && index !== rootIndex + 1);
  const expected = positional[0] ?? (check ? read(root, "package.json").version : null);
  if (!expected || !VERSION.test(expected)) {
    throw new Error("Provide a valid semantic version, for example 0.2.0.");
  }

  const mismatches = [];
  for (const target of files) {
    const json = read(root, target.path);
    for (const field of target.fields) {
      if (check) {
        const actual = valueAt(json, field);
        if (actual !== expected) {
          mismatches.push(`${target.path} ${field.join(".")}: expected ${expected}, found ${actual}`);
        }
      } else {
        setAt(json, field, expected);
      }
    }
    if (!check) {
      fs.writeFileSync(path.join(root, target.path), `${JSON.stringify(json, null, 2)}\n`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
  }
  process.stdout.write(check ? `All version metadata matches ${expected}.\n` : `Set version metadata to ${expected}.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
