// 事件去重：有界环形去重器。
// 这是第一道闸（进程内）；第二道闸是 M2 存储层主键（messages 表 msg_id 唯一 + INSERT OR IGNORE）。
// 官方在重连补发窗口内可能重复投递同一事件，去重键 = bot:type:事件id。
// （P1 收口：自 gateway/dedup.ts 上移 core ingest 管线——去重是语义幂等，不是网络。）

export class BoundedDedup {
  private readonly seen = new Set<string>();
  private readonly ring: string[] = [];

  constructor(private readonly max = 4096) {}

  /**
   * 只检查不标记：首次出现返回 true，重复返回 false。
   * 调用方须在后续处理（入库）成功后调 mark 完成标记——检查即标记的旧语义
   * 曾与入库失败组合出「重拉全滤→游标推进→静默丢批」失败链（T1 加固，2026-11-24）。
   */
  isNew(key: string): boolean {
    return !this.seen.has(key);
  }

  /** 标记已处理；有界淘汰最老键 */
  mark(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.ring.push(key);
    if (this.ring.length > this.max) {
      const oldest = this.ring.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
