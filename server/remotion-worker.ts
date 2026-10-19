import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("缺少本地渲染输入/输出文件");
const browserExecutable =
  process.env.REMOTION_BROWSER_PATH ||
  process.env.HYPERFRAMES_BROWSER_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(browserExecutable))
  throw new Error("请配置 REMOTION_BROWSER_PATH 为已安装 Chrome 的绝对路径");
const inputProps = { revision: JSON.parse(await readFile(input, "utf8")) };
const serveUrl = await bundle({
  entryPoint: resolve("video/remotion.tsx"),
  outDir: resolve(output, "../remotion-bundle"),
  enableCaching: false,
});
const composition = await selectComposition({
  serveUrl,
  id: "Harbor",
  inputProps,
  browserExecutable,
});
await renderMedia({
  composition,
  serveUrl,
  inputProps,
  outputLocation: output,
  codec: "h264",
  pixelFormat: "yuv420p",
  browserExecutable,
  concurrency: 1,
  logLevel: "warn",
});
// This one-shot worker owns no pending work after renderMedia resolves.
// Exit after flushing the result so bundler handles cannot hold the task open.
process.stdout.write("Remotion local render completed: 720 frames / 30 seconds\n", () =>
  process.exit(0),
);
