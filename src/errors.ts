// 包内错误类型。分仓纪律：连接器对 SDK 只允许类型导入——拿不到 ConnectorError 的
// 运行时类（各自打包后 instanceof 跨包不成立）。宿主 ui.ts 的 mapError 按鸭子类型识别
// Error 上的合法 status 字段并透传文案（平台中立，任何连接器都可自带可操作错误）。

/** 带 HTTP 状态语义的可操作错误（插件 WebUI 路由抛出；发送路径直接取 message） */
export class WeixinError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WeixinError";
    this.status = status;
  }
}
