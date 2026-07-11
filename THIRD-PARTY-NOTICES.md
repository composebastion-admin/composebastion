# Third-Party Notices

ComposeBastion may include or depend on third-party software components.
Third-party components are governed by their own license terms and are not relicensed by LICENSE.md.

This inventory was generated from package-lock.json for ComposeBastion 1.0.7-rc.1. It is a best-effort dependency notice for the npm workspace.

## Bundled Runtime Tools

These non-npm tools are distributed in the app or agent image. Their applicable
upstream license and notice files are copied into `/licenses/third-party/` in
the corresponding image.

Each image also records deterministic linked Go module inventories and SHA-256
evidence for the shipped upstream license/notice artifacts under
`/licenses/third-party/go-buildinfo/`. These inventories make the exact static
dependency set reviewable, but they are not a complete transitive attribution
bundle. **Legal review status: pending.** A manual review of the linked module
inventories and any additional attribution obligations remains a release gate.

| Component | Reviewed version/source | License | Image |
|-----------|-------------------------|---------|-------|
| Trivy | 0.72.0 (8a32853686209a428179bb3a1688802b25691564) | Apache-2.0 | app |
| ORAS Go v2 | 2.6.2 | Apache-2.0 | app (linked into Trivy) |
| rclone | 1.74.4 (5bc93a2a7ab0ebd0a11352bc4968eabeffb18027) | MIT | app |
| Docker CLI | 29.6.1 (8900f1d330cb39e93e16d780a26bff1d7e07ba03) | Apache-2.0 | agent |
| Docker Compose | 5.3.1 (f32009d4a2c687dd405398cc7975d12dccaf8dff) | Apache-2.0 | agent |
| Go standard library | 1.26.5 | BSD-3-Clause | app and agent tool binaries |

## License Summary

| License | Package entries |
|---------|-----------------|
| MIT | 291 |
| Apache-2.0 | 33 |
| ISC | 21 |
| BSD-3-Clause | 6 |
| BlueOak-1.0.0 | 5 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| MIT-0 | 1 |
| Unlicense | 1 |

## Manual Review Items

No missing, GPL, AGPL, SSPL, UNKNOWN, or UNLICENSED package entries were found in the npm lockfile inventory.

## Dependency Inventory

| Package | Version | License | Lockfile path |
|---------|---------|---------|---------------|
| @aws-sdk/checksums | 3.1000.16 | Apache-2.0 | node_modules/@aws-sdk/checksums |
| @aws-sdk/client-s3 | 3.1085.0 | Apache-2.0 | node_modules/@aws-sdk/client-s3 |
| @aws-sdk/core | 3.975.1 | Apache-2.0 | node_modules/@aws-sdk/core |
| @aws-sdk/credential-provider-env | 3.972.57 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-env |
| @aws-sdk/credential-provider-http | 3.972.59 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-http |
| @aws-sdk/credential-provider-ini | 3.973.1 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-ini |
| @aws-sdk/credential-provider-login | 3.972.63 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-login |
| @aws-sdk/credential-provider-node | 3.972.66 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-node |
| @aws-sdk/credential-provider-process | 3.972.57 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-process |
| @aws-sdk/credential-provider-sso | 3.973.1 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-sso |
| @aws-sdk/credential-provider-web-identity | 3.972.63 | Apache-2.0 | node_modules/@aws-sdk/credential-provider-web-identity |
| @aws-sdk/middleware-sdk-s3 | 3.972.62 | Apache-2.0 | node_modules/@aws-sdk/middleware-sdk-s3 |
| @aws-sdk/nested-clients | 3.997.31 | Apache-2.0 | node_modules/@aws-sdk/nested-clients |
| @aws-sdk/signature-v4-multi-region | 3.996.39 | Apache-2.0 | node_modules/@aws-sdk/signature-v4-multi-region |
| @aws-sdk/token-providers | 3.1083.0 | Apache-2.0 | node_modules/@aws-sdk/token-providers |
| @aws-sdk/types | 3.974.0 | Apache-2.0 | node_modules/@aws-sdk/types |
| @aws-sdk/xml-builder | 3.972.34 | Apache-2.0 | node_modules/@aws-sdk/xml-builder |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | node_modules/@aws/lambda-invoke-store |
| @babel/code-frame | 7.29.7 | MIT | node_modules/@babel/code-frame |
| @babel/compat-data | 7.29.7 | MIT | node_modules/@babel/compat-data |
| @babel/core | 7.29.7 | MIT | node_modules/@babel/core |
| @babel/generator | 7.29.7 | MIT | node_modules/@babel/generator |
| @babel/helper-compilation-targets | 7.29.7 | MIT | node_modules/@babel/helper-compilation-targets |
| @babel/helper-globals | 7.29.7 | MIT | node_modules/@babel/helper-globals |
| @babel/helper-module-imports | 7.29.7 | MIT | node_modules/@babel/helper-module-imports |
| @babel/helper-module-transforms | 7.29.7 | MIT | node_modules/@babel/helper-module-transforms |
| @babel/helper-plugin-utils | 7.28.6 | MIT | node_modules/@babel/helper-plugin-utils |
| @babel/helper-string-parser | 7.29.7 | MIT | node_modules/@babel/helper-string-parser |
| @babel/helper-validator-identifier | 7.29.7 | MIT | node_modules/@babel/helper-validator-identifier |
| @babel/helper-validator-option | 7.29.7 | MIT | node_modules/@babel/helper-validator-option |
| @babel/helpers | 7.29.7 | MIT | node_modules/@babel/helpers |
| @babel/parser | 7.29.7 | MIT | node_modules/@babel/parser |
| @babel/plugin-transform-react-jsx-self | 7.27.1 | MIT | node_modules/@babel/plugin-transform-react-jsx-self |
| @babel/plugin-transform-react-jsx-source | 7.27.1 | MIT | node_modules/@babel/plugin-transform-react-jsx-source |
| @babel/template | 7.29.7 | MIT | node_modules/@babel/template |
| @babel/traverse | 7.29.7 | MIT | node_modules/@babel/traverse |
| @babel/types | 7.29.7 | MIT | node_modules/@babel/types |
| @esbuild/aix-ppc64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/aix-ppc64 |
| @esbuild/aix-ppc64 | 0.28.1 | MIT | node_modules/@esbuild/aix-ppc64 |
| @esbuild/android-arm | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/android-arm |
| @esbuild/android-arm | 0.28.1 | MIT | node_modules/@esbuild/android-arm |
| @esbuild/android-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/android-arm64 |
| @esbuild/android-arm64 | 0.28.1 | MIT | node_modules/@esbuild/android-arm64 |
| @esbuild/android-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/android-x64 |
| @esbuild/android-x64 | 0.28.1 | MIT | node_modules/@esbuild/android-x64 |
| @esbuild/darwin-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/darwin-arm64 |
| @esbuild/darwin-arm64 | 0.28.1 | MIT | node_modules/@esbuild/darwin-arm64 |
| @esbuild/darwin-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/darwin-x64 |
| @esbuild/darwin-x64 | 0.28.1 | MIT | node_modules/@esbuild/darwin-x64 |
| @esbuild/freebsd-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/freebsd-arm64 |
| @esbuild/freebsd-arm64 | 0.28.1 | MIT | node_modules/@esbuild/freebsd-arm64 |
| @esbuild/freebsd-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/freebsd-x64 |
| @esbuild/freebsd-x64 | 0.28.1 | MIT | node_modules/@esbuild/freebsd-x64 |
| @esbuild/linux-arm | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-arm |
| @esbuild/linux-arm | 0.28.1 | MIT | node_modules/@esbuild/linux-arm |
| @esbuild/linux-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-arm64 |
| @esbuild/linux-arm64 | 0.28.1 | MIT | node_modules/@esbuild/linux-arm64 |
| @esbuild/linux-ia32 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-ia32 |
| @esbuild/linux-ia32 | 0.28.1 | MIT | node_modules/@esbuild/linux-ia32 |
| @esbuild/linux-loong64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-loong64 |
| @esbuild/linux-loong64 | 0.28.1 | MIT | node_modules/@esbuild/linux-loong64 |
| @esbuild/linux-mips64el | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-mips64el |
| @esbuild/linux-mips64el | 0.28.1 | MIT | node_modules/@esbuild/linux-mips64el |
| @esbuild/linux-ppc64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-ppc64 |
| @esbuild/linux-ppc64 | 0.28.1 | MIT | node_modules/@esbuild/linux-ppc64 |
| @esbuild/linux-riscv64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-riscv64 |
| @esbuild/linux-riscv64 | 0.28.1 | MIT | node_modules/@esbuild/linux-riscv64 |
| @esbuild/linux-s390x | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-s390x |
| @esbuild/linux-s390x | 0.28.1 | MIT | node_modules/@esbuild/linux-s390x |
| @esbuild/linux-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/linux-x64 |
| @esbuild/linux-x64 | 0.28.1 | MIT | node_modules/@esbuild/linux-x64 |
| @esbuild/netbsd-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/netbsd-arm64 |
| @esbuild/netbsd-arm64 | 0.28.1 | MIT | node_modules/@esbuild/netbsd-arm64 |
| @esbuild/netbsd-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/netbsd-x64 |
| @esbuild/netbsd-x64 | 0.28.1 | MIT | node_modules/@esbuild/netbsd-x64 |
| @esbuild/openbsd-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/openbsd-arm64 |
| @esbuild/openbsd-arm64 | 0.28.1 | MIT | node_modules/@esbuild/openbsd-arm64 |
| @esbuild/openbsd-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/openbsd-x64 |
| @esbuild/openbsd-x64 | 0.28.1 | MIT | node_modules/@esbuild/openbsd-x64 |
| @esbuild/openharmony-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/openharmony-arm64 |
| @esbuild/openharmony-arm64 | 0.28.1 | MIT | node_modules/@esbuild/openharmony-arm64 |
| @esbuild/sunos-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/sunos-x64 |
| @esbuild/sunos-x64 | 0.28.1 | MIT | node_modules/@esbuild/sunos-x64 |
| @esbuild/win32-arm64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/win32-arm64 |
| @esbuild/win32-arm64 | 0.28.1 | MIT | node_modules/@esbuild/win32-arm64 |
| @esbuild/win32-ia32 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/win32-ia32 |
| @esbuild/win32-ia32 | 0.28.1 | MIT | node_modules/@esbuild/win32-ia32 |
| @esbuild/win32-x64 | 0.25.12 | MIT | node_modules/vite/node_modules/@esbuild/win32-x64 |
| @esbuild/win32-x64 | 0.28.1 | MIT | node_modules/@esbuild/win32-x64 |
| @fastify/accept-negotiator | 2.0.1 | MIT | node_modules/@fastify/accept-negotiator |
| @fastify/ajv-compiler | 4.0.5 | MIT | node_modules/@fastify/ajv-compiler |
| @fastify/cookie | 11.0.2 | MIT | node_modules/@fastify/cookie |
| @fastify/cors | 10.1.0 | MIT | node_modules/@fastify/cors |
| @fastify/error | 4.2.0 | MIT | node_modules/@fastify/error |
| @fastify/fast-json-stringify-compiler | 5.0.3 | MIT | node_modules/@fastify/fast-json-stringify-compiler |
| @fastify/forwarded | 3.0.1 | MIT | node_modules/@fastify/forwarded |
| @fastify/helmet | 13.0.2 | MIT | node_modules/@fastify/helmet |
| @fastify/merge-json-schemas | 0.2.1 | MIT | node_modules/@fastify/merge-json-schemas |
| @fastify/proxy-addr | 5.1.0 | MIT | node_modules/@fastify/proxy-addr |
| @fastify/rate-limit | 10.3.0 | MIT | node_modules/@fastify/rate-limit |
| @fastify/send | 4.1.0 | MIT | node_modules/@fastify/send |
| @fastify/static | 9.1.3 | MIT | node_modules/@fastify/static |
| @fastify/websocket | 11.2.0 | MIT | node_modules/@fastify/websocket |
| @ioredis/commands | 1.10.0 | MIT | node_modules/@ioredis/commands |
| @jridgewell/gen-mapping | 0.3.13 | MIT | node_modules/@jridgewell/gen-mapping |
| @jridgewell/remapping | 2.3.5 | MIT | node_modules/@jridgewell/remapping |
| @jridgewell/resolve-uri | 3.1.2 | MIT | node_modules/@jridgewell/resolve-uri |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | node_modules/@jridgewell/sourcemap-codec |
| @jridgewell/trace-mapping | 0.3.31 | MIT | node_modules/@jridgewell/trace-mapping |
| @lukeed/ms | 2.0.2 | MIT | node_modules/@lukeed/ms |
| @pinojs/redact | 0.4.0 | MIT | node_modules/@pinojs/redact |
| @playwright/test | 1.61.0 | Apache-2.0 | node_modules/@playwright/test |
| @rolldown/pluginutils | 1.0.0-beta.27 | MIT | node_modules/@rolldown/pluginutils |
| @rollup/rollup-android-arm-eabi | 4.60.4 | MIT | node_modules/@rollup/rollup-android-arm-eabi |
| @rollup/rollup-android-arm64 | 4.60.4 | MIT | node_modules/@rollup/rollup-android-arm64 |
| @rollup/rollup-darwin-arm64 | 4.60.4 | MIT | node_modules/@rollup/rollup-darwin-arm64 |
| @rollup/rollup-darwin-x64 | 4.60.4 | MIT | node_modules/@rollup/rollup-darwin-x64 |
| @rollup/rollup-freebsd-arm64 | 4.60.4 | MIT | node_modules/@rollup/rollup-freebsd-arm64 |
| @rollup/rollup-freebsd-x64 | 4.60.4 | MIT | node_modules/@rollup/rollup-freebsd-x64 |
| @rollup/rollup-linux-arm-gnueabihf | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-arm-gnueabihf |
| @rollup/rollup-linux-arm-musleabihf | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-arm-musleabihf |
| @rollup/rollup-linux-arm64-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-arm64-gnu |
| @rollup/rollup-linux-arm64-musl | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-arm64-musl |
| @rollup/rollup-linux-loong64-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-loong64-gnu |
| @rollup/rollup-linux-loong64-musl | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-loong64-musl |
| @rollup/rollup-linux-ppc64-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-ppc64-gnu |
| @rollup/rollup-linux-ppc64-musl | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-ppc64-musl |
| @rollup/rollup-linux-riscv64-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-riscv64-gnu |
| @rollup/rollup-linux-riscv64-musl | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-riscv64-musl |
| @rollup/rollup-linux-s390x-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-s390x-gnu |
| @rollup/rollup-linux-x64-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-x64-gnu |
| @rollup/rollup-linux-x64-musl | 4.60.4 | MIT | node_modules/@rollup/rollup-linux-x64-musl |
| @rollup/rollup-openbsd-x64 | 4.60.4 | MIT | node_modules/@rollup/rollup-openbsd-x64 |
| @rollup/rollup-openharmony-arm64 | 4.60.4 | MIT | node_modules/@rollup/rollup-openharmony-arm64 |
| @rollup/rollup-win32-arm64-msvc | 4.60.4 | MIT | node_modules/@rollup/rollup-win32-arm64-msvc |
| @rollup/rollup-win32-ia32-msvc | 4.60.4 | MIT | node_modules/@rollup/rollup-win32-ia32-msvc |
| @rollup/rollup-win32-x64-gnu | 4.60.4 | MIT | node_modules/@rollup/rollup-win32-x64-gnu |
| @rollup/rollup-win32-x64-msvc | 4.60.4 | MIT | node_modules/@rollup/rollup-win32-x64-msvc |
| @smithy/core | 3.29.3 | Apache-2.0 | node_modules/@smithy/core |
| @smithy/credential-provider-imds | 4.4.8 | Apache-2.0 | node_modules/@smithy/credential-provider-imds |
| @smithy/fetch-http-handler | 5.6.5 | Apache-2.0 | node_modules/@smithy/fetch-http-handler |
| @smithy/node-http-handler | 4.9.5 | Apache-2.0 | node_modules/@smithy/node-http-handler |
| @smithy/signature-v4 | 5.6.4 | Apache-2.0 | node_modules/@smithy/signature-v4 |
| @smithy/types | 4.16.1 | Apache-2.0 | node_modules/@smithy/types |
| @standard-schema/spec | 1.1.0 | MIT | node_modules/@standard-schema/spec |
| @types/babel__core | 7.20.5 | MIT | node_modules/@types/babel__core |
| @types/babel__generator | 7.27.0 | MIT | node_modules/@types/babel__generator |
| @types/babel__template | 7.4.4 | MIT | node_modules/@types/babel__template |
| @types/babel__traverse | 7.28.0 | MIT | node_modules/@types/babel__traverse |
| @types/bcryptjs | 2.4.6 | MIT | node_modules/@types/bcryptjs |
| @types/chai | 5.2.3 | MIT | node_modules/@types/chai |
| @types/deep-eql | 4.0.2 | MIT | node_modules/@types/deep-eql |
| @types/estree | 1.0.8 | MIT | node_modules/@types/estree |
| @types/node | 18.19.130 | MIT | node_modules/@types/ssh2/node_modules/@types/node |
| @types/node | 22.19.20 | MIT | node_modules/@types/node |
| @types/nodemailer | 6.4.23 | MIT | node_modules/@types/nodemailer |
| @types/pg | 8.20.0 | MIT | node_modules/@types/pg |
| @types/react | 19.2.17 | MIT | node_modules/@types/react |
| @types/react-dom | 19.2.3 | MIT | node_modules/@types/react-dom |
| @types/semver | 7.7.1 | MIT | node_modules/@types/semver |
| @types/ssh2 | 1.15.5 | MIT | node_modules/@types/ssh2 |
| @vitejs/plugin-react | 4.7.0 | MIT | node_modules/@vitejs/plugin-react |
| @vitest/expect | 4.1.8 | MIT | node_modules/@vitest/expect |
| @vitest/mocker | 4.1.8 | MIT | node_modules/@vitest/mocker |
| @vitest/pretty-format | 4.1.8 | MIT | node_modules/@vitest/pretty-format |
| @vitest/runner | 4.1.8 | MIT | node_modules/@vitest/runner |
| @vitest/snapshot | 4.1.8 | MIT | node_modules/@vitest/snapshot |
| @vitest/spy | 4.1.8 | MIT | node_modules/@vitest/spy |
| @vitest/utils | 4.1.8 | MIT | node_modules/@vitest/utils |
| @xterm/addon-fit | 0.10.0 | MIT | node_modules/@xterm/addon-fit |
| @xterm/xterm | 5.5.0 | MIT | node_modules/@xterm/xterm |
| abstract-logging | 2.0.1 | MIT | node_modules/abstract-logging |
| ajv | 8.20.0 | MIT | node_modules/ajv |
| ajv-formats | 3.0.1 | MIT | node_modules/ajv-formats |
| ansi-regex | 5.0.1 | MIT | node_modules/ansi-regex |
| ansi-styles | 4.3.0 | MIT | node_modules/ansi-styles |
| asn1 | 0.2.6 | MIT | node_modules/asn1 |
| assertion-error | 2.0.1 | MIT | node_modules/assertion-error |
| atomic-sleep | 1.0.0 | MIT | node_modules/atomic-sleep |
| avvio | 9.2.0 | MIT | node_modules/avvio |
| balanced-match | 4.0.4 | MIT | node_modules/balanced-match |
| baseline-browser-mapping | 2.10.38 | Apache-2.0 | node_modules/baseline-browser-mapping |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause | node_modules/bcrypt-pbkdf |
| bcryptjs | 3.0.3 | BSD-3-Clause | node_modules/bcryptjs |
| bowser | 2.14.1 | MIT | node_modules/bowser |
| brace-expansion | 5.0.6 | MIT | node_modules/brace-expansion |
| browserslist | 4.28.2 | MIT | node_modules/browserslist |
| buildcheck | 0.0.7 | MIT | node_modules/buildcheck |
| caniuse-lite | 1.0.30001799 | CC-BY-4.0 | node_modules/caniuse-lite |
| chai | 6.2.2 | MIT | node_modules/chai |
| chalk | 4.1.2 | MIT | node_modules/chalk |
| cliui | 8.0.1 | ISC | node_modules/cliui |
| cluster-key-slot | 1.1.1 | Apache-2.0 | node_modules/cluster-key-slot |
| color-convert | 2.0.1 | MIT | node_modules/color-convert |
| color-name | 1.1.4 | MIT | node_modules/color-name |
| concurrently | 9.2.3 | MIT | node_modules/concurrently |
| content-disposition | 1.1.0 | MIT | node_modules/content-disposition |
| convert-source-map | 2.0.0 | MIT | node_modules/convert-source-map |
| cookie | 1.1.1 | MIT | node_modules/cookie |
| cpu-features | 0.0.10 | MIT | node_modules/cpu-features |
| csstype | 3.2.3 | MIT | node_modules/csstype |
| debug | 4.4.3 | MIT | node_modules/debug |
| denque | 2.1.0 | Apache-2.0 | node_modules/denque |
| depd | 2.0.0 | MIT | node_modules/depd |
| dequal | 2.0.3 | MIT | node_modules/dequal |
| duplexify | 4.1.3 | MIT | node_modules/duplexify |
| electron-to-chromium | 1.5.376 | ISC | node_modules/electron-to-chromium |
| emoji-regex | 8.0.0 | MIT | node_modules/emoji-regex |
| end-of-stream | 1.4.5 | MIT | node_modules/end-of-stream |
| es-module-lexer | 2.1.0 | MIT | node_modules/es-module-lexer |
| esbuild | 0.25.12 | MIT | node_modules/vite/node_modules/esbuild |
| esbuild | 0.28.1 | MIT | node_modules/esbuild |
| escalade | 3.2.0 | MIT | node_modules/escalade |
| escape-html | 1.0.3 | MIT | node_modules/escape-html |
| estree-walker | 3.0.3 | MIT | node_modules/estree-walker |
| expect-type | 1.3.0 | Apache-2.0 | node_modules/expect-type |
| fast-decode-uri-component | 1.0.1 | MIT | node_modules/fast-decode-uri-component |
| fast-deep-equal | 3.1.3 | MIT | node_modules/fast-deep-equal |
| fast-json-stringify | 6.4.0 | MIT | node_modules/fast-json-stringify |
| fast-querystring | 1.1.2 | MIT | node_modules/fast-querystring |
| fast-uri | 3.1.2 | BSD-3-Clause | node_modules/fast-uri |
| fastify | 5.8.5 | MIT | node_modules/fastify |
| fastify-plugin | 5.1.0 | MIT | node_modules/fastify-plugin |
| fastq | 1.20.1 | ISC | node_modules/fastq |
| fdir | 6.5.0 | MIT | node_modules/fdir |
| find-my-way | 9.6.0 | MIT | node_modules/find-my-way |
| fsevents | 2.3.2 | MIT | node_modules/playwright/node_modules/fsevents |
| fsevents | 2.3.3 | MIT | node_modules/fsevents |
| gensync | 1.0.0-beta.2 | MIT | node_modules/gensync |
| get-caller-file | 2.0.5 | ISC | node_modules/get-caller-file |
| glob | 13.0.6 | BlueOak-1.0.0 | node_modules/glob |
| has-flag | 4.0.0 | MIT | node_modules/has-flag |
| helmet | 8.2.0 | MIT | node_modules/helmet |
| http-errors | 2.0.1 | MIT | node_modules/http-errors |
| inherits | 2.0.4 | ISC | node_modules/inherits |
| ioredis | 5.11.1 | MIT | node_modules/ioredis |
| ipaddr.js | 2.4.0 | MIT | node_modules/ipaddr.js |
| is-fullwidth-code-point | 3.0.0 | MIT | node_modules/is-fullwidth-code-point |
| js-tokens | 4.0.0 | MIT | node_modules/js-tokens |
| jsesc | 3.1.0 | MIT | node_modules/jsesc |
| json-schema-ref-resolver | 3.0.0 | MIT | node_modules/json-schema-ref-resolver |
| json-schema-traverse | 1.0.0 | MIT | node_modules/json-schema-traverse |
| json5 | 2.2.3 | MIT | node_modules/json5 |
| light-my-request | 6.6.0 | BSD-3-Clause | node_modules/light-my-request |
| lru-cache | 11.5.1 | BlueOak-1.0.0 | node_modules/path-scurry/node_modules/lru-cache |
| lru-cache | 5.1.1 | ISC | node_modules/lru-cache |
| lucide-react | 0.468.0 | ISC | node_modules/lucide-react |
| magic-string | 0.30.21 | MIT | node_modules/magic-string |
| mime | 3.0.0 | MIT | node_modules/mime |
| minimatch | 10.2.5 | BlueOak-1.0.0 | node_modules/minimatch |
| minipass | 7.1.3 | BlueOak-1.0.0 | node_modules/minipass |
| mnemonist | 0.40.0 | MIT | node_modules/mnemonist |
| ms | 2.1.3 | MIT | node_modules/ms |
| nan | 2.27.0 | MIT | node_modules/nan |
| nanoid | 3.3.12 | MIT | node_modules/nanoid |
| node-releases | 2.0.48 | MIT | node_modules/node-releases |
| nodemailer | 9.0.1 | MIT-0 | node_modules/nodemailer |
| obliterator | 2.0.5 | MIT | node_modules/obliterator |
| obug | 2.1.1 | MIT | node_modules/obug |
| on-exit-leak-free | 2.1.2 | MIT | node_modules/on-exit-leak-free |
| once | 1.4.0 | ISC | node_modules/once |
| path-scurry | 2.0.2 | BlueOak-1.0.0 | node_modules/path-scurry |
| pathe | 2.0.3 | MIT | node_modules/pathe |
| pg | 8.21.0 | MIT | node_modules/pg |
| pg-cloudflare | 1.4.0 | MIT | node_modules/pg-cloudflare |
| pg-connection-string | 2.13.0 | MIT | node_modules/pg-connection-string |
| pg-int8 | 1.0.1 | ISC | node_modules/pg-int8 |
| pg-pool | 3.14.0 | MIT | node_modules/pg-pool |
| pg-protocol | 1.14.0 | MIT | node_modules/pg-protocol |
| pg-types | 2.2.0 | MIT | node_modules/pg-types |
| pgpass | 1.0.5 | MIT | node_modules/pgpass |
| picocolors | 1.1.1 | ISC | node_modules/picocolors |
| picomatch | 4.0.4 | MIT | node_modules/picomatch |
| pino | 10.3.1 | MIT | node_modules/pino |
| pino-abstract-transport | 3.0.0 | MIT | node_modules/pino-abstract-transport |
| pino-std-serializers | 7.1.0 | MIT | node_modules/pino-std-serializers |
| playwright | 1.61.0 | Apache-2.0 | node_modules/playwright |
| playwright-core | 1.61.0 | Apache-2.0 | node_modules/playwright-core |
| postcss | 8.5.14 | MIT | node_modules/postcss |
| postgres-array | 2.0.0 | MIT | node_modules/postgres-array |
| postgres-bytea | 1.0.1 | MIT | node_modules/postgres-bytea |
| postgres-date | 1.0.7 | MIT | node_modules/postgres-date |
| postgres-interval | 1.2.0 | MIT | node_modules/postgres-interval |
| process-warning | 4.0.1 | MIT | node_modules/light-my-request/node_modules/process-warning |
| process-warning | 5.0.0 | MIT | node_modules/process-warning |
| quick-format-unescaped | 4.0.4 | MIT | node_modules/quick-format-unescaped |
| react | 19.2.7 | MIT | node_modules/react |
| react-dom | 19.2.7 | MIT | node_modules/react-dom |
| react-refresh | 0.17.0 | MIT | node_modules/react-refresh |
| react-router | 7.17.0 | MIT | node_modules/react-router |
| react-router-dom | 7.17.0 | MIT | node_modules/react-router-dom |
| readable-stream | 3.6.2 | MIT | node_modules/readable-stream |
| real-require | 0.2.0 | MIT | node_modules/real-require |
| real-require | 1.0.0 | MIT | node_modules/thread-stream/node_modules/real-require |
| redis-errors | 1.2.0 | MIT | node_modules/redis-errors |
| redis-parser | 3.0.0 | MIT | node_modules/redis-parser |
| require-directory | 2.1.1 | MIT | node_modules/require-directory |
| require-from-string | 2.0.2 | MIT | node_modules/require-from-string |
| ret | 0.5.0 | MIT | node_modules/ret |
| reusify | 1.1.0 | MIT | node_modules/reusify |
| rfdc | 1.4.1 | MIT | node_modules/rfdc |
| rollup | 4.60.4 | MIT | node_modules/rollup |
| rxjs | 7.8.2 | Apache-2.0 | node_modules/rxjs |
| safe-buffer | 5.2.1 | MIT | node_modules/safe-buffer |
| safe-regex2 | 5.1.1 | MIT | node_modules/safe-regex2 |
| safe-stable-stringify | 2.5.0 | MIT | node_modules/safe-stable-stringify |
| safer-buffer | 2.1.2 | MIT | node_modules/safer-buffer |
| scheduler | 0.27.0 | MIT | node_modules/scheduler |
| secure-json-parse | 4.1.0 | BSD-3-Clause | node_modules/secure-json-parse |
| semver | 6.3.1 | ISC | node_modules/semver |
| semver | 7.8.0 | ISC | node_modules/fastify/node_modules/semver |
| semver | 7.8.5 | ISC | packages/shared/node_modules/semver |
| set-cookie-parser | 2.7.2 | MIT | node_modules/set-cookie-parser |
| setprototypeof | 1.2.0 | ISC | node_modules/setprototypeof |
| shell-quote | 1.8.4 | MIT | node_modules/shell-quote |
| siginfo | 2.0.0 | ISC | node_modules/siginfo |
| sonic-boom | 4.2.1 | MIT | node_modules/sonic-boom |
| source-map-js | 1.2.1 | BSD-3-Clause | node_modules/source-map-js |
| split2 | 4.2.0 | ISC | node_modules/split2 |
| ssh2 | 1.17.0 | MIT | node_modules/ssh2 |
| stackback | 0.0.2 | MIT | node_modules/stackback |
| standard-as-callback | 2.1.0 | MIT | node_modules/standard-as-callback |
| statuses | 2.0.2 | MIT | node_modules/statuses |
| std-env | 4.1.0 | MIT | node_modules/std-env |
| stream-shift | 1.0.3 | MIT | node_modules/stream-shift |
| string_decoder | 1.3.0 | MIT | node_modules/string_decoder |
| string-width | 4.2.3 | MIT | node_modules/string-width |
| strip-ansi | 6.0.1 | MIT | node_modules/strip-ansi |
| supports-color | 7.2.0 | MIT | node_modules/chalk/node_modules/supports-color |
| supports-color | 8.1.1 | MIT | node_modules/supports-color |
| thread-stream | 4.2.0 | MIT | node_modules/thread-stream |
| tinybench | 2.9.0 | MIT | node_modules/tinybench |
| tinyexec | 1.2.3 | MIT | node_modules/tinyexec |
| tinyglobby | 0.2.16 | MIT | node_modules/tinyglobby |
| tinyrainbow | 3.1.0 | MIT | node_modules/tinyrainbow |
| toad-cache | 3.7.0 | MIT | node_modules/toad-cache |
| toidentifier | 1.0.1 | MIT | node_modules/toidentifier |
| tree-kill | 1.2.2 | MIT | node_modules/tree-kill |
| tslib | 2.8.1 | 0BSD | node_modules/tslib |
| tsx | 4.22.4 | MIT | node_modules/tsx |
| tweetnacl | 0.14.5 | Unlicense | node_modules/tweetnacl |
| typescript | 5.9.3 | Apache-2.0 | node_modules/typescript |
| undici-types | 5.26.5 | MIT | node_modules/@types/ssh2/node_modules/undici-types |
| undici-types | 6.21.0 | MIT | node_modules/undici-types |
| update-browserslist-db | 1.2.3 | MIT | node_modules/update-browserslist-db |
| util-deprecate | 1.0.2 | MIT | node_modules/util-deprecate |
| uuid | 11.1.1 | MIT | node_modules/uuid |
| vite | 6.4.3 | MIT | node_modules/vite |
| vitest | 4.1.8 | MIT | node_modules/vitest |
| why-is-node-running | 2.3.0 | MIT | node_modules/why-is-node-running |
| wrap-ansi | 7.0.0 | MIT | node_modules/wrap-ansi |
| wrappy | 1.0.2 | ISC | node_modules/wrappy |
| ws | 8.21.0 | MIT | node_modules/ws |
| xtend | 4.0.2 | MIT | node_modules/xtend |
| y18n | 5.0.8 | ISC | node_modules/y18n |
| yallist | 3.1.1 | ISC | node_modules/yallist |
| yaml | 2.9.0 | ISC | node_modules/yaml |
| yargs | 17.7.2 | MIT | node_modules/yargs |
| yargs-parser | 21.1.1 | ISC | node_modules/yargs-parser |
| zod | 3.25.76 | MIT | node_modules/zod |

## Notes

- Local ComposeBastion workspace packages are covered by LICENSE.md and are excluded from this third-party inventory.
- Dependency license metadata can change between package versions. Regenerate and review this file whenever dependencies change.
- This file is not legal advice and does not replace review of dependency license texts, package repositories, or distributed artifacts.
