import {
  FunctionDeclaration,
  FunctionExpression,
  ArrowFunction,
} from "ts-morph";

export type TSMorphFunctionNode =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction;
