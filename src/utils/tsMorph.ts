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

export function looksLike(a, b) {
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
        console.log("[hf]", "FUNCTION CONDITION HIT");
        return bVal(aVal);
      }
      const result = Array.isArray(aVal)
        ? Array.isArray(bVal) &&
          aVal.length === bVal.length &&
          aVal.every((val, idx) => looksLike(val, bVal[idx]))
        : isPrimitive(bVal)
        ? bVal === aVal
        : looksLike(aVal, bVal);
      // console.log("[hf] LOOKS LIKE", { bKey, aVal, bVal, result });
      return result;
    })
  );
}

function isPrimitive(val) {
  return val == null || /^[sbn]/.test(typeof val);
}
