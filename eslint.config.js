import headers from "eslint-plugin-headers";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    plugins: { headers },
    rules: {
      "headers/header-format": [
        "error",
        {
          source: "string",
          content: [
            "SPDX-License-Identifier: PolyForm-Shield-1.0.0",
            "Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)",
          ].join("\n"),
          variables: {
            year: "2026",
          },
        },
      ],
    },
  },
];
