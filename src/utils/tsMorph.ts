import { ArrowFunction, Node, SourceFile, SyntaxKind } from "ts-morph";
import type { TSMorphFunctionNode } from "types/index";

// Global/builtin callees we never want to resolve or graph (e.g. `parseInt`,
// `JSON.parse`, `Promise.all`). Used only when the base identifier isn't a
// local import, so a user import named the same thing still wins.
export const JS_BUILTINS = new Set([
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "structuredClone",
  "fetch",
  "JSON",
  "Math",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Promise",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Error",
  "console",
  "process",
]);

// Map each imported local name to the module it comes from, so a call's
// receiver can be traced to a bare (node_modules) vs relative (local) import.
export function buildImportModuleMap(sourceFile: SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      map.set(defaultImport.getText(), moduleSpecifier);
    }
    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) {
      map.set(namespaceImport.getText(), moduleSpecifier);
    }
    for (const named of importDecl.getNamedImports()) {
      map.set(named.getName(), moduleSpecifier);
    }
  }
  return map;
}

// Bare = not a relative/absolute path → resolves out of node_modules.
export function isBareModuleSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

// Walk down a callee expression through property/element accesses to its
// leftmost identifier (`a` in `a.b.c()` / `a[x].b()`). Returns null when the
// chain doesn't bottom out in a plain identifier (e.g. `new X().y()`, `this`).
export function baseIdentifierName(callee: Node | undefined): string | null {
  let node: Node | undefined = callee;
  while (
    node &&
    (Node.isPropertyAccessExpression(node) ||
      Node.isElementAccessExpression(node))
  ) {
    node = node.getExpression();
  }
  return node && Node.isIdentifier(node) ? node.getText() : null;
}

// Is `base` an external callee — imported from a bare (node_modules) module, or
// a JS builtin (unless a local import shadows the name)?
export function isExternalCallee(
  base: string | null,
  importModules: Map<string, string>
): boolean {
  if (base === null) {
    return false;
  }
  const moduleSpecifier = importModules.get(base);
  return moduleSpecifier !== undefined
    ? isBareModuleSpecifier(moduleSpecifier)
    : JS_BUILTINS.has(base);
}

export const getTsMorphNodeFunctionName = (node: TSMorphFunctionNode) => {
  let name: string | undefined;
  // ConstructorDeclaration has no getName(); ArrowFunctions get their name from
  // an enclosing `const x = () => …`. Everything else (functions, methods,
  // accessors) names itself directly.
  const getName = "getName" in node ? node.getName.bind(node) : undefined;
  if (node instanceof ArrowFunction || !getName) {
    const declarationParent = node.getParentIfKind(
      SyntaxKind.VariableDeclaration
    );
    name = declarationParent && declarationParent.getName();
  } else {
    name = getName();
  }

  return name || "Anonymous";
};

export function looksLike(a: any, b: any): boolean {
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      if (bKey === "manipulationSettings" || bKey.startsWith("_")) {
        return true;
      }
      const bVal = b[bKey];
      const aVal = a[bKey];

      if (typeof bVal === "function") {
        return bVal(aVal);
      }
      const result = Array.isArray(aVal)
        ? Array.isArray(bVal) &&
          aVal.length === bVal.length &&
          aVal.every((val: any, idx: number) => looksLike(val, bVal[idx]))
        : isPrimitive(bVal)
        ? bVal === aVal
        : looksLike(aVal, bVal);
      return result;
    })
  );
}

function isPrimitive(val: any): boolean {
  return val == null || /^[sbn]/.test(typeof val);
}
