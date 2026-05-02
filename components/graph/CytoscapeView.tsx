"use client";

import { useEffect, useRef, useCallback } from "react";
import type cytoscape from "cytoscape";
import { relationColor, relationLineStyle } from "@/lib/relations";
import { domainColor } from "@/lib/domains";

interface Node {
  id: number;
  name: string;
  aliases: string;
  domain: string;
  bookCount: number;
  bookIds: number[];
}

interface Edge {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  relationType: string;
  weight: number;
  bookId: number | null;
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  highlightId?: number | null;
  onNodeClick?: (nodeId: number) => void;
  onSelectionChange?: (nodeIds: number[]) => void;
  lang?: "en" | "ja";
  selectedBookIds?: number[];
}

export default function CytoscapeView({
  nodes,
  edges,
  highlightId,
  onNodeClick,
  onSelectionChange,
  lang = "ja",
  selectedBookIds = [],
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);

  const buildElements = useCallback(() => {
    return [
      ...nodes.map((n) => {
        let aliases: string[] = [];
        try {
          aliases = JSON.parse(n.aliases || "[]");
        } catch {
          aliases = [];
        }
        const jaName = aliases[0];
        const label = lang === "ja" && jaName ? jaName : n.name;
        return {
          data: {
            id: String(n.id),
            label,
            domain: n.domain,
            bookCount: n.bookCount ?? 1,
            bookIds: n.bookIds ?? [],
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
          scope: e.bookId == null ? "cross_book" : "book",
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
              "background-color": (ele: cytoscape.NodeSingular) => domainColor(ele.data("domain")),
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
              "line-color": (ele: cytoscape.EdgeSingular) => relationColor(ele.data("relationType")),
              "line-style": (ele: cytoscape.EdgeSingular) => relationLineStyle(ele.data("relationType")),
              "target-arrow-shape": "triangle",
              "target-arrow-color": (ele: cytoscape.EdgeSingular) => relationColor(ele.data("relationType")),
              "curve-style": "bezier",
              opacity: 0.7,
            },
          },
          {
            selector: 'edge[scope = "cross_book"]',
            style: {
              label: "横断",
              width: (ele: cytoscape.EdgeSingular) => 2.5 + (ele.data("weight") ?? 1) * 0.7,
              "line-style": "dotted",
              "text-rotation": "autorotate",
              "font-size": "8px",
              color: "#0f172a",
              "text-background-color": "#ffffff",
              "text-background-opacity": 0.85,
              "text-background-padding": "2px",
              "text-margin-y": -4,
              opacity: 0.9,
            },
          },
          {
            selector: "node.book-dim",
            style: {
              opacity: 0.18,
              "text-opacity": 0.18,
            },
          },
          {
            selector: "edge.book-dim",
            style: {
              opacity: 0.08,
            },
          },
          {
            selector: "node.book-match",
            style: {
              "border-width": (ele: cytoscape.NodeSingular) => 3 + Math.min(ele.data("selectedBookCount") ?? 1, 3),
              "border-color": "#0f766e",
              "border-style": "double",
              opacity: 1,
              "text-opacity": 1,
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
        boxSelectionEnabled: true,
        selectionType: "additive",
      });

      const selectNode = (e: cytoscape.EventObject) => {
        const nodeId = Number(e.target.id());
        onNodeClickRef.current?.(nodeId);
      };

      const syncSelection = () => {
        const selectedIds = cy.nodes(":selected").map((node) => Number(node.id()));
        onSelectionChangeRef.current?.(selectedIds);
      };

      cy.on("tap", "node", selectNode);
      cy.on("select unselect", "node", syncSelection);
      cy.on("tap", (e) => {
        if (e.target !== cy) return;
        cy.nodes().unselect();
        onSelectionChangeRef.current?.([]);
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
    }
  }, [highlightId]);

  // Highlight concepts that appear in one or more selected books.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().removeClass("book-match book-dim");
    cy.nodes().removeData("selectedBookCount");

    const selectedBooks = new Set(selectedBookIds);
    if (selectedBooks.size === 0) return;

    cy.nodes().forEach((node) => {
      const bookIds = (node.data("bookIds") ?? []) as number[];
      const selectedBookCount = bookIds.filter((bookId) => selectedBooks.has(bookId)).length;
      if (selectedBookCount > 0) {
        node.data("selectedBookCount", selectedBookCount);
        node.addClass("book-match");
      } else {
        node.addClass("book-dim");
      }
    });

    cy.edges().forEach((edge) => {
      if (!edge.source().hasClass("book-match") || !edge.target().hasClass("book-match")) {
        edge.addClass("book-dim");
      }
    });
  }, [selectedBookIds]);

  return <div ref={containerRef} className="w-full h-full" />;
}
