export default class CodeGraphParser {
  targetFunctionCode: string;
  targetFileCode: string;

  constructor(targetFunctionCode: string, targetFileCode: string) {
    this.targetFunctionCode = targetFunctionCode;
    this.targetFileCode = targetFileCode;
  }
}
