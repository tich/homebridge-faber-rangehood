/**
 * Requires neverthrow Results to be used, rather than discarded, so that errors can't be silently ignored.
 *
 * Flags any statement whose value is a `Result` (`Ok`/`Err`), a `ResultAsync`, or a promise of a `Result`
 * (e.g. calling an async function that returns one, with or without `await`).
 * Prefix the call with `void` to explicitly discard a Result.
 *
 * The existing plugins (eslint-plugin-neverthrow, eslint-plugin-neverthrow-must-use) don't work with ESLint 9,
 * hence this local rule. It needs type information (`parserOptions.projectService`).
 */

const RESULT_TYPE_NAMES = new Set(['Ok', 'Err', 'ResultAsync']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require neverthrow Results to be used, rather than discarded' },
    messages: {
      mustUseResult: 'This Result is discarded, so its error would be silently ignored. Handle it, or discard it explicitly with `void`.',
    },
    schema: [],
  },

  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program) {
      throw new Error('The must-use-result rule needs type information. Set `parserOptions.projectService`.');
    }
    const checker = services.program.getTypeChecker();

    const isNeverthrowType = (type) => {
      const symbol = type.getSymbol() ?? type.aliasSymbol;
      return symbol !== undefined && RESULT_TYPE_NAMES.has(symbol.getName())
        && (symbol.getDeclarations() ?? []).some((declaration) => declaration.getSourceFile().fileName.includes('/neverthrow/'));
    };
    const isResultType = (type) => type.isUnion() ? type.types.some(isResultType) : isNeverthrowType(type);
    const isPromiseOfResult = (type) => {
      if (type.isUnion()) {
        return type.types.some(isPromiseOfResult);
      }
      if (type.getSymbol()?.getName() !== 'Promise') {
        return false;
      }
      const [awaited_type] = checker.getTypeArguments(type);
      return awaited_type !== undefined && isResultType(awaited_type);
    };

    return {
      ExpressionStatement(node) {
        // An assignment stores the Result rather than discarding it (no-unused-vars catches a stored Result that's never used)
        if (node.expression.type === 'AssignmentExpression') {
          return;
        }
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node.expression));
        if (isResultType(type) || isPromiseOfResult(type)) {
          context.report({ node, messageId: 'mustUseResult' });
        }
      },
    };
  },
};
