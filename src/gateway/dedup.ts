// 事件去重：有界环形去重器。
// 这是第一道闸（进程内）；第二道闸是 M2 存储层主键（messages 表 msg_id 唯一 + INSERT OR IGNORE）。
// 官方在重连补发窗口内可能重复投递同一事件，去重键 = bot:type:事件id。

export class BoundedDedup {
  private readonly seen = new Set<string>();
  private readonly ring: string[] = [];

  constructor(private readonly max = 4096) {}

  /** 返回 true 表示首次出现；false 表示重复（调用方应丢弃） */
  isNew(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.ring.push(key);
    if (this.ring.length > this.max) {
      const oldest = this.ring.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
