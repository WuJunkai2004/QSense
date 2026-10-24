// 事件订阅 intent 掩码（数值依据官方 intents 文档，见 API-FACTS.md #6）。
// 传递无权限的 intents 会被网关拒绝并断开（op 9 / 4914/4915），新增 intent 前先核对权限。

/** 群聊 + 单聊全量事件（含 GROUP_MESSAGE_CREATE 全量模式、开关事件、进出群事件） */
export const INTENT_GROUP_AND_C2C_EVENT = 1 << 25;

/** 消息审核结果（主动消息进入人工审核 304023/304024 后的回执 MESSAGE_AUDIT_PASS/REJECT） */
export const INTENT_MESSAGE_AUDIT = 1 << 27;

/** 本项目订阅的 intents 集合 */
export const OUR_INTENTS = INTENT_GROUP_AND_C2C_EVENT | INTENT_MESSAGE_AUDIT;
