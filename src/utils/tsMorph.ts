import { ArrowFunction, SyntaxKind } from "ts-morph";
import type { TSMorphFunctionNode } from "types/index";

export const getTsMorphNodeFunctionName = (node: TSMorphFunctionNode) => {
  let name: string | undefined;
  if (node instanceof ArrowFunction || !node.getName) {
    const declarationParent = node.getParentIfKind(
      SyntaxKind.VariableDeclaration
    );
    name = declarationParent && declarationParent.getName();
  } else {
    name = node.getName();
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
