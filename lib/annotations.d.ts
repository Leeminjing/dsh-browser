import type { Annotation } from "./stores.js";
export declare const ANN_PREFIX = "[cb-ann]";
export declare function parseAnnotationPayload(message: string, urlOfPage: string): Omit<Annotation, "id" | "ts"> | null;
export declare function buildOverlayScript(annotations: Annotation[]): string;
export declare function buildOverlayExitScript(): string;
