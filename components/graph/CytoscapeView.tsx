"use client";

import { useEffect, useRef, useCallback } from "react";
import type cytoscape from "cytoscape";

const DOMAIN_COLORS: Record<string, string> = {
  cybersec: "#ef4444",
  finance: "#22c55e",
  law: "#3b82f6",
  cs: "#a855f7",
  math: "#eab308",
  general: "#6b7280",
};

const EDGE_STYLES: Record<string, { lineStyle: string; lineColor: string }> = {
  prerequisite: { lineStyle: "solid", lineColor: "#f97316" },
  related: { lineStyle: "solid", lineColor: "#94a3b8" },
  contradicts: { lineStyle: "dashed", lineColor: "#ef4444" },
  extends: { lineStyle: "solid", lineColor: "#8b5cf6" },
  applies_to: { lineStyle: "dotted", lineColor: "#10b981" },
};

interface Node {
  id: number;
  name: string;
  aliases: string;
  domain: string;
  bookCount: number;
}

interface Edge {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  relationType: string;
  weight: number;
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  highlightId?: number | null;
  onNodeClick?: (nodeId: number) => void;
  lang?: "en" | "ja";
}

export default function CytoscapeView({ nodes, edges, highlightId, onNodeClick, lang = "ja" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);

  const buildElements = useCallback(() => {
    return [
      ...nodes.map((n) => {
        const aliases: string[] = JSON.parse(n.aliases || "[]");
        const jaName = aliases[0];
        const label = lang === "ja" && jaName ? jaName : n.name;
        return {
          data: {
            id: String(n.id),
            label,
            domain: n.domain,
            bookCount: n.bookCount ?? 1,
          },
        };
      }),
      ...edges.map((e) => ({
        data: {
          id: `e${e.id}`,
          source: String(e.fromConceptId),
          target: String(e.toConceptId),
          relationType: e.relationType,
          weight: e.weight,
        },
      })),
    ];
  }, [nodes, edges, lang]);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    let cy: cytoscape.Core;

    const init = async () => {
      const cytoscape = (await import("cytoscape")).default;
      // @ts-expect-error no types for layout registration
      const fcose = (await import("cytoscape-fcose")).default;
      if (!cytoscape.prototype.hasOwnProperty("fcose")) {
        cytoscape.use(fcose);
      }

      if (cyRef.current) {
        cyRef.current.destroy();
      }

      cy = cytoscape({
        container: containerRef.current,
        elements: buildElements(),
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "background-color": (ele: cytoscape.NodeSingular) =>
                DOMAIN_COLORS[ele.data("domain")] ?? DOMAIN_COLORS.general,
              width: (ele: cytoscape.NodeSingular) => 20 + (ele.data("bookCount") ?? 1) * 8,
              height: (ele: cytoscape.NodeSingular) => 20 + (ele.data("bookCount") ?? 1) * 8,
              "font-size": "10px",
              "text-valign": "bottom",
              "text-halign": "center",
              "text-margin-y": 4,
              color: "#374151",
              "text-outline-width": 2,
              "text-outline-color": "#ffffff",
            },
          },
          {
            selector: "edge",
            style: {
              width: (ele: cytoscape.EdgeSingular) => 1 + (ele.data("weight") ?? 1) * 0.5,
              "line-color": (ele: cytoscape.EdgeSingular) =>
                EDGE_STYLES[ele.data("relationType")]?.lineColor ?? "#94a3b8",
              "line-style": (ele: cytoscape.EdgeSingular) =>
                (EDGE_STYLES[ele.data("relationType")]?.lineStyle ?? "solid") as "solid" | "dashed" | "dotted",
              "target-arrow-shape": "triangle",
              "target-arrow-color": (ele: cytoscape.EdgeSingular) =>
                EDGE_STYLES[ele.data("relationType")]?.lineColor ?? "#94a3b8",
              "curve-style": "bezier",
              opacity: 0.7,
            },
          },
          {
            selector: "node.highlighted",
            style: {
              "border-width": 3,
              "border-color": "#1d4ed8",
              "border-style": "solid",
            },
          },
          {
            selector: "node:selected",
            style: {
              "border-width": 3,
              "border-color": "#f59e0b",
              "border-style": "solid",
            },
          },
        ],
        layout: {
          name: "fcose",
          quality: "proof",
          animate: true,
          animationDuration: 1000,
          randomize: true,
          nodeSeparation: 120,
          idealEdgeLength: 150,
          nodeRepulsion: 8000,
          numIter: 2500,
        } as cytoscape.LayoutOptions,
        wheelSensitivity: 0.3,
      });

      cy.on("tap", "node", (e) => {
        const nodeId = Number(e.target.id());
        onNodeClickRef.current?.(nodeId);
      });

      cyRef.current = cy;
    };

    init();

    return () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, lang]);

  // Highlight node without re-building the graph
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("highlighted");
    if (highlightId != null) {
      cy.getElementById(String(highlightId)).addClass("highlighted");
      cy.animate({ fit: { eles: cy.getElementById(String(highlightId)), padding: 80 } } as Parameters<typeof cy.animate>[0], { duration: 400 });
    }
  }, [highlightId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
