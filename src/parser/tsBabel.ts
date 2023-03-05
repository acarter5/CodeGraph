import { parse as babelParse } from "@babel/parser";
import CodeGraphParser from "./index";

// this parser throws errors on some valid ts patterns. use tsMorph parser for now or feel free to open a pull request!
export default class CodeGraphParserTsBabel extends CodeGraphParser {
  constructor(targetFunctionCode: string, targetFileCode: string) {
    super(targetFunctionCode, targetFileCode);
  }

  async parse() {
    const { targetFileCode, targetFunctionCode } = this;

    const unpositionedFunctionNode =
      targetFunctionCode &&
      babelParse(targetFunctionCode, {
        plugins: ["typescript"],
        allowImportExportEverywhere: true,
        errorRecovery: true,
      });

    const fileNode =
      targetFileCode &&
      babelParse(targetFileCode, {
        plugins: ["typescript"],
        allowImportExportEverywhere: true,
        errorRecovery: true,
      });

    return {
      unpositionedFunctionNode:
        unpositionedFunctionNode?.valueOf().program.body[0],
      fileNode,
    };
  }
}
