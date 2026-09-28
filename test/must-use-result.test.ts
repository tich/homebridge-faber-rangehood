import { describe, it } from 'node:test';
import path from 'node:path';
import { RuleTester, Rule } from 'eslint';
import tseslint from 'typescript-eslint';

// The rule is plain JavaScript, loaded from the repository's root (the tests run from there)
const rule_path = path.resolve('eslint-rules/must-use-result.js');
const { default: rule }: { default: Rule.RuleModule } = await import(rule_path);

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: { allowDefaultProject: ['*.ts'] },
      tsconfigRootDir: path.resolve('.'),
    },
  },
});

// Declarations the test cases share
const setup = `
import { ok, Result, ResultAsync } from 'neverthrow';
declare function sync(): Result<number, Error>;
declare function async_result(): Promise<Result<number, Error>>;
declare function result_async(): ResultAsync<number, Error>;
declare function other(): Promise<number>;
declare let stored: Result<number, Error>;
`;
const code = (body: string) => `${setup}\nexport async function test() {\n${body}\n}\n`;
const valid = (name: string, body: string) => ({ name, code: code(body), filename: 'case.ts' });
const invalid = (name: string, body: string) => ({ name, code: code(body), filename: 'case.ts', errors: [{ messageId: 'mustUseResult' }] });

tester.run('must-use-result', rule, {
  valid: [
    valid('a handled Result', 'const result = sync(); if (result.isErr()) { return; }'),
    valid('an unwrapped Result', 'const value = (await async_result()).unwrapOr(0);'),
    valid('a stored Result', 'stored = sync();'),
    valid('an explicitly discarded Result', 'void async_result();'),
    valid('a discarded non-Result value', 'await other();'),
    valid('a matched Result', 'sync().match(() => 1, () => 2);'),
    valid('a Result turned into something else', 'ok(1).isOk();'),
  ],
  invalid: [
    invalid('a discarded Result', 'sync();'),
    invalid('a discarded awaited promise of a Result', 'await async_result();'),
    invalid('a discarded promise of a Result', 'async_result();'),
    invalid('a discarded awaited ResultAsync', 'await result_async();'),
    invalid('a discarded ResultAsync', 'result_async();'),
    invalid('a discarded mapped Result', 'sync().map((value) => value + 1);'),
  ],
});
