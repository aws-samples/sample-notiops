// jest globalSetup：给这一次 jest 运行开一个私有临时目录，并把 TMPDIR 指过去。
//
// 为什么（2026-10-23，CDD 上 ci_local 整批 ENOSPC）：每个 `new cdk.App()` 不写 outdir 时，CDK 都在
// os.tmpdir() 下 mkdtemp 一个 `cdk.outXXXXXX` 放合成结果 —— **没有任何人删它**。WebChatStack 那份带着
// BFF 的 node_modules（约 1.9 万个文件），一次 `npm test` 留下五六个；同一台机器上一天跑几十次 ci_local，
// /tmp（tmpfs，100 万个 inode）的 inode 先用光，所有用 /tmp 的 job 一起 `No space left on device`。
// 磁盘空间其实还剩很多，df -h 看不出来，df -i 才是 100%。
//
// 做法：workers 在 globalSetup 之后才起，会继承这里改过的 process.env，于是 os.tmpdir() 落进私有目录；
// globalTeardown（同一进程）整个删掉。测试代码不用改。
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notiops-infra-jest-"));
  process.env.NOTIOPS_INFRA_JEST_TMP = dir;
  process.env.TMPDIR = dir;
};
