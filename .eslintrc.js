module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    'no-unused-vars': 'warn',
    'no-console': 'off',
    'no-undef': 'error',
    'no-redeclare': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': 'warn',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-duplicate-case': 'error',
    'no-empty': 'warn',
    'no-extra-semi': 'warn',
    'no-irregular-whitespace': 'warn',
    'no-multiple-empty-lines': 'warn',
    'no-trailing-spaces': 'warn',
    'prefer-const': 'warn',
    'semi': ['error', 'always'],
    'quotes': ['warn', 'single'],
    'indent': ['warn', 2],
    'comma-dangle': ['warn', 'always-multiline'],
  },
  globals: {
    // Browser globals
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    console: 'readonly',
    setTimeout: 'readonly',
    setInterval: 'readonly',
    clearTimeout: 'readonly',
    clearInterval: 'readonly',

    // WebRTC globals
    RTCPeerConnection: 'readonly',
    RTCSessionDescription: 'readonly',
    RTCIceCandidate: 'readonly',

    // Socket.IO globals
    io: 'readonly',

    // Node.js globals
    process: 'readonly',
    Buffer: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    module: 'readonly',
    require: 'readonly',
    exports: 'readonly',
    global: 'readonly',
  },
};
