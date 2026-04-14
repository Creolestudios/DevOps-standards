import js from '@eslint/js';

// Conditionally load typescript-eslint packages for TS support
let tsParser, tsPlugin;
try {
  const parserMod = await import('@typescript-eslint/parser');
  tsParser = parserMod.default || parserMod;

  const pluginMod = await import('@typescript-eslint/eslint-plugin');
  tsPlugin = pluginMod.default || pluginMod;
} catch {
  // TypeScript plugins not found — scan will fall back to JS rules
}

let reactPlugin, reactHooksPlugin;
try {
  reactPlugin = (await import('eslint-plugin-react')).default;
  reactHooksPlugin = (await import('eslint-plugin-react-hooks')).default;
} catch {
  // React plugins not found — scan will fall back to standard JS rules
}

const config = [
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        /// Node.js globals
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        localStorage: 'readonly', // FIX: Added to allow localStorage usage
        FormData: 'readonly',     // FIX: Added to allow FormData usage
        // React
        React: 'readonly',
      },
    },
    plugins: {
      ...(tsPlugin ? { '@typescript-eslint': tsPlugin } : {}),
      ...(reactPlugin ? { 'react': reactPlugin } : {}),
      ...(reactHooksPlugin ? { 'react-hooks': reactHooksPlugin } : {}),
    },
    rules: {
      // --- Standard JS Rules ---
      'no-console': 'warn',
      'eqeqeq': 'error',
      'indent': ['error', 2],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'curly': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^React$' }],
      'no-undef': 'error',
      'prefer-template': 'warn',

      // --- TypeScript Rules (Conditional) ---
      ...(tsPlugin ? {
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      } : {}),

      // --- React Rules (Conditional) ---
      ...(reactPlugin ? {
        ...reactPlugin.configs.recommended.rules,
        'react/react-in-jsx-scope': 'off', // Not needed in modern React
        'react/prop-types': 'off',         // Use TS for props
      } : {}),
      ...(reactHooksPlugin ? {
        ...reactHooksPlugin.configs.recommended.rules,
      } : {}),
    },
    settings: {
      ...(reactPlugin ? {
        react: { version: 'detect' },
      } : {}),
    },
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    rules: {
      'no-unused-vars': ['warn', {
        varsIgnorePattern: '^React$|^_|^use[A-Z]|^[A-Z]',
        argsIgnorePattern: '^_',
      }],
    },
  },
  {
    // Added **/setup-tests.ts to fix globals in test setup files
    files: [
      '**/*.test.{js,jsx,ts,tsx}',
      '**/*.spec.{js,jsx,ts,tsx}',
      '**/tests/**/*.{js,jsx,ts,tsx}',
      '**/__tests__/**/*.{js,jsx,ts,tsx}',
      '**/setup-tests.{ts,tsx}'
    ],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
        vi: 'readonly',
      },
    },
  },
  {
    // FIX: Added **/ to ensure run-newman-cloud.mjs is ignored inside the tests/ folder
    ignores: ['eslint.config.mjs', '**/run-newman-cloud.mjs', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**'],
  },
];

if (tsParser && tsPlugin) {
  config.push({
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      // FIX: Standard TS practice to turn off no-undef. 
      // TS compiler handles this; ESLint 'no-undef' flags valid TS types as errors.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        varsIgnorePattern: '^React$|^_|^use[A-Z]|^[A-Z]',
        argsIgnorePattern: '^_',
      }],
    },
  });
} else {
  config.push({
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-unused-vars': 'off',
    },
  });
}

export default config;