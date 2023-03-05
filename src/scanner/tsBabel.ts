// this isn't ready. dont use it.

// SCAN BABEL NODES
// const { name, callees } = scanTargetFunctionAstNode(
//   graphNode.astNode,
//   scope,
//   parentPath
// );

const scanTargetFunctionAstNode = (
  targetFunctionAstNode: Node,
  scope,
  parentPath
) => {
  let name: string | undefined;
  const callees = [];

  traverse(
    targetFunctionAstNode,
    {
      FunctionDeclaration(path) {
        if (name) {
          return;
        }
        name = path.node.id?.name;
      },
      ArrowFunctionExpression(path) {
        if (name) {
          return;
        }

        try {
          name = path.parent.id.name;
        } catch {
          console.error("arrowFunction name match error", { path });
          throw Error("name match error");
        }
      },
      FunctionExpression(path) {
        if (name) {
          return;
        }

        try {
          name = path.parent.id.name;
        } catch {
          console.error("FunctionExpression name match error", { path });
          throw Error("name match error");
        }
      },
      //   Identifier(path) {
      //     if (
      //       looksLike(path.parentPath.parent, {
      //         callee: () => true,
      //       })
      //     ) {
      //       callees.push(path.node);
      //     }
      //   },
      CallExpression(path) {
        let callee;
        try {
          callee = path.get("callee").node;
          const { property, loc } = callee;

          if (property) {
            callees.push(property.loc);
          } else if (loc) {
            callees.push(loc);
          }
        } catch {
          console.error("error resolving CallExpression callee", { path });
          throw Error("error resolving CallExpression callee");
        }
      },
    },
    scope,
    parentPath
  );

  return { name, callees };
};

// BABEL TRAVERSAL

// let postitionedFunctionTargetNode;
// let scope;
// let parentPath;

// GET POSISTIONED FUNCTION NODE

// traverse(fileAST, {
//   // eslint-disable-next-line @typescript-eslint/naming-convention
//   [functionTargetNode.type]: function (path) {
//     console.log("[hf]", {
//       functionNode: path.node,
//       targetFunctionNode: functionTargetNode,
//     });
//     if (looksLikeSkipPosition(path.node, functionTargetNode)) {
//       console.log("[hf]", { positionedNode: path.node });
//       postitionedFunctionTargetNode = path.node;
//       scope = path.scope;
//       parentPath = path.parentPath;
//     }
//   },
// });

// get defintion location from callees

// const calleeLocations = callees.map(async (callee) => {
//   // for some reason the executeDefinitionProvider command only works if the line # is 1 less than the actual location of the callee
//   const position = new Position(
//     callee.start.line - 1,
//     callee.start.column + 1
//   );
//   console.log("[hf] calleeLocations", {
//     callee,
//     start: callee.start,
//     position,
//     targetFuncUri,
//   });
//   const location = await commands.executeCommand(
//     "vscode.executeDefinitionProvider",
//     targetFuncUri,
//     position
//   );

//   console.log("[hf]", { location });

//   return Array.isArray(location) && location.length
//     ? {
//         ...location[0],
//         identifierName: callee.identifierName,
//       }
//     : null;
// });
