// jest globalTeardown：删掉 global-setup.js 开的那个私有临时目录（里面是这次运行所有 CDK 合成留下的 cdk.out*）。
// 只删自己开的那一个：名字前缀对得上才动，别的会话 / 别的 clone 的临时目录不碰。
const fs = require("fs");
const path = require("path");

module.exports = async () => {
  const dir = process.env.NOTIOPS_INFRA_JEST_TMP;
  if (dir && path.basename(dir).startsWith("notiops-infra-jest-")) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
