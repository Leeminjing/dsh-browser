import { defineTool } from "@deepseek-ai/dsh-tools";
import type { BrowserManager } from "./manager.js";
import type { Gates } from "./gates.js";
export interface BrowserToolsDeps {
    manager: BrowserManager;
    gates: Gates;
    /** 共享视图服务基地址（用于绝对链接与截图 URL） */
    viewBase: string;
    /** 共享视图 URL 文本（供 open_view / navigate 使用） */
    viewUrlText: string;
}
export type ToolRegistrar = (tool: ReturnType<typeof defineTool>) => void;
/** 注册全部 browser_* 工具 */
export declare function applyBrowserTools(register: ToolRegistrar, deps: BrowserToolsDeps): void;
