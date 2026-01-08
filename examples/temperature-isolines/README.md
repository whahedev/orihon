# Temperature isolines demo

Interactive synthetic European air-temperature example for `heatLayer`, using one million packed field observations.

- Switch between heatmap, isolines, and the shared `both` field.
- Toggle station markers and contour labels independently.
- Render all one million observations with `webglPointLayer`; its spatial pick index makes every point clickable without one million DOM nodes.
- Click any GPU point to inspect its synthetic temperature, coordinates, source index, and regional station group.
- The deterministic station network covers seven European regions and includes several local heat anomalies.

Run the repository demo server and open `/examples/temperature-isolines/`.
