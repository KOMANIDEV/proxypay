declare module "graphql-depth-limit" {
  import { ValidationContext } from "graphql";

  interface DepthLimitOptions {
    ignore?:
      | string
      | RegExp
      | ((fieldName: string) => boolean)
      | Array<string | RegExp | ((fieldName: string) => boolean)>;
  }

  function depthLimit(
    maxDepth: number,
    options?: DepthLimitOptions,
    callback?: (queryDepths: Record<string, number>) => void,
  ): (context: ValidationContext) => ValidationContext;

  export = depthLimit;
}
