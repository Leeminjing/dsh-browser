import type { Context } from "@deepseek-ai/cordis";
import "@deepseek-ai/dsh-user-questions";
/** Cordis 插件元数据 */
export declare const name = "browser";
export declare const inject: readonly ["tools", "userQuestions"];
/**
 * 插件主体。启动时只绑定视图端口（轻量）；内置浏览器（Playwright）在
 * 第一次被工具/视图使用时才启动。
 */
export declare function apply(ctx: Context): void;
