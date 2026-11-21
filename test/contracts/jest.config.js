/**
 * Lane khusus uji kontrak Tahap 0.
 *
 * Spec di sini tidak memakai Nest, database, atau ALIM Core; satu-satunya server yang hidup adalah
 * mock di `alim-core/mock-server.ts`. Karena itu ia tidak ikut lane unit (`rootDir: src`) maupun
 * lane e2e (`test/jest-e2e.json` yang menyiapkan aplikasi), dan dijalankan lewat
 * `npm run test:contracts`.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          resolvePackageJsonExports: false,
          ignoreDeprecations: '6.0',
        },
      },
    ],
  },
};
