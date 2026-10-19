import { renderVideo } from "../server/video.ts";
import type { Revision } from "../server/types.ts";
import { resolve } from "node:path";
const r: Revision = {
  id: "verified-demo-video",
  number: 1,
  copy: "Meet Harbor Demo.\nA workflow you can review.\nExplore the details.",
  createdAt: new Date().toISOString(),
  mode: "demo-template",
  brand: {
    name: "HARBOR DEMO",
    url: "https://example.com",
    product: "Demo product illustration",
    parameters: "Synthetic demonstration only",
    audience: "Demo audience",
    market: "US",
    competitors: [],
    image: "",
    updatedAt: new Date().toISOString(),
  },
  evidence: [],
  scenes: [
    {
      start: 0,
      end: 10,
      text: "Meet Harbor Demo.",
      visual: "Product illustration and animated title",
    },
    {
      start: 10,
      end: 20,
      text: "A workflow you can review.",
      visual: "Product illustration slowly scales",
    },
    {
      start: 20,
      end: 30,
      text: "Explore the details.",
      visual: "Call to action fades in",
    },
  ],
};
console.log(await renderVideo(r, resolve("artifacts")));
