import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

copyFileSync(
  "packages/create-orihon-app/templates/vanilla/src/main.js",
  "packages/create-orihon-app/templates/vanilla-ts/src/main.ts",
);

const vanilla = readFileSync("packages/create-orihon-app/templates/vanilla/src/main.js", "utf8");
const afterImports = vanilla.replace(
  /^import[\s\S]*?from "orihon";\r?\nimport "orihon\/orihon\.css";\r?\nimport "\.\/style\.css";\r?\n\r?\n/,
  "",
);
const fullBody = afterImports; // includes center + map + demos
const reactBody = afterImports.replace(
  /^\/\/ Map centre[^\n]*\r?\nconst center = \{ lat: __ORIHON_CENTER_LAT__, lng: __ORIHON_CENTER_LNG__ \};\r?\n\r?\n/,
  "",
);

const indent = (text, spaces) =>
  text
    .split("\n")
    .map((line) => (line.length ? " ".repeat(spaces) + line : line))
    .join("\n");

const reactJsx = `import { useEffect, useRef } from "react";
import { createMap } from "orihon/easy";
import {
  circle,
  circleMarker,
  rectangle,
  textLayer,
  imageOverlay,
  videoOverlay,
  featureGroup,
  marker
} from "orihon";

// Map centre — change these, or pass --center when you scaffold.
const center = { lat: __ORIHON_CENTER_LAT__, lng: __ORIHON_CENTER_LNG__ };

export default function App() {
  const host = useRef(null);

  useEffect(() => {
    if (!host.current) return;

${indent(reactBody.replace('createMap("map"', "createMap(host.current"), 4)}

    return () => map.destroy();
  }, []);

  return <div ref={host} className="orihon-map" />;
}
`;

writeFileSync("packages/create-orihon-app/templates/react/src/App.jsx", reactJsx);
writeFileSync(
  "packages/create-orihon-app/templates/react-ts/src/App.tsx",
  reactJsx.replace("useRef(null)", "useRef<HTMLDivElement | null>(null)"),
);

const cdn = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orihon map</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/orihon@__ORIHON_CDN_VERSION__/dist/orihon.css"
    />
    <style>
      html, body { margin: 0; height: 100%; }
      #map { height: 100vh; min-height: 360px; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script type="module">
      import { createMap } from "https://cdn.jsdelivr.net/npm/orihon@__ORIHON_CDN_VERSION__/dist/easy-entry.js";
      import {
        circle,
        circleMarker,
        rectangle,
        textLayer,
        imageOverlay,
        videoOverlay,
        featureGroup,
        marker
      } from "https://cdn.jsdelivr.net/npm/orihon@__ORIHON_CDN_VERSION__/dist/index.js";

${indent(fullBody, 6)}
    </script>
  </body>
</html>
`;
writeFileSync("packages/create-orihon-app/templates/cdn/index.html", cdn);
console.log("synced");
