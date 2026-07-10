import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { terser } from "rollup-plugin-terser";
import { builtinModules } from "module";

export default {
  input: "main.js",
  output: {
    file: "bundle/main.js",
    format: "cjs",
    globals: {
      global: "global", // 设置 global 的名称
    },
    exports: "auto",
  },
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    commonjs({
      ignoreDynamicRequires: true,
    }),
    terser({
      compress: {
        dead_code: true,
        drop_debugger: false,
        conditionals: true,
        side_effects: true,
      },
      mangle: {
        toplevel: true,
      },
      output: {
        comments: false,
        beautify: true,
      },
      //sourceMap: true,
      toplevel: true,
      nameCache: {}, // 如果需要在多次构建之间保持一致的名称混淆
    }),
  ],
  external: ["electron", "global", ...builtinModules], // 在这里列出你想要忽略的包
};
