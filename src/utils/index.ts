import type { TSMorphFunctionNode } from "types/index";
import * as vscode from "vscode";
import * as hash from "object-hash";
import { ArrowFunction, SyntaxKind } from "ts-morph";

// eslint-disable-next-line @typescript-eslint/naming-convention
export function ExcludeNullish<T>(v: T | null | undefined): v is T {
  // eslint-disable-next-line eqeqeq
  return v != null;
}

export function looksLike(a, b): boolean {
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      const bVal = b[bKey];
      const aVal = a[bKey];
      if (typeof bVal === "function") {
        return bVal(aVal);
      }
      return isPrimitive(bVal) ? bVal === aVal : looksLike(aVal, bVal);
    })
  );
}

function isPrimitive(val) {
  return val == null || /^[sbn]/.test(typeof val);
}

export function looksLikeSkipPosition(a, b): boolean {
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      if (
        bKey === "loc" ||
        bKey === "start" ||
        bKey === "end" ||
        bKey === "trailingComma" ||
        bKey === "parenStart"
      ) {
        return true;
      }
      const bVal = b[bKey];
      const aVal = a[bKey];
      if (typeof bVal === "function") {
        return bVal(aVal);
      }

      // FOR DEBUGGING MATCH FAILS
      // if (isPrimitive(bVal) && bVal !== aVal) {
      //   console.log("[hf] MATCH FAIL", { bKey, aVal, bVal });
      // }

      return isPrimitive(bVal)
        ? bVal === aVal
        : looksLikeSkipPosition(aVal, bVal);
    })
  );
}

export function looksLikeSkipPositionTsMorph(a, b, depth): boolean {
  //todo: do better
  if (depth >= 100) {
    console.log("[hf] depth hit");
    return true;
  }
  console.log("[hf]", "match test", { a, b });
  return (
    a &&
    b &&
    Object.keys(b).every((bKey) => {
      if (
        bKey === "pos" ||
        bKey === "end" ||
        bKey === "_wrappedChildCount" ||
        bKey === "transformFlags" ||
        bKey === "fileName"
      ) {
        return true;
      }
      const bVal = b[bKey];
      const aVal = a[bKey];
      if (typeof bVal === "function") {
        return bVal(aVal);
      }

      // FOR DEBUGGING MATCH FAILS
      // if (isPrimitive(bVal) && bVal !== aVal) {
      //   debugger;
      //   console.log("[hf] MATCH FAIL", { bKey, aVal, bVal });
      // }

      return isPrimitive(bVal)
        ? bVal === aVal
        : looksLikeSkipPositionTsMorph(aVal, bVal, depth + 1);
    })
  );
}

const getTsMorphNodeFunctionName = (node: TSMorphFunctionNode) => {
  if (node instanceof ArrowFunction) {
    const declaratinParent = node.getParentIfKind(
      SyntaxKind.VariableDeclaration
    );

    if (!declaratinParent) {
      throw Error("cannot find arrow function identifier");
    }
    return declaratinParent.getName();
  } else {
    return node.getName();
  }
};

export const buildNodeMapNodeFromTsMorphNode = (
  node: TSMorphFunctionNode,
  targetFunctionUri: vscode.Uri,
  targetFunctionRange: vscode.Range,
  targetFunctionCode: string,
  isEntry: boolean,
  parentHash: string | undefined
) => {
  const astNodeHash = hash.sha1(node.compilerNode);
  const name = getTsMorphNodeFunctionName(node);
  const graphNode = {
    id: astNodeHash,
    // astNode: postitionedFunctionNode.compilerNode,
    uri: targetFunctionUri,
    range: targetFunctionRange,
    code: targetFunctionCode,
    incomingCalls: isEntry ? [] : [parentHash],
    outgoingCalls: [] as string[],
    name,
  };

  return graphNode;
};

export const verifyCallDefinitionLocations = (
  callDefinitionLocations: (vscode.Location | vscode.LocationLink)[][]
) => {
  try {
    const filtered = callDefinitionLocations
      .map((loc) => loc[0])
      .filter(ExcludeNullish);
    if (filtered.length !== callDefinitionLocations.length) {
      throw Error("call definition location not found");
    }
    return filtered;
  } catch (error) {
    console.error("error with call definition location", { error });
    throw Error("call definition location not found");
  }
};
