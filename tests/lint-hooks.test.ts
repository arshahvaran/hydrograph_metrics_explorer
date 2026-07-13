import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

/**
 * Regression guard for the rules-of-hooks defect class (QA-001/002/003):
 * conditional early returns between hooks crash React when async state
 * (worker pending -> ready) changes the hook count. Lint the entire UI layer.
 */
describe('rules of hooks (structural regression guard)', () => {
  it('no component violates react-hooks/rules-of-hooks', async () => {
    const eslint = new ESLint(({
      // eslint 8 flat/legacy typing mismatch under @types/eslint 9 — options are valid at runtime
      useEslintrc: false,
      overrideConfig: ({
        parser: '@typescript-eslint/parser',
        parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
        plugins: ['react-hooks'],
        rules: { 'react-hooks/rules-of-hooks': 'error' },
      }) as any,
    } as any));
    const results = await eslint.lintFiles(['src/**/*.tsx', 'src/**/*.ts']);
    const errors = results.flatMap((r: any) => r.messages.map((m: any) => `${r.filePath.split('/hme/')[1]}:${m.line} ${m.message}`));
    expect(errors, errors.join('\n')).toEqual([]);
  }, 30000);
});
