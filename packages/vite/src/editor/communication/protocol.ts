import type { Definition } from "@liva/runtime";

export type Edit =
  | { op: "set"; path: string; value: string }
  | { op: "removeFrame"; path: string }
  | { op: "addFrame"; path: string; offset: number; value: string; easing?: string }
  | {
      op: "override";
      definition: string;
      from: string;
      to: string;
      target: string;
      property: string;
      timing: string;
    };

export interface EditorRequest {
  action: "inspect" | "preview" | "commit";
  sourceId: string;
  definition: string;
  instanceId?: string;
  baseHash?: string;
  sequence?: number;
  edits?: Edit[];
  requestId?: string;
}

export interface Inspection {
  hash: string;
  definition: Definition;
  fields: { path: string; kind: "value" | "block"; value: string }[];
}

export interface EditorReply extends Inspection {
  sequence?: number;
}
