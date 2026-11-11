import path from "node:path";
import { fileURLToPath } from "node:url";

type Environment = Record<string, string | undefined>;
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

/** 程序文件始终位于源码目录，便携版的配置和价格另存到可写用户目录。 */
export function resolveRuntimePaths(environment: Environment = process.env, projectRoot = sourceRoot) {
  const root = path.resolve(projectRoot);
  const customDataRoot = environment.XINLE_DATA_DIR?.trim();
  const dataRoot = customDataRoot ? path.resolve(root, customDataRoot) : root;
  return {
    projectRoot: root,
    dataRoot,
    outputDir: path.join(dataRoot, "output"),
  };
}

/** 便携版显式使用内置 Chromium；开发模式继续使用本机 Edge。 */
export function resolveBrowserLaunchOptions(environment: Environment = process.env, projectRoot = sourceRoot) {
  const executable = environment.XINLE_BROWSER_PATH?.trim();
  return executable
    ? { executablePath: path.resolve(projectRoot, executable) }
    : { channel: "msedge" as const };
}
