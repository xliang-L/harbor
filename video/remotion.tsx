import React from "react";
import {
  AbsoluteFill,
  Composition,
  Img,
  getInputProps,
  interpolate,
  registerRoot,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Revision } from "../server/types";
type Props = { revision: Revision };
export function Film({ revision: r }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const seconds = frame / fps;
  const index = Math.min(2, Math.floor(seconds / 10));
  const local = seconds - index * 10;
  const opacity = interpolate(local, [0, 0.8, 9.6, 10], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(local, [0, 10], [0.92, 1.08]);
  const y = interpolate(local, [0, 0.8], [16, 0], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: "radial-gradient(ellipse at 85% 40%,#2e7560,#112e28 70%)",
        color: "#f7faf5",
        fontFamily: "Arial,sans-serif",
      }}
    >
      <AbsoluteFill
        style={{
          padding: 32,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 25,
          opacity,
          transform: `translateY(${y}px)`,
        }}
      >
        <div style={{ width: "58%" }}>
          <p style={{ fontSize: 12, letterSpacing: 3, color: "#b5d4b1" }}>
            {r.brand.name.toUpperCase()}
          </p>
          <h1 style={{ fontSize: 32, lineHeight: 1.15, overflowWrap: "anywhere" }}>
            {r.scenes[index].text}
          </h1>
          <p>{index === 2 ? "Explore the details →" : r.brand.product}</p>
        </div>
        {r.brand.image ? (
          <Img
            src={r.brand.image}
            style={{
              width: 180,
              height: 220,
              objectFit: "contain",
              borderRadius: 22,
              transform: `scale(${scale})`,
            }}
          />
        ) : (
          <div
            style={{
              width: 155,
              height: 200,
              borderRadius: 38,
              background: "linear-gradient(130deg,#d9e6b0,#649679)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#264534",
              transform: `scale(${scale})`,
            }}
          >
            DEMO
            <br />
            PRODUCT
          </div>
        )}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          bottom: 15,
          left: 32,
          fontSize: 9,
          color: "#c8d6c2",
          maxWidth: 570,
          overflowWrap: "anywhere",
        }}
      >
        {r.mode === "demo-template" ? "TEMPLATE DEMO" : "MODEL DRAFT"} · REVIEW BEFORE PUBLISHING ·{" "}
        {r.brand.image ? "USER IMAGE" : "ILLUSTRATION — NOT PRODUCT PHOTO"} · {r.brand.url}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          height: 4,
          background: "#daec9f",
          width: `${(frame / (durationInFrames - 1)) * 100}%`,
        }}
      />
    </AbsoluteFill>
  );
}
const Root = () => {
  const props = getInputProps<Props>();
  return (
    <Composition
      id="Harbor"
      component={Film}
      width={640}
      height={360}
      fps={24}
      durationInFrames={720}
      defaultProps={props}
    />
  );
};
registerRoot(Root);
