import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Resolve `./foo.js` specifiers to `./foo.ts` when running TypeScript sources
 * directly with Node's type stripping.
 *
 * The published code is compiled, so its `.js` imports are literal. In this
 * repo the same imports point at the `.ts` sources, which is what every other
 * ecosystem tool understands and what Node alone does not. Registering one
 * resolve hook is cheaper than a dev dependency whose only job is the same
 * rewrite.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && specifier.endsWith('.js') && context.parentURL !== undefined) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
