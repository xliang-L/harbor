import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Revision } from "../types.ts";
const exec = promisify(execFile);
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export function previewHtml(r: Revision, render = false) {
  const gsap = render
    ? '<script src="gsap.min.js"></script>'
    : `<script>${readFileSync(resolve("node_modules/gsap/dist/gsap.min.js"), "utf8")}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#102925;color:#f7faf5;font-family:Arial,sans-serif}#film{position:relative;width:640px;height:360px;overflow:hidden;background:radial-gradient(ellipse at 85% 40%,#2e7560,#112e28 70%)}.scene{position:absolute;inset:0;padding:32px;display:flex;align-items:center;gap:25px}.words{width:58%}h1{font-size:32px;line-height:1.15;overflow-wrap:anywhere}.brand{font-size:12px;letter-spacing:3px;color:#b5d4b1}.product{width:180px;height:220px;object-fit:contain;border-radius:22px}.placeholder{width:155px;height:200px;border-radius:38px;background:linear-gradient(130deg,#d9e6b0,#649679);box-shadow:10px 20px 40px #0006;display:flex;align-items:center;justify-content:center;color:#264534;font-size:16px}.caption{position:absolute;bottom:15px;left:32px;font-size:9px;color:#c8d6c2;max-width:570px;overflow-wrap:anywhere}.line{position:absolute;bottom:0;left:0;height:4px;background:#daec9f;width:100%;transform-origin:left}#controls{position:fixed;top:0;right:0;padding:5px;z-index:9}button{cursor:pointer}</style></head><body>${render ? "" : '<div id="controls"><button onclick="window.__timelines.harbor.restart()">重播 30 秒</button></div>'}<main id="film" data-composition-id="harbor" data-width="640" data-height="360" data-duration="30" data-fps="24">${r.scenes.map((s, i) => `<section class="scene" id="s${i}" data-start="${s.start}" data-duration="10" data-track-index="${i}"><div class="words"><p class="brand">${esc(r.brand.name.toUpperCase())}</p><h1>${esc(s.text)}</h1><p>${esc(i === 2 ? "Explore the details →" : r.brand.product)}</p></div>${r.brand.image ? `<img class="product" src="${r.brand.image}"/>` : '<div class="product placeholder">DEMO<br>PRODUCT</div>'}</section>`).join("")}<div class="caption">${esc(r.mode === "demo-template" ? "TEMPLATE DEMO • HUMAN REVIEW REQUIRED" : "MODEL DRAFT • HUMAN REVIEW REQUIRED")} · ${r.brand.image ? "USER PRODUCT IMAGE" : "ILLUSTRATION — NOT A PRODUCT PHOTO"} · ${esc(r.brand.url)}</div><div class="line"></div></main>${gsap}<script>const tl=gsap.timeline({paused:true});${r.scenes.map((_, i) => `tl.set('#s${i}',{opacity:0},0);tl.fromTo('#s${i}',{opacity:0,y:16},{opacity:1,y:0,duration:0.8},${i * 10});tl.fromTo('#s${i} .product',{scale:0.92},{scale:1.08,duration:10,ease:'none'},${i * 10});tl.to('#s${i}',{opacity:0,duration:0.4},${(i + 1) * 10 - 0.4});`).join("")}tl.fromTo('.line',{scaleX:0},{scaleX:1,duration:30,ease:'none'},0);window.__timelines={harbor:tl};${render ? "" : "tl.play();"}</script></body></html>`;
}
export async function renderVideo(r: Revision, outputDir: string) {
  const ffmpeg =
    process.env.HYPERFRAMES_FFMPEG_PATH ||
    resolve("node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg");
  const ffprobe =
    process.env.HYPERFRAMES_FFPROBE_PATH ||
    resolve("node_modules/@ffprobe-installer/darwin-arm64/ffprobe");
  if (!existsSync(ffmpeg) || !existsSync(ffprobe))
    throw new Error("缺少 FFmpeg/ffprobe。浏览器分镜预览可用，但 MP4 未完成；配置渲染路径后重试。");
  const dir = resolve(outputDir, r.id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "index.html"), previewHtml(r, true));
  await copyFile(resolve("node_modules/gsap/dist/gsap.min.js"), resolve(dir, "gsap.min.js"));
  const file = resolve(dir, "video.mp4");
  try {
    const renderer = r.renderer || "hyperframes";
    if (renderer === "remotion") await writeFile(resolve(dir, "input.json"), JSON.stringify(r));
    const result = await exec(
      process.execPath,
      renderer === "remotion"
        ? [
            "--import",
            "tsx",
            resolve("server/rendering/remotion-worker.ts"),
            resolve(dir, "input.json"),
            file,
          ]
        : [
            resolve("node_modules/hyperframes/bin/hyperframes.mjs"),
            "render",
            dir,
            "--output",
            file,
            "--fps",
            "24",
            "--quality",
            "draft",
            "--workers",
            "1",
            "--experimental-fast-capture=false",
          ],
      {
        timeout: 240000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          HYPERFRAMES_BROWSER_PATH:
            process.env.HYPERFRAMES_BROWSER_PATH ||
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          HYPERFRAMES_FFMPEG_PATH: ffmpeg,
          HYPERFRAMES_FFPROBE_PATH: ffprobe,
          HYPERFRAMES_NO_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
        },
      },
    );
    await writeFile(resolve(dir, "render.log"), result.stdout + "\n" + result.stderr);
    const info = await exec(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,width,height",
      "-of",
      "json",
      file,
    ]);
    await writeFile(resolve(dir, "probe.json"), info.stdout);
    const probe = JSON.parse(info.stdout);
    if (
      !Number.isFinite(Number(probe.format?.duration)) ||
      Math.abs(Number(probe.format?.duration) - 30) > 0.1 ||
      !probe.streams?.some(
        (s: { codec_name: string; width: number; height: number }) =>
          s.codec_name === "h264" && s.width === 640 && s.height === 360,
      ) ||
      (await stat(file)).size < 1000
    )
      throw new Error("视频产物验证失败");
    return file;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    await writeFile(
      resolve(dir, "render.log"),
      (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + err.message,
    );
    throw new Error(
      `${r.renderer === "remotion" ? "Remotion" : "HyperFrames"} 渲染失败或超时，MP4 未完成。请检查 artifacts 对应版本 render.log 后重试。`,
    );
  }
}
