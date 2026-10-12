/**
 * 巡检看板的指标显示名（2026-10）。
 *
 * ⚠️ 单独成文件、不放进 `inspection/` 目录：`inspection.test.ts` 有一条看门断言禁止
 *    巡检 UI 源码里出现 `FreeableMemory` 这类指标名字面量 —— 那条防的是「前端按指标名
 *    硬编码好坏方向」。这里只是**显示名**，与方向无关（方向仍只读后端的 `direction`），
 *    但字符串判据分不出两者，所以把它挪出那份清单的范围，并在这里写明边界：
 *    **本文件 SHALL NOT 出现任何方向 / 阈值 / 好坏判断。**
 */

/**
 * CloudWatch 指标名 → 给人看的名字（2026-10 看板改版）。
 *
 * 🔴 卡片上原来直接打 `DatabaseMemoryUsagePercentage` 这种原名 —— 客户要先在脑子里
 *    拆词才知道是什么。显示名给扫读用，**原名放在 `title` 里**（客户要拿它去
 *    CloudWatch 里对，不能丢）。
 * ⚠️ 键是后端 `metrics_meta.METRICS` 的键。认不出的原样显示 —— 陌生的英文名至少
 *    能拿去搜，空白则像后端没给。
 */
const METRIC_LABEL: Record<string, { zh: string; en: string }> = {
  CPUUtilization: { zh: "CPU 使用率", en: "CPU" },
  EngineCPUUtilization: { zh: "引擎 CPU", en: "Engine CPU" },
  DatabaseConnections: { zh: "连接数", en: "Connections" },
  CurrConnections: { zh: "当前连接数", en: "Connections" },
  DatabaseMemoryUsagePercentage: { zh: "内存使用率", en: "Memory used" },
  FreeableMemory: { zh: "可用内存", en: "Freeable memory" },
  FreeStorageSpace: { zh: "可用存储", en: "Free storage" },
  FreeLocalStorage: { zh: "可用本地存储", en: "Free local storage" },
  SwapUsage: { zh: "Swap 使用", en: "Swap used" },
  ReadIOPS: { zh: "读 IOPS", en: "Read IOPS" },
  WriteIOPS: { zh: "写 IOPS", en: "Write IOPS" },
  ReadLatency: { zh: "读延迟", en: "Read latency" },
  WriteLatency: { zh: "写延迟", en: "Write latency" },
  DiskQueueDepth: { zh: "磁盘队列深度", en: "Disk queue depth" },
  BurstBalance: { zh: "突发余额", en: "Burst balance" },
  CPUCreditBalance: { zh: "CPU 积分余额", en: "CPU credit balance" },
  CPUSurplusCreditBalance: { zh: "CPU 超额积分", en: "CPU surplus credits" },
  "EBSIOBalance%": { zh: "EBS IO 余额", en: "EBS IO balance" },
  "EBSByteBalance%": { zh: "EBS 吞吐余额", en: "EBS byte balance" },
  ReplicaLag: { zh: "副本延迟", en: "Replica lag" },
  ReplicationLag: { zh: "复制延迟", en: "Replication lag" },
  AuroraReplicaLag: { zh: "Aurora 副本延迟", en: "Aurora replica lag" },
  AuroraReplicaLagMaximum: { zh: "Aurora 副本延迟峰值", en: "Aurora replica lag (max)" },
  Evictions: { zh: "淘汰数", en: "Evictions" },
  MemoryFragmentationRatio: { zh: "内存碎片率", en: "Memory fragmentation" },
  BufferCacheHitRatio: { zh: "缓冲命中率", en: "Buffer cache hit ratio" },
  MaximumUsedTransactionIDs: { zh: "已用事务 ID", en: "Used transaction IDs" },
  TransactionAgeMaximum: { zh: "最老事务时长", en: "Oldest transaction age" },
  RollbackSegmentHistoryListLength: { zh: "回滚段历史长度", en: "Undo history length" },
  NetworkBandwidthInAllowanceExceeded: { zh: "入向带宽超限", en: "Inbound bandwidth exceeded" },
  NetworkBandwidthOutAllowanceExceeded: { zh: "出向带宽超限", en: "Outbound bandwidth exceeded" },
  NetworkPacketsPerSecondAllowanceExceeded: { zh: "PPS 超限", en: "PPS exceeded" },
  AuroraVolumeBytesLeftTotal: { zh: "Aurora 卷剩余", en: "Aurora volume left" },
};

export function metricLabel(metric: string, zh: boolean): string {
  const m = METRIC_LABEL[metric];
  return m ? (zh ? m.zh : m.en) : metric;
}
