// dsh-browser 客户端插件（ModuleLoader 工厂）类型声明
// client.js 通过 window.__ModuleLoader__.load({ id, factory }) 注册；
// 该 d.ts 仅为 TS 消费者提供最小导出面。
export interface ClientCtx {
  slots: {
    inject(slot: string, fn: () => unknown): unknown;
  };
}
export declare function apply(ctx: ClientCtx): void;
export declare const inject: string[];
