import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

// The example on each page is the code the playground executes, so an identifier it cannot
// resolve is a broken example, not a cosmetic issue. Several imported examples used to reference
// variables that never existed (`collection`, `layout`, `tileUrls`) or literal `/* placeholder */`
// comments; nothing caught that while the example was only ever read.
// The example is now the whole program: it creates its own map and declares its own demo data,
// so the only name the frame still adds is the namespace object. Keeping this list empty of
// data names is what stops an example from silently depending on the playground again.
const PLAYGROUND_SCOPE = ["Orihon"];
const BROWSER_GLOBALS = [
  "console", "document", "window", "navigator", "performance", "fetch", "structuredClone",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "queueMicrotask", "AbortController", "DOMParser", "URL", "URLSearchParams", "Blob", "Response",
  "createImageBitmap", "encodeURIComponent", "decodeURIComponent", "globalThis", "customElements"
];
const LANGUAGE_GLOBALS = [
  "Math", "JSON", "Object", "Array", "Number", "String", "Boolean", "Promise", "Date", "Set",
  "Map", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError", "Symbol", "BigInt", "Proxy",
  "Reflect", "Intl", "ArrayBuffer", "DataView", "Float32Array", "Float64Array", "Int8Array",
  "Int16Array", "Int32Array", "Uint8Array", "Uint16Array", "Uint32Array",
  "undefined", "NaN", "Infinity", "arguments"
];

function freeIdentifiers(code) {
  const source = ts.createSourceFile("example.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) {
    return { syntax: ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, " ") };
  }
  const declared = new Set();
  const used = new Set();
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isMemberName) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { free: [...used].filter((name) => !declared.has(name)) };
}

test("every guide example runs in the playground scope", async () => {
  const root = await import("../dist/full-entry.js");
  const optional = {};
  for (const entry of [
    "../dist/feature-source.js", "../dist/draw/index.js", "../dist/controls.js",
    "../dist/geo-entry.js", "../dist/popup-content.js",
    "../dist/layers/pmtiles.js", "../dist/layers/mlt.js"
  ]) Object.assign(optional, await import(entry));

  const available = new Set([
    ...Object.keys(root), ...Object.keys(optional),
    ...PLAYGROUND_SCOPE, ...BROWSER_GLOBALS, ...LANGUAGE_GLOBALS
  ]);
  const decode = (value) => value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const stripImports = (code) => code
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "");

  const failures = [];
  const names = readdirSync("examples/developer-guide/functions");
  for (const name of names) {
    const html = readFileSync(`examples/developer-guide/functions/${name}/index.html`, "utf8");
    const editor = html.match(/<textarea data-playground-code[^>]*>([\s\S]*?)<\/textarea>/);
    if (!editor) { failures.push(`${name}: page has no runnable example`); continue; }
    const code = stripImports(decode(editor[1]));
    if (/\/\*\s*[a-z]/i.test(code) && /\(\s*\/\*/.test(code)) {
      failures.push(`${name}: example still has placeholder arguments`);
      continue;
    }
    // The example is what a reader pastes into their own project, so it may not lean on the
    // frame: `showResult` does not exist there, and a top-level `return` is a syntax error.
    if (code.includes("showResult")) failures.push(`${name}: example calls the playground-only showResult()`);
    if (/^return\b/m.test(code)) failures.push(`${name}: example ends in a top-level return`);
    if (!/createMap\s*\(|console\s*\./.test(code)) failures.push(`${name}: example neither renders a map nor prints a result`);
    const { syntax, free } = freeIdentifiers(code);
    if (syntax) { failures.push(`${name}: ${syntax}`); continue; }
    const missing = free.filter((identifier) => !available.has(identifier));
    if (missing.length) failures.push(`${name}: undefined ${missing.join(", ")}`);
  }
  assert.deepEqual(failures, []);
  assert.ok(names.length >= 100, `unexpectedly few pages: ${names.length}`);
});

test("every guide example imports the names it uses from an entry that exports them", async () => {
  const entryModules = {
    "orihon": "../dist/standard.js",
    "orihon/advanced": "../dist/advanced-entry.js",
    "orihon/object-manager": "../dist/object-manager-entry.js",
    "orihon/locales": "../dist/locales-entry.js",
    "orihon/core": "../dist/core.js",
    "orihon/standard": "../dist/standard.js",
    "orihon/easy": "../dist/easy-entry.js",
    "orihon/source": "../dist/feature-source.js",
    "orihon/draw": "../dist/draw/index.js",
    "orihon/controls": "../dist/controls.js",
    "orihon/geo": "../dist/geo-entry.js",
    "orihon/popup-content": "../dist/popup-content.js",
    "orihon/pmtiles": "../dist/layers/pmtiles.js",
    "orihon/mlt": "../dist/layers/mlt.js"
  };
  const exportsOf = new Map();
  for (const [specifier, path] of Object.entries(entryModules)) {
    exportsOf.set(specifier, new Set(Object.keys(await import(path))));
  }

  const decode = (value) => value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const failures = [];
  for (const name of readdirSync("examples/developer-guide/functions")) {
    const html = readFileSync(`examples/developer-guide/functions/${name}/index.html`, "utf8");
    const code = decode(html.match(/<textarea data-playground-code[^>]*>([\s\S]*?)<\/textarea>/)[1]);
    for (const line of code.split("\n")) {
      const match = /^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(line);
      if (!match) continue;
      const available = exportsOf.get(match[2]);
      if (!available) { failures.push(`${name}: unknown entry ${match[2]}`); continue; }
      for (const imported of match[1].split(",").map((part) => part.trim()).filter(Boolean)) {
        if (!available.has(imported)) failures.push(`${name}: ${match[2]} does not export ${imported}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
