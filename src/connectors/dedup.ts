// 事件去重：有界环形去重器。
// 进程内是事件级闸门，数据库侧再由 messages 表主键（msg_id 唯一 + INSERT OR IGNORE）
// 提供持久化幂等。官方在重连补发窗口内可能重复投递同一事件，去重键由 ingest 管线
// 按消息级语义构造。

export class BoundedDedup {
  private readonly seen = new Set<string>();
  private readonly ring: string[] = [];

  constructor(private readonly max = 4096) {}

  /**
   * 只检查不标记：首次出现返回 true，重复返回 false。
   * 调用方必须在后续处理（入库）成功后再调 mark。若在检查时立即标记，入库失败会
   * 使重拉的同批消息全部被过滤，而游标仍会推进，最终造成静默丢批。
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
