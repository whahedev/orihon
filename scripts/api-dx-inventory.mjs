import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const entries = Object.entries(pkg.exports)
  .filter(([, value]) => value && typeof value === "object" && typeof value.types === "string")
  .map(([entry, value]) => ({ entry: entry === "." ? "orihon" : `orihon${entry.slice(1)}`, file: path.resolve(root, value.types) }));
const files = entries.map(({ file }) => file);
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true
});
const checker = program.getTypeChecker();

function clean(text) {
  return text.replace(/\s+/g, " ").replace(/\s*;\s*$/, "").trim();
}

function typeText(type, node) {
  return clean(checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope));
}

function signaturesOf(type, kind, node) {
  return checker.getSignaturesOfType(type, kind).map((sig) => {
    const args = sig.parameters.map((parameter) => {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? node;
      return `${parameter.name}${parameter.flags & ts.SymbolFlags.Optional ? "?" : ""}: ${typeText(checker.getTypeOfSymbolAtLocation(parameter, declaration), declaration)}`;
    });
    return `(${args.join(", ")}) => ${typeText(checker.getReturnTypeOfSignature(sig), node)}`;
  });
}

function membersOf(type, node) {
  return checker.getPropertiesOfType(type).map((member) => {
    const declaration = member.valueDeclaration ?? member.declarations?.[0] ?? node;
    const memberType = checker.getTypeOfSymbolAtLocation(member, declaration);
    const calls = signaturesOf(memberType, ts.SignatureKind.Call, declaration);
    return {
      name: member.name,
      optional: Boolean(member.flags & ts.SymbolFlags.Optional),
      readonly: Boolean(member.declarations?.some((decl) => ts.canHaveModifiers(decl) && ts.getModifiers(decl)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword))),
      type: typeText(memberType, declaration),
      calls
    };
  });
}

const inventory = [];
for (const { entry, file } of entries) {
  const source = program.getSourceFile(file);
  if (!source) continue;
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) continue;
  for (const exported of checker.getExportsOfModule(moduleSymbol).sort((a, b) => a.name.localeCompare(b.name))) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? source;
    const valueType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    const calls = signaturesOf(valueType, ts.SignatureKind.Call, declaration);
    const constructs = signaturesOf(valueType, ts.SignatureKind.Construct, declaration);
    const isTypeLike = Boolean(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class | ts.SymbolFlags.Enum));
    const memberType = isTypeLike ? declaredType : valueType;
    inventory.push({
      entry,
      name: exported.name,
      kind: ts.SymbolFlags[symbol.flags & -symbol.flags] ?? String(symbol.flags),
      type: typeText(isTypeLike ? declaredType : valueType, declaration),
      calls,
      constructs,
      members: isTypeLike ? membersOf(memberType, declaration) : []
    });
  }
}

fs.writeFileSync(path.join(root, "api-dx-inventory.json"), JSON.stringify({ generatedAt: new Date().toISOString(), entries, inventory }, null, 2));
console.log(JSON.stringify({ entries: entries.length, exports: inventory.length, uniqueExports: new Set(inventory.map((item) => item.name)).size, members: inventory.reduce((sum, item) => sum + item.members.length, 0) }, null, 2));
