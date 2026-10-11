/**
 * `lambda6_cur_finalizer`（CUR 阶段二）执行角色的权限 —— **唯一真源**，两条部署路径共用。
 *
 * 为什么要有这个文件（2026-10-10，验证账号真部署后发现）
 * ----------------------------------------------------------
 * 这套权限原来写了**两份**：方式 B 在 `notiops-backend-stack.ts` 里有一份（现网跑通过），
 * 方式 A 加「NotiOps 替客户建 CUR」时，我在一键栈里**照着意思重写了一份**。两份很快漂移，
 * 而方式 A 那份错了六处：
 *
 *   · `CreateStack` / `DescribeStacks` 的资源写成 `stack/athenacurcfn-*`，而 finalizer 建的栈叫
 *     `notiops-cur-athena-<账号>` ⇒ 建栈必然 AccessDenied；
 *   · 缺 `DescribeStackResources`（找 crawler 名）、`DeleteStack`（清理失败栈）；
 *   · 缺 `glue:GetDatabases` / `GetTables` —— 而且是**静默**的：发现表那一步的异常被 `except`
 *     吞成一条 warning，表面上只是"还没发现表"；
 *   · 写成了 `athena:GetNamedQuery`，代码调用的是 `BatchGetNamedQuery`；
 *   · 缺 `lambda:PutFunctionConcurrency` —— 官方 `crawler-cfn.yml` 里两个 Lambda 都设了
 *     `ReservedConcurrentExecutions=1`，建栈会在这一步回滚；
 *   · 缺 `glue:TagResource` 等。
 *
 * 这六处一处都没被发现过，因为前面还有一个缺陷（finalizer 覆盖写状态记录、把 `prefix`
 * 弄丢）一直把流程挡在「找不到模板」那一步 —— 后面的步骤在真实部署里**从来没跑到过**。
 *
 * 这正是 `cur_provisioner/spec.py` 文件头警告的那类隐患：同一份东西写两份，漂移的表现
 * 不是报错，而是某一条路径上的功能静默不工作。所以权限也收敛到这里。
 *
 * 两种形态，由 `deliveryBucketName` 决定（这是**唯一**刻意的差异）
 * -----------------------------------------------------------------
 *   · 不传（方式 B）：CUR 交付桶可能是**客户自己已有的**那个（setup.sh 支持复用既有 CUR），
 *     桶名部署期不可知 ⇒ S3 只读与 `PutBucketNotification` 只能给 `*`。
 *     **这一形态的输出与重构前方式 B 那份逐字节相同**（判据钉住），不改动现网权限。
 *   · 传了（方式 A）：一键栈只在 `ProvisionCur=yes` 时部署 finalizer，桶是 NotiOps 自己建的、
 *     名字确定 ⇒ S3 读与通知都收窄到这**一个**桶。
 *
 * 资源命名前缀的依据：官方 `crawler-cfn.yml` 里 3 个 IAM 角色与 2 个 Lambda **都没有显式名**，
 * CFN 会命名成 `<栈名>-<逻辑 ID>-<随机串>`，即以 `notiops-cur-athena-` 开头（2026-10-10 用
 * 验证账号里 AWS 真实投递的模板核对过）。
 */
import * as iam from "aws-cdk-lib/aws-iam";

export interface CurFinalizerPolicyOptions {
  /** ARN 分区。方式 B 传字面量 `"aws"`（保持现网模板逐字节不变），方式 A 传 `Aws.PARTITION`。 */
  partition: string;
  /** 本账号。 */
  account: string;
  /**
   * CUR 交付桶名。**不传 = 任意桶**（方式 B：可能复用客户自己的 CUR，桶名部署期不可知）。
   * 传了就把 S3 读与桶通知都收窄到这一个桶（方式 A）。
   */
  deliveryBucketName?: string;
}

export function curFinalizerPolicyStatements(opts: CurFinalizerPolicyOptions): iam.PolicyStatement[] {
  const { partition, account, deliveryBucketName } = opts;
  const bucketArn = deliveryBucketName ? `arn:${partition}:s3:::${deliveryBucketName}` : undefined;

  const statements: iam.PolicyStatement[] = [
    // 只读 CUR 交付桶：读 crawler-cfn.yml 模板 + 发现数据路径。
    // 方式 B 复用既有 CUR 时桶名由客户自定义、部署期不可知，故只能给 *（仅 List/Get 只读）。
    new iam.PolicyStatement({
      actions: ["s3:ListBucket", "s3:GetObject"],
      resources: bucketArn ? [bucketArn, `${bucketArn}/*`] : ["*"],
    }),
    // 部署 AWS 官方生成的 Athena 集成 CFN 模板（内含 IAM Role / Glue / Lambda），
    // 名称范围限定为 finalizer 自己创建的栈（`notiops-cur-athena-<账号>`，见 handler.py）。
    new iam.PolicyStatement({
      actions: ["cloudformation:CreateStack", "cloudformation:DescribeStacks",
                "cloudformation:DescribeStackResources", "cloudformation:DeleteStack"],
      resources: [`arn:${partition}:cloudformation:*:*:stack/notiops-cur-athena-*/*`],
    }),
    // 那个 CFN 模板会建 3 个 IAM Role + Glue DB/Crawler + 2 个 Lambda + S3 通知；
    // create_stack 调用者本身需要具备这些创建权限（CFN 以调用者角色执行，不是 CFN 服务角色）。
    //
    // (1) IAM：收窄到本项目相关的 role 命名前缀，避免对任意 IAM Role 的写权限。
    new iam.PolicyStatement({
      actions: [
        "iam:CreateRole", "iam:PutRolePolicy", "iam:GetRole", "iam:PassRole",
        "iam:AttachRolePolicy", "iam:TagRole",
        "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
      ],
      resources: [
        `arn:${partition}:iam::${account}:role/notiops-cur-*`,
        `arn:${partition}:iam::${account}:role/AWSCUR*`,
        `arn:${partition}:iam::${account}:role/*Athena*`,
      ],
    }),
    // (2) Lambda：按函数名 ARN 前缀收窄（本账号）。
    //     ⚠️ `PutFunctionConcurrency` 不是可选项：官方模板里两个 Lambda 都设了
    //     `ReservedConcurrentExecutions=1`，少了它建栈会在这一步回滚。
    new iam.PolicyStatement({
      actions: [
        "lambda:CreateFunction", "lambda:GetFunction", "lambda:AddPermission",
        "lambda:InvokeFunction", "lambda:TagResource",
        "lambda:DeleteFunction", "lambda:RemovePermission",
        "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency",
      ],
      resources: [
        `arn:${partition}:lambda:*:${account}:function:notiops-cur-*`,
        `arn:${partition}:lambda:*:${account}:function:*Athena*`,
        `arn:${partition}:lambda:*:${account}:function:*aws-cur*`,
      ],
    }),
  ];

  // (3) Glue + S3 通知：⚠️ 官方 crawler-cfn.yml 内部动态生成 Glue Database/Crawler/Table 名
  //     （部署前不可预知），无法按 ARN 收窄；故 Glue 保留 resources:["*"]、收紧到 action 层面。
  //     这是 AWS 官方 Athena 集成模板本身要求的权限面
  //     （见 docs.aws.amazon.com/cur/latest/userguide/use-athena-cf.html）。
  const glueActions = [
    "glue:CreateDatabase", "glue:CreateCrawler", "glue:GetDatabase", "glue:GetCrawler",
    "glue:TagResource",
    "glue:GetDatabases", "glue:GetTables", "glue:GetTable", "glue:StartCrawler", "glue:StopCrawler",
    "glue:CreateTable", "glue:UpdateTable", "glue:DeleteTable",
    "glue:DeleteDatabase", "glue:DeleteCrawler",
  ];
  const notificationActions = ["s3:PutBucketNotification", "s3:GetBucketNotification"];
  if (bucketArn) {
    // 方式 A：桶名确定 ⇒ 桶通知单独一条、收窄到这一个桶。
    statements.push(new iam.PolicyStatement({ actions: glueActions, resources: ["*"] }));
    statements.push(new iam.PolicyStatement({ actions: notificationActions, resources: [bucketArn] }));
  } else {
    // 方式 B：与重构前那份**同一条语句**（Glue 与桶通知合在一起、都是 *）——保持现网模板不变。
    statements.push(new iam.PolicyStatement({
      actions: [...glueActions, ...notificationActions],
      resources: ["*"],
    }));
  }

  // CUR 翻 READY 的同一时刻，finalizer 幂等下发 6 条 FinOps 保存查询（Cost Deep Dive 后端，
  // 见 lambda6_cur_finalizer/athena_saved_queries.py）+ 给 primary workgroup 设结果输出位置。
  // 保存查询 / workgroup 属账号级资源（无法按细粒度 ARN 收窄），收紧到 action 层面。
  statements.push(new iam.PolicyStatement({
    actions: [
      "athena:ListNamedQueries", "athena:BatchGetNamedQuery", "athena:CreateNamedQuery",
      "athena:GetWorkGroup", "athena:UpdateWorkGroup",
    ],
    resources: ["*"],
  }));

  // 状态记录里没有 `prefix` 时，向 CUR 服务**查**真实前缀（权威来源，不是猜）。
  // 见 handler.py 的 `_resolve_prefix`：没有这一条，在缺陷修复之前写下的旧记录
  // （prefix 已被覆盖写抹掉）永远无法自愈。CUR 的 Describe API 不支持资源级限定，只能 *。
  statements.push(new iam.PolicyStatement({
    actions: ["cur:DescribeReportDefinitions"],
    resources: ["*"],
  }));

  return statements;
}
