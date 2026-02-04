import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("tracked inline examples and playground snippets have valid JavaScript syntax", () => {
  const root = new URL("../", import.meta.url);
  const files = execFileSync("git", ["ls-files", "-z", "examples", "test"], { cwd: root, encoding: "utf8" }).split("\0");
  const errors = [];
  function check(name, code) {
    const source = ts.createSourceFile(name + ".js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const diagnostic of source.parseDiagnostics) errors.push(`${name}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  for (const name of files.filter(name => name.endsWith(".html"))) {
    const html = readFileSync(new URL(name, root), "utf8");
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type=["']application\//.test(match[1]) || !match[2].trim()) continue;
      check(name, match[2]);
    }
  }
  const snippets = JSON.parse(readFileSync(new URL("docs/developer-guide/playground-examples.json", root), "utf8"));
  for (const [name, code] of Object.entries(snippets)) check(`playground:${name}`, code);
  assert.deepEqual(errors, []);
});
