import * as ts from "typescript";
import CodeGraphParser from "./index";

export default class CodeGraphParserTsNative extends CodeGraphParser {
  constructor(targetFunctionCode: string, targetFileCode: string) {
    super(targetFunctionCode, targetFileCode);
  }

  // this is not implmented yet. do not use.
  public async parse() {
    const tsSourceFile = ts.createSourceFile(
      "test.ts",
      this.targetFunctionCode,
      ts.ScriptTarget.ES5,
      true
    );
  }
}
