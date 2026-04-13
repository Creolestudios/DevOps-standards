import js from "@eslint/js";

export default [
    js.configs.recommended,
    {
        rules: {
            "no-unused-vars": ["warn", { 
                "varsIgnorePattern": "^React$",
                "argsIgnorePattern": "^_" 
            }],
            "no-undef": "error"
        },
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                React: "readonly",
                process: "readonly",
                __dirname: "readonly",
                module: "readonly",
                require: "readonly",
                console: "readonly",
                Buffer: "readonly",
                exports: "readonly"
            }
        }
    }
];
