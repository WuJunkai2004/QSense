// 事件路由：RawEvent → Repo 状态变更（M2 处理入口，index.ts 的 onEvent 调这里）。
// 群注册表证据规则：
// - GROUP_MESSAGE_CREATE（全量消息到达）→ 群必然开着全量开关 → ensureGroup(1)
// - GROUP_AT_MESSAGE_CREATE（仅@消息）→ 群在册但开关未知 → ensureGroup 不改开关
// - GROUP_ADD_ROBOT → 新增（开关未确认=0）；GROUP_MSG_RECEIVE/REJECT → 1/0；GROUP_DEL_ROBOT → 移出

import type { RawEvent } from '../gateway';
import type { Repo } from '../store/repo';
import { normalizeMessage } from './index';

function fieldOf(data: unknown, key: string): string {
  if (data === null || typeof data !== 'object') return '';
  const v = (data as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

export function handleGatewayEvent(repo: Repo, event: RawEvent): void {
  switch (event.type) {
    case 'GROUP_MESSAGE_CREATE':
    case 'GROUP_AT_MESSAGE_CREATE': {
      const m = normalizeMessage(event);
      if (m === null) return;
      repo.saveGroupMessage(m);
      repo.ensureGroup(event.botId, m.scopeId, event.type === 'GROUP_MESSAGE_CREATE' ? 1 : null);
      return;
    }
    case 'C2C_MESSAGE_CREATE': {
      const m = normalizeMessage(event);
      if (m !== null) repo.saveC2cMessage(m);
      return;
    }
    case 'GROUP_ADD_ROBOT': {
      const g = fieldOf(event.data, 'group_openid');
      if (g !== '') repo.addGroup(event.botId, g);
      return;
    }
    case 'GROUP_DEL_ROBOT': {
      const g = fieldOf(event.data, 'group_openid');
      if (g !== '') repo.removeGroup(event.botId, g);
      return;
    }
    case 'GROUP_MSG_RECEIVE': {
      const g = fieldOf(event.data, 'group_openid');
      if (g !== '') repo.setGroupSwitch(event.botId, g, true);
      return;
    }
    case 'GROUP_MSG_REJECT': {
      const g = fieldOf(event.data, 'group_openid');
      if (g !== '') repo.setGroupSwitch(event.botId, g, false);
      return;
    }
    case 'C2C_MSG_RECEIVE': {
      const u = fieldOf(event.data, 'user_openid');
      if (u !== '') repo.setC2cSwitch(event.botId, u, true);
      return;
    }
    case 'C2C_MSG_REJECT': {
      const u = fieldOf(event.data, 'user_openid');
      if (u !== '') repo.setC2cSwitch(event.botId, u, false);
      return;
    }
    default:
      // MESSAGE_AUDIT / INTERACTION 等在 M4 按需接入
      return;
  }
}
