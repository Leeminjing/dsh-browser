export type SiteDecision = "allow" | "block";
export interface SiteEntry {
    host: string;
    decision: SiteDecision;
    ts: number;
}
export interface HistoryEntry {
    id: string;
    url: string;
    title: string;
    ts: number;
}
export interface Annotation {
    id: string;
    url: string;
    host: string;
    x: number;
    y: number;
    w: number;
    h: number;
    comment: string;
    createdBy: "user" | "agent";
    ts: number;
}
export interface DevModeState {
    enabled: boolean;
    approvedHosts: string[];
}
export interface BrowserStoresOptions {
    /** DSH_HOME 路径（browser 数据子目录将建在其下） */
    dshHome: string;
}
/** 纯逻辑存储：JSON 文件 + 原子写入。 */
export declare class BrowserStores {
    readonly dir: string;
    private file;
    private data;
    constructor(opts: BrowserStoresOptions);
    private load;
    private save;
    getSiteDecision(host: string): SiteDecision | "unknown";
    setSiteDecision(host: string, decision: SiteDecision): void;
    clearSiteDecision(host: string): void;
    listSitePermissions(): SiteEntry[];
    recordHistory(url: string, title: string): void;
    searchHistory(query?: string): HistoryEntry[];
    deleteHistory(id: string): void;
    clearHistory(): void;
    addAnnotation(a: Omit<Annotation, "id" | "ts">): Annotation;
    listAnnotations(url?: string): Annotation[];
    deleteAnnotation(id: string): void;
    getDevMode(): DevModeState;
    setDevModeEnabled(enabled: boolean): void;
    approveCdpHost(host: string): void;
    revokeCdpHost(host: string): void;
    private uid;
}
export type RiskLevel = "none" | "sensitive" | "high";
export interface RiskInput {
    kind: "navigate" | "click" | "type" | "submit" | "download" | "open";
    url?: string;
    elementText?: string;
    element?: {
        tag: string;
        type?: string;
        href?: string;
        download?: boolean;
    };
    formMethod?: string;
}
export declare function assessRisk(a: RiskInput): {
    level: RiskLevel;
    description: string;
};
