/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'kernel-does-not-import-workspaces',
      severity: 'error',
      comment: 'The L1 kernel may only depend on its own modules and external development tooling.',
      from: { path: '^packages/kernel(?:/|$)' },
      to: {
        path: '^(?:packages/(?!kernel(?:/|$))|providers(?:/|$)|examples(?:/|$))',
      },
    },
    {
      name: 'kernel-does-not-import-workspace-specifiers',
      severity: 'error',
      comment: 'Unresolved bare workspace imports must remain visible to boundary validation.',
      from: { path: '^packages/kernel(?:/|$)' },
      to: { path: '^@openagentcore/(?!kernel(?:/|$))' },
    },
    {
      name: 'no-imports-from-forbidden-directories',
      severity: 'error',
      from: {},
      to: { path: '(^|/)(?:utils|common|shared)(?:/|$)' },
    },
    {
      name: 'no-imports-inside-forbidden-directories',
      severity: 'error',
      from: { path: '(^|/)(?:utils|common|shared)(?:/|$)' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(?:^|/)(?:coverage|dist|node_modules)(?:/|$)' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
    },
  },
};

export default config;
